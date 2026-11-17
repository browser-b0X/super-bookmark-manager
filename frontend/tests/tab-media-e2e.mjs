// An Instagram post's pictures and video handed over from the owner's tab (v0.4.0 phase 4, mockup
// Claude outputs/v040-review/phase4/mockup-1): the Save window asks the extension's helper for the files,
// shows what comes, uploads them to the app on this computer and asks for the copy naming them; the video is
// saved beside the copy and the app fetches nothing from Instagram. The helper is played by a script in the
// window itself. Synthetic data; nothing leaves the machine.
// Run from frontend/ after npm run build: node tests/tab-media-e2e.mjs (C4_PYTHON, C4_PLAYWRIGHT_MODULE)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(join(root, '.verify'), { recursive: true });
const evidence = await mkdtemp(join(root, '.verify', 'tab-media-'));
const port = 15000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const archiveDir = join(evidence, 'archive');

const server = spawn(process.env.C4_PYTHON || 'python3', ['-B', '-c', `
import os, sys
sys.path.insert(0, ${JSON.stringify(root)})
sys.path.insert(0, ${JSON.stringify(join(root, 'frontend', 'tests'))})
os.environ["SAVED_POSTS_DB_PATH"] = ${JSON.stringify(join(evidence, 'fixture.sqlite'))}
os.environ["SUPER_BOOKMARK_MANAGER_DATA_DIR"] = ${JSON.stringify(join(evidence, 'data'))}
os.environ["SBM_AI_CONFIG_FILE"] = ${JSON.stringify(join(evidence, 'ai.json'))}
os.environ["SBM_ARCHIVE_DIR"] = ${JSON.stringify(archiveDir)}
os.environ["SBM_THUMB_CACHE_DIR"] = ${JSON.stringify(join(evidence, 'thumbs'))}
from metadata_fixture import ControlledHTTP
import storage, app, archive, metadata_fetcher
metadata_fetcher.fetch_metadata = lambda url: {"title": "", "summary": "", "thumbnail": "", "status": "empty", "error": ""}
archive.HOST_SPACING = 0.0
site = ControlledHTTP().__enter__()          # nothing may leave the machine
seen = []
def picture(url, deadline):                  # the fallback fetch, counted (it should not happen here)
    seen.append(url)
    return "", "unavailable"
archive._picture = picture
storage.init_db()
from flask import jsonify
@app.app.route("/__seen")
def report():
    return jsonify(seen=seen)
app.app.run(host="127.0.0.1", port=${port}, debug=False, threaded=True)
`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
let serverLog = ''; server.stderr.on('data', c => { serverLog += c; });
for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/api/stats')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }

const REEL = 'https://www.instagram.com/reel/CreelTwo2/';
const COVER = 'https://scontent.cdninstagram.com/v/reel2_cover.jpg';
const VIDEO = 'https://scontent.cdninstagram.com/v/reel2.mp4';
const single = { url: REEL, site: 'instagram', author: 'bakehouse.kit', handle: 'bakehouse.kit', text: 'Shaping a batard in 30 seconds',
  takenAt: '2026-10-22T12:00:00.000Z', pictures: [COVER], video: true, videoUrl: VIDEO };

/** Plays the extension's helper in the window: the post on "ready", then its files when asked (as given). */
function helper({ single, files }) {
  const jpeg = () => {
    const bytes = new Uint8Array(3000); bytes.set([0xff, 0xd8, 0xff, 0xe0]); return new Blob([bytes], { type: 'image/jpeg' });
  };
  const mp4 = size => {
    const bytes = new Uint8Array(size); bytes.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]); return new Blob([bytes], { type: 'video/mp4' });
  };
  window.__asked = [];
  addEventListener('message', event => {
    if (event.source !== window || !event.data) return;
    if (event.data.type === 'sbm-ready' && !window.__sent) {
      window.__sent = true;
      window.postMessage({ type: 'sbm-posts', single, posts: [] }, location.origin);
    }
    if (event.data.type === 'sbm-want-media') {
      window.__asked.push(event.data.posts);
      for (const file of files) {
        const message = { type: 'sbm-media', post: single.url, url: file.url, kind: file.kind };
        if (file.error) { window.postMessage({ ...message, error: file.error, total: file.size || 0 }, location.origin); continue; }
        window.postMessage({ type: 'sbm-media-progress', post: single.url, url: file.url, kind: file.kind, received: 1000, total: file.size }, location.origin);
        const blob = file.kind === 'video' ? mp4(file.size) : jpeg();
        setTimeout(() => window.postMessage({ ...message, blob }, location.origin), file.delay || 100);
      }
    }
  });
}

const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message.split('\n').slice(0, 8).join(' | ')}`); }
}
const library = async () => (await (await fetch(base + '/api/library')).json()).posts;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 464, height: 600 } });
const errors = []; context.on('weberror', e => errors.push(e.error().message));
async function saveWindow(payload) {
  const page = await context.newPage();
  await page.addInitScript(helper, payload);
  await page.goto(`${base}/add?url=${encodeURIComponent(payload.single.url)}&title=Instagram&from=extension`);
  return page;
}
const key = async url => (await (await fetch(base + '/api/library')).json()).posts.find(p => p.url === url);

try {
  await check('an Instagram reel: the cover and the video come from the tab, and the copy keeps the video', async () => {
    const page = await saveWindow({ single, files: [{ url: COVER, kind: 'picture', size: 3000 }, { url: VIDEO, kind: 'video', size: 320 * 1024, delay: 900 }] });
    const card = page.getByLabel('The Instagram post');
    await card.getByText('Getting the post\'s picture and video from your tab', { exact: false }).waitFor();
    await card.getByText('The cover picture, the caption and the video (0.3 MB) will be saved with the link. They come from your tab: SuperBookmarks doesn\'t contact Instagram.').waitFor();
    assert.deepEqual(await page.evaluate(() => window.__asked), [[REEL]], 'asked once, for this post');
    assert.equal(await page.getByLabel('Title').inputValue(), 'bakehouse.kit on Instagram');
    await page.getByLabel('Save the pictures, caption and video (a saved copy)').waitFor();
    await page.screenshot({ path: join(evidence, 'reel-card.png') });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Saved', { exact: true }).waitFor({ timeout: 45000 });
    const post = await key(REEL);
    assert.equal(post.archiveStatus, 'saved', `${post.archiveStatus} ${post.archiveError ?? ''}`);
    const state = (await (await fetch(`${base}/api/archive?keys=${post.archiveKey}`)).json()).copies[post.archiveKey];
    assert.equal(state.video, true, 'the video is beside the copy');
    assert.equal(state.thumbnail, '/thumb/CreelTwo2', 'the preview from the uploaded cover');
    const files = await readdir(archiveDir);
    assert.ok(files.includes(`${post.archiveKey}.mp4`), files.join(','));
    assert.deepEqual(await readdir(join(archiveDir, 'incoming')), [], 'the uploads were used and removed');
    assert.deepEqual((await (await fetch(base + '/__seen')).json()).seen, [], 'the app fetched nothing from Instagram');
    await page.close();
  });

  await check('a video over 50 MB: the window and the copy say the cover is kept', async () => {
    const other = { ...single, url: 'https://www.instagram.com/reel/CbigOne99/', videoUrl: 'https://scontent.cdninstagram.com/v/big.mp4' };
    const page = await saveWindow({ single: other, files: [{ url: COVER, kind: 'picture', size: 3000 }, { url: other.videoUrl, kind: 'video', error: 'too_large', size: 80 * 1024 * 1024 }] });
    await page.getByLabel('The Instagram post').getByText('The video is bigger than 50 MB: its cover picture is kept.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Saved', { exact: true }).waitFor({ timeout: 45000 });
    const post = await key(other.url);
    const state = (await (await fetch(`${base}/api/archive?keys=${post.archiveKey}`)).json()).copies[post.archiveKey];
    assert.equal(state.status, 'saved');
    assert.ok(!state.video);
    const copy = await (await fetch(`${base}/archive/${post.archiveKey}`)).text();
    assert.match(copy, /The video is bigger than 50 MB, so only its cover picture was kept\./);
    await page.close();
  });

  await check('a reel whose page holds no file of its video: the window and the copy say so', async () => {
    // The owner's retest (2026-11-08): a reel opened over a profile had no picture and no video file on the page.
    const bare = { ...single, url: 'https://www.instagram.com/reel/CreelBare1/', pictures: [] };
    delete bare.videoUrl;
    let page = await saveWindow({ single: bare, files: [] });
    await page.getByLabel('The Instagram post').getByText("No pictures were found on the page; the caption will be saved. It's a video post, but the page doesn't hold the video's file, so the video isn't kept.").waitFor();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Saved', { exact: true }).waitFor({ timeout: 45000 });
    let post = await key(bare.url);
    assert.equal(post.archiveStatus, 'saved', `${post.archiveStatus} ${post.archiveError ?? ''}`);
    assert.match(await (await fetch(`${base}/archive/${post.archiveKey}`)).text(), /The page didn't hold the video's file, so the video isn't kept\./);
    await page.close();
    // With its cover from the tab.
    const covered = { ...bare, url: 'https://www.instagram.com/reel/CreelBare2/', pictures: [COVER] };
    page = await saveWindow({ single: covered, files: [{ url: COVER, kind: 'picture', size: 3000 }] });
    await page.getByLabel('The Instagram post').getByText("The cover picture and the caption will be saved with the link. They come from your tab: SuperBookmarks doesn't contact Instagram. The page doesn't hold the video's file, so the video isn't kept.").waitFor();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Saved', { exact: true }).waitFor({ timeout: 45000 });
    post = await key(covered.url);
    assert.match(await (await fetch(`${base}/archive/${post.archiveKey}`)).text(), /The page didn't hold the video's file, so only its cover picture was kept\./);
    await page.close();
  });

  await check('a picture the tab couldn\'t hand over: the window says the app fetches that one', async () => {
    const other = { ...single, url: 'https://www.instagram.com/reel/CpicMiss1/', videoUrl: 'https://scontent.cdninstagram.com/v/pm.mp4' };
    const page = await saveWindow({ single: other, files: [{ url: COVER, kind: 'picture', error: 'unavailable' }, { url: other.videoUrl, kind: 'video', size: 64 * 1024 }] });
    await page.getByLabel('The Instagram post').getByText("They come from your tab; one picture didn't, so SuperBookmarks fetches it from Instagram's picture server, as the bookmark button does.",
      { exact: false }).waitFor();
    assert.equal(await page.getByText("SuperBookmarks doesn't contact Instagram", { exact: false }).count(), 0, 'not claimed when it isn\'t so');
    await page.close();
  });

  await check('files for another post, or from another window, are not taken', async () => {
    const other = { ...single, url: 'https://www.instagram.com/reel/CthirdOne/' };
    const page = await saveWindow({ single: other, files: [] });
    await page.getByLabel('The Instagram post').waitFor();
    await page.evaluate(() => window.postMessage({ type: 'sbm-media', post: 'https://www.instagram.com/reel/CreelTwo2/', url: 'https://scontent.cdninstagram.com/v/x.mp4',
      kind: 'video', blob: new Blob([new Uint8Array(100)]) }, location.origin));
    await page.waitForTimeout(400);
    assert.equal(await page.getByText('the video (', { exact: false }).count(), 0, 'another post\'s file is ignored');
    await page.close();
  });

  await check('"Saved" shows once the app holds the copy (the window closes by itself right after)', async () => {
    const other = { ...single, url: 'https://www.instagram.com/reel/CslowSave3/', videoUrl: 'https://scontent.cdninstagram.com/v/slow.mp4' };
    const page = await saveWindow({ single: other, files: [{ url: COVER, kind: 'picture', size: 3000 }, { url: other.videoUrl, kind: 'video', size: 64 * 1024 }] });
    await page.getByLabel('The Instagram post').getByText('the video (', { exact: false }).waitFor();
    // A slow computer: the copy takes a moment and every save to SQLite too.
    await page.route(url => ['/api/archive', '/api/library'].includes(url.pathname), async route => {
      if (route.request().method() === 'POST') await new Promise(r => setTimeout(r, route.request().url().includes('/api/archive') ? 1500 : 1200));
      await route.continue();
    });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Saved', { exact: true }).waitFor({ timeout: 45000 });
    const post = await key(other.url);
    assert.equal(post?.archiveStatus, 'saved', `the app holds ${post?.archiveStatus ?? 'no link'} when the window says Saved`);
    assert.ok(post.archiveKey);
    await page.close();
  });

  await check('no page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await context.close();
  await browser.close();
  server.kill();
}
if (failures.length) { console.error(`FAILED ${failures.length} | evidence: ${evidence}`); if (serverLog.includes('Traceback')) console.error(serverLog.slice(-2000)); process.exit(1); }
console.log(`ALL PASS | evidence: ${evidence}`);
