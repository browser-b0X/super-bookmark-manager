// The extension carrying an Instagram post's pictures and video from the owner's tab to the app (v0.4.0
// phase 4): the toolbar button on an open reel, and a post's Download button on the feed, each end with a
// saved copy that has the video beside it, while the app fetches nothing from Instagram. While the app isn't
// running, what is saved is kept in the extension (its files too), the button counts it, and the next Save
// window hands it over; past the limit the oldest videos are left out first. The extension is loaded unpacked
// (a copy with the three sites allowed) against stand-in pages; copies are on. Nothing leaves the machine. Run from frontend/ after npm run build: node tests/extension-media-e2e.mjs
// (C4_PYTHON, C4_PLAYWRIGHT_MODULE; C4_EXTENSION_CHANNEL=msedge where full Chromium won't start)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pages from './post-pages.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { chromium } = createRequire(import.meta.url)(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
await mkdir(join(root, '.verify'), { recursive: true });
const evidence = await mkdtemp(join(root, '.verify', 'extension-media-'));
const port = 15000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const archiveDir = join(evidence, 'archive');
const startServer = () => spawn(process.env.C4_PYTHON || 'python3', ['-B', '-c', `
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
def picture(url, deadline):                  # the app fetching a picture itself: counted, never reached here
    seen.append(url)
    return "", "unavailable"
archive._picture = picture
storage.init_db()
from flask import jsonify
@app.app.route("/__seen")
def report():
    return jsonify(seen=seen)
@app.app.route("/__uploads_limit", methods=["POST"])
def uploads_limit():                         # test-only: how much room the app has for incoming files
    from flask import request
    archive.UPLOADS_LIMIT = int(request.args.get("bytes", "0"))
    return jsonify(ok=True)
app.app.run(host="127.0.0.1", port=${port}, debug=False, threaded=True)
`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
let server = startServer();
let serverLog = ''; server.stderr.on('data', c => { serverLog += c; });
const up = async () => { for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/api/stats')).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); } throw new Error('server did not start'); };
await up();

const shipped = JSON.parse(await readFile(join(root, 'extension', 'manifest.json'), 'utf8'));
const extensionDir = await mkdtemp(join(tmpdir(), 'sbm-ext-media-'));
await cp(join(root, 'extension'), extensionDir, { recursive: true });
await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify({ ...shipped, host_permissions: [...shipped.host_permissions, ...shipped.optional_host_permissions] }));

const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message.split('\n').slice(0, 8).join(' | ')}`); }
}
const library = async () => (await (await fetch(base + '/api/library')).json()).posts;
const copyState = async key => (await (await fetch(`${base}/api/archive?keys=${key}`)).json()).copies[key];
const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'sbm-ext-media-profile-')), {
  channel: process.env.C4_EXTENSION_CHANNEL || 'chromium', headless: true, viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
});
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const errors = []; context.on('weberror', e => errors.push(e.error().message));
  await pages.serveStandIns(context);
  // Paired as Settings and the options page would do it.
  const code = (await (await fetch(base + '/api/extension/code', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, body: '{}' })).json()).code.code;
  const pair = await pages.pairExtension(base, `chrome-extension://${extensionId}`, code, 'Edge');
  await worker.evaluate(s => chrome.storage.local.set(s), { app: base, token: pair.token, connId: pair.id });

  await check('the toolbar button on an open Instagram reel: the copy keeps the video, from the tab', async () => {
    const tab = await context.newPage();
    await tab.goto(pages.IG_REEL_URL);
    const [popup] = await Promise.all([context.waitForEvent('page'), worker.evaluate(async url => {
      const tab = (await chrome.tabs.query({})).find(t => t.url === url);
      await sbm.saveFromTab({ id: tab.id, url, title: 'Instagram' });
    }, pages.IG_REEL_URL)]);
    await popup.waitForLoadState();
    const card = popup.getByLabel('The Instagram post');
    await card.getByText('The cover picture, the caption and the video (0.3 MB) will be saved with the link.', { exact: false }).waitFor({ timeout: 20000 });
    await popup.screenshot({ path: join(evidence, 'reel-window.png') });
    await popup.getByRole('button', { name: 'Save', exact: true }).click();
    await popup.getByText('Saved', { exact: true }).waitFor({ timeout: 45000 });
    const post = (await library()).find(p => p.url === 'https://www.instagram.com/reel/CreelOwn55/');
    assert.equal(post.archiveStatus, 'saved', `${post.archiveStatus} ${post.archiveError ?? ''}`);
    const state = await copyState(post.archiveKey);
    assert.equal(state.video, true, 'the video is beside the copy');
    const movie = await readFile(join(archiveDir, `${post.archiveKey}.mp4`));
    assert.equal(movie.length, pages.MP4.length, 'the same file the tab had');
    assert.deepEqual((await (await fetch(base + '/__seen')).json()).seen, [], 'the app fetched nothing from Instagram');
    await tab.close();
  });

  await check('a post\'s Download button on the Instagram feed: its video from the page\'s own data', async () => {
    await worker.evaluate(() => chrome.storage.local.set({ marks: { x: false, instagram: true, tiktok: false } }));
    await worker.evaluate(() => sbm.syncMarks());
    const feed = await context.newPage();
    await feed.goto(pages.IG_FEED_URL);
    await feed.locator('[data-sbm-mark]').nth(1).waitFor({ timeout: 10000 });
    await (await context.newPage()).close();       // a fresh page in between, so the feed's click is its own
    await feed.bringToFront();
    const [popup] = await Promise.all([context.waitForEvent('page'), feed.locator('[data-sbm-mark]').nth(1).click()]);
    await popup.waitForLoadState();
    assert.ok(popup.url().startsWith(`${base}/add?url=${encodeURIComponent('https://www.instagram.com/reel/CreelTwo2/')}&`), popup.url());
    await popup.getByLabel('The Instagram post').getByText('the video (0.3 MB)', { exact: false }).waitFor({ timeout: 20000 });
    await popup.getByRole('button', { name: 'Save', exact: true }).click();
    await popup.getByText('Saved', { exact: true }).waitFor({ timeout: 45000 });
    const post = (await library()).find(p => p.url === 'https://www.instagram.com/reel/CreelTwo2/');
    assert.equal((await copyState(post.archiveKey)).video, true);
    assert.deepEqual((await (await fetch(base + '/__seen')).json()).seen, [], 'still nothing fetched from Instagram');
    await feed.close();
  });

  /** What a click on the toolbar button does on this page; resolves to the window it opened. */
  async function toolbar(url) {
    const tab = await context.newPage();
    await tab.goto(url);
    const [win] = await Promise.all([context.waitForEvent('page'), worker.evaluate(async ({ url, title }) => {
      const found = (await chrome.tabs.query({})).find(t => t.url === url) ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
      await sbm.saveFromTab({ id: found.id, url, title });
    }, { url, title: await tab.title() })]);
    await win.waitForLoadState();
    return { tab, win };
  }
  const badge = () => worker.evaluate(async () => [await chrome.action.getBadgeText({}), await chrome.action.getTitle({})]);
  await context.route('https://walks.example.invalid/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Ten walks</title><p>Walks</p>' }));

  await check('the app not running: the open post (its video too) and a page are kept, a feed\'s list is not; the button counts them', async () => {
    server.kill();
    await new Promise(r => setTimeout(r, 600));
    const reel = await toolbar(pages.IG_KEPT_URL);
    assert.ok(reel.win.url().startsWith(`chrome-extension://${extensionId}/kept.html#kept=`), reel.win.url());
    await reel.win.getByText("SuperBookmarks isn't running, so bakehouse.kit's post waits here, in the extension.").waitFor();
    await reel.win.getByText('1 waiting (0.3 MB).', { exact: false }).waitFor();
    await reel.win.screenshot({ path: join(evidence, 'kept.png') });
    assert.deepEqual(await badge(), ['1', 'SuperBookmarks: 1 waiting for the app']);
    await reel.win.close(); await reel.tab.close();
    const list = await toolbar(pages.X_FEED_URL);
    assert.ok(list.win.url().endsWith('kept.html#list&why=away'), list.win.url());
    await list.win.getByText('Start SuperBookmarks, then click the button again to list the posts on this page.').waitFor();
    await list.win.close(); await list.tab.close();
    const walks = await toolbar('https://walks.example.invalid/ten');
    await walks.win.getByText('2 waiting (0.3 MB).', { exact: false }).waitFor();
    assert.deepEqual(await badge(), ['2', 'SuperBookmarks: 2 waiting for the app']);
    await walks.win.close(); await walks.tab.close();
  });

  await check('running again: the next Save window starts on "Waiting", Save keeps them (the video from the extension) and the count goes', async () => {
    server = startServer(); server.stderr.on('data', c => { serverLog += c; });
    await up();
    const { tab, win } = await toolbar('https://walks.example.invalid/other');
    assert.ok(win.url().endsWith('&from=extension'), win.url());
    await win.getByRole('tab', { name: 'Waiting (2)', selected: true }).waitFor();
    const list = win.getByLabel("Kept while SuperBookmarks wasn't running");
    await list.getByText('Video · 0.3 MB').waitFor();
    await list.getByText('Ten walks').waitFor();
    assert.deepEqual(await list.getByRole('checkbox').evaluateAll(boxes => boxes.map(b => b.checked)), [true, true], 'kept ones start ticked');
    await win.screenshot({ path: join(evidence, 'waiting.png') });
    await win.getByRole('button', { name: 'Save 2' }).click();
    await win.getByText('Saved 2 kept ones').waitFor({ timeout: 45000 });
    const posts = await library();
    const kept = posts.find(p => p.url === 'https://www.instagram.com/reel/CkeptOne7/');
    assert.equal((await copyState(kept.archiveKey)).video, true, 'the kept video went into the copy');
    assert.ok(posts.some(p => p.url === 'https://walks.example.invalid/ten' && p.title === 'Ten walks'));
    for (let i = 0; i < 30 && (await badge())[0] !== ''; i++) await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(await badge(), ['', 'Save to SuperBookmarks'], 'nothing waits any more');
    assert.equal((await worker.evaluate(() => sbm.readQueue())).items.length, 0);
    await tab.close();
  });

  await check('past the limit the oldest videos are left out first; their posts stay, and the window is told', async () => {
    const notes = await worker.evaluate(async () => {
      const blob = n => new Blob([new Uint8Array(n)], { type: 'video/mp4' });
      const post = (code, author) => ({ url: `https://www.instagram.com/reel/${code}/`, site: 'instagram', author, handle: '', text: '', takenAt: '', pictures: [], video: true });
      const keep = (code, author) => sbm.keepForLater({ url: post(code, author).url, title: 'Instagram', single: post(code, author),
        files: [{ url: `https://scontent.cdninstagram.com/v/${code}.mp4`, kind: 'video', type: 'video/mp4' }] },
        new Map([[`https://scontent.cdninstagram.com/v/${code}.mp4`, blob(300 * 1024)]]), 500 * 1024);
      await keep('ColdOne11', 'haleandcrumb');
      const all = await keep('CnewOne22', 'bakehouse.kit');
      const items = ['ColdOne11', 'CnewOne22'].map(code => all.find(i => i.url.includes(code)));
      const { notices } = await sbm.readQueue();
      const gone = await sbm.getQueueFile(items[0].files[0].fileId);
      const kept = await sbm.getQueueFile(items[1].files[0].fileId);
      const answer = { dropped: items.map(i => i.files[0].dropped === true), notices, gone: gone === undefined, kept: kept ? kept.size : 0 };
      await sbm.queueDone(all.map(i => i.id));
      answer.after = (await sbm.readQueue());
      answer.afterFile = (await sbm.getQueueFile(items[1].files[0].fileId)) === undefined;
      return answer;
    });
    assert.deepEqual(notes.dropped, [true, false], 'the older post\'s video went, the newer one stays');
    assert.equal(notes.notices.length, 1);
    assert.deepEqual([notes.notices[0].name, notes.notices[0].kind], ["haleandcrumb's post", 'video']);
    assert.deepEqual([notes.gone, notes.kept], [true, 300 * 1024]);
    assert.deepEqual([notes.after.items.length, notes.after.notices.length, notes.afterFile], [0, 0, true], 'done: nothing kept, no notices');
  });

  await check('two saves at the same moment while the app is closed: both are kept', async () => {
    const kept = await worker.evaluate(async () => {
      const page = n => ({ url: `https://walks.example.invalid/at-once-${n}`, title: `At once ${n}`, single: null, files: [] });
      await Promise.all([sbm.keepForLater(page(1)), sbm.keepForLater(page(2))]);
      const { items } = await sbm.readQueue();
      const urls = items.map(i => i.url).filter(u => u.includes('at-once'));
      await sbm.queueDone(items.map(i => i.id));
      return urls.sort();
    });
    assert.deepEqual(kept, ['https://walks.example.invalid/at-once-1', 'https://walks.example.invalid/at-once-2']);
  });

  await check('a kept post whose files can\'t reach the app is not saved without them: it stays waiting', async () => {
    server.kill();
    await new Promise(r => setTimeout(r, 600));
    const kept = await toolbar(pages.IG_KEPT2_URL);
    await kept.win.close(); await kept.tab.close();
    server = startServer(); server.stderr.on('data', c => { serverLog += c; });
    await up();
    await fetch(base + '/__uploads_limit?bytes=10', { method: 'POST' });      // the app has no room for the video
    try {
      const { tab, win } = await toolbar('https://walks.example.invalid/third');
      await win.getByRole('tab', { name: 'Waiting (1)', selected: true }).waitFor({ timeout: 20000 });
      await win.getByRole('button', { name: 'Save 1' }).click();
      await win.getByText("1 couldn't be saved: its pictures or video didn't reach the app. It stays waiting in the extension; try again in a moment.", { exact: false })
        .waitFor({ timeout: 45000 });
      const left = await worker.evaluate(() => sbm.readQueue());
      assert.deepEqual(left.items.map(i => i.url), ['https://www.instagram.com/reel/CkeptTwo8/'], 'still waiting, with its files');
      assert.ok(left.items[0].files.length > 0 && left.items[0].files.every(f => !f.dropped));
      assert.equal((await library()).some(p => p.url.includes('CkeptTwo8')), false, 'not saved without its video');
      await worker.evaluate(ids => sbm.queueDone(ids), left.items.map(i => i.id));
      await win.close().catch(() => {}); await tab.close();
    } finally {
      await fetch(base + '/__uploads_limit?bytes=314572800', { method: 'POST' });
    }
  });

  await check('no page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await context.close();
  server.kill();
}
if (failures.length) { console.error(`FAILED ${failures.length} | evidence: ${evidence}`); if (serverLog.includes('Traceback')) console.error(serverLog.slice(-2000)); process.exit(1); }
console.log(`ALL PASS | evidence: ${evidence}`);
