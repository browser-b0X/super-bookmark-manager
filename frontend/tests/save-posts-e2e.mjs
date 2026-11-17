// The Save window with what the browser extension read in the owner's tab (v0.4.0 phase 3, mockups in
// Claude outputs/v040-review/phase3): "Save the posts on this page" (none ticked to start, "Already saved"
// whatever spelling, Tick all, tags, Save adds the ticked ones), the "This page" tab, one open X post, and
// Instagram posts saved with copies made from what the tab showed. The extension's helper script is played
// by a script in the window itself; messages from anywhere else are ignored. Synthetic data; nothing leaves
// the machine. Run from frontend/ after npm run build: node tests/save-posts-e2e.mjs (C4_PYTHON, C4_PLAYWRIGHT_MODULE)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(join(root, '.verify'), { recursive: true });
const evidence = await mkdtemp(join(root, '.verify', 'save-posts-'));
const port = 15000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;

const server = spawn(process.env.C4_PYTHON || 'python3', ['-B', '-c', `
import base64, os, sys
sys.path.insert(0, ${JSON.stringify(root)})
sys.path.insert(0, ${JSON.stringify(join(root, 'frontend', 'tests'))})
os.environ["SAVED_POSTS_DB_PATH"] = ${JSON.stringify(join(evidence, 'fixture.sqlite'))}
os.environ["SUPER_BOOKMARK_MANAGER_DATA_DIR"] = ${JSON.stringify(join(evidence, 'data'))}
os.environ["SBM_AI_CONFIG_FILE"] = ${JSON.stringify(join(evidence, 'ai.json'))}
os.environ["SBM_ARCHIVE_DIR"] = ${JSON.stringify(join(evidence, 'archive'))}
os.environ["SBM_THUMB_CACHE_DIR"] = ${JSON.stringify(join(evidence, 'thumbs'))}
from metadata_fixture import ControlledHTTP, JPEG
import storage, app, archive, metadata_fetcher
metadata_fetcher.fetch_metadata = lambda url: {"title": "", "summary": "", "thumbnail": "", "status": "empty", "error": ""}
archive.HOST_SPACING = 0.0
site = ControlledHTTP().__enter__()          # nothing may leave the machine
seen = []
# Test doubles for Instagram's picture host (downloading is covered by instagram_backend.py):
def picture(url, deadline):
    seen.append(url)
    return ("data:image/jpeg;base64," + base64.b64encode(JPEG).decode(), "") if "cdninstagram.com" in url else ("", "unavailable")
archive._picture = picture
def thumb(image_url, post_url, deadline=None, strict=False):
    code = metadata_fetcher._ig_post_code(post_url)
    os.makedirs(metadata_fetcher.THUMB_CACHE_DIR, exist_ok=True)
    open(os.path.join(metadata_fetcher.THUMB_CACHE_DIR, code), "wb").write(JPEG + b"\\0" * 2000)
    return "/thumb/" + code
metadata_fetcher._cache_instagram_thumb = thumb
storage.init_db()
from flask import jsonify
@app.app.route("/__seen")
def report():
    return jsonify(seen=seen)
app.app.run(host="127.0.0.1", port=${port}, debug=False, threaded=True)
`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
let serverLog = ''; server.stderr.on('data', c => { serverLog += c; });
for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/api/stats')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }

const at = '2026-10-20T10:00:00.000Z';
await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deletedUrls: [], posts: [{
  id: 'bread', url: 'https://twitter.com/BreadLabNotes/status/1848900000000000002', source: 'manual', platform: 'x', domain: 'twitter.com', status: 'reference',
  createdAt: at, updatedAt: at, metadataStatus: 'enriched', categories: ['Recipes'], categoryMode: 'manual', tags: ['keep'], projectIds: [], title: 'Bread Lab Notes on X' }] }) });

// "A website" on another origin, for the message that must be ignored.
const sitePort = 15000 + Math.floor(Math.random() * 20000);
const siteServer = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Another site</title><p>elsewhere</p>'); }).listen(sitePort, '127.0.0.1');

const X_FEED_URL = 'https://x.com/search?q=sourdough&src=typed_query';
const X_POSTS = [
  { url: 'https://x.com/maraquinn/status/1849000000000000001', site: 'x', author: 'Mara Quinn', handle: 'maraquinn', text: 'Day 3 of the rye starter: finally bubbly.\nFeeding schedule in the thread below.',
    takenAt: new Date(Date.now() - 2 * 3600e3).toISOString(), pictures: ['https://pbs.twimg.com/media/MaraOne?format=jpg&name=small', 'https://pbs.twimg.com/media/MaraTwo?format=jpg&name=small'], video: false },
  { url: 'https://x.com/breadlabnotes/status/1848900000000000002', site: 'x', author: 'Bread Lab Notes', handle: 'breadlabnotes', text: 'Why your sourdough is flat: a short guide to proofing times at room temperature',
    takenAt: new Date(Date.now() - 5 * 3600e3).toISOString(), pictures: [], video: false },
  { url: 'https://x.com/tferreira/status/1848800000000000003', site: 'x', author: 'Tomás Ferreira', handle: 'tferreira', text: 'Overnight loaf, 78% hydration <img src=x onerror="document.title=\'PWNED\'">',
    takenAt: new Date(Date.now() - 8 * 3600e3).toISOString(), pictures: ['https://pbs.twimg.com/ext_tw_video_thumb/3/pu/img/loaf.jpg'], video: true },
  { url: 'https://x.com/JuniperBakes/status/1848700000000000004', site: 'x', author: 'Juniper Wells', handle: 'JuniperBakes', text: 'Rye crackers from leftover starter. Recipe card attached.',
    takenAt: new Date(Date.now() - 26 * 3600e3).toISOString(), pictures: ['https://pbs.twimg.com/media/JuniperCard?format=png&name=900x900'], video: false },
  { url: 'https://evil.invalid/steal', author: 'Not a post' },
  { url: 'https://twitter.com/maraquinn/status/1849000000000000001', author: 'The same post again' },
];
const IG_POSTS = [
  { url: 'https://www.instagram.com/p/CgridOne1/', site: 'instagram', author: 'Ana Field Notes', handle: 'fieldnotes_ana', text: 'Photo by Ana Field Notes on October 20, 2026.', takenAt: '',
    pictures: ['https://scontent.cdninstagram.com/v/grid1.jpg'], video: false },
  { url: 'https://www.instagram.com/reel/CgridTwo2/', site: 'instagram', author: 'Ana Field Notes', handle: 'fieldnotes_ana', text: 'Starter feeding routine, explained.', takenAt: '',
    pictures: ['https://scontent.cdninstagram.com/v/grid2.jpg'], video: true },
  { url: 'https://www.instagram.com/p/CgridThree3/', site: 'instagram', author: 'Ana Field Notes', handle: 'fieldnotes_ana', text: '', takenAt: '',
    pictures: ['https://scontent.cdninstagram.com/v/grid3.jpg'], video: false },
];

/** Plays the extension's helper script: it answers the window's "ready" from inside the window. */
function helper(payload) {
  addEventListener('message', event => {
    if (event.source !== window || !event.data || event.data.type !== 'sbm-ready' || window.__sbmSent) return;
    window.__sbmSent = true;
    window.postMessage({ type: 'sbm-posts', ...payload }, location.origin);
  });
}
const enc = encodeURIComponent;
const library = async () => (await (await fetch(base + '/api/library')).json()).posts;
const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message.split('\n').slice(0, 8).join(' | ')}`); }
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 464, height: 600 } });
const errors = []; context.on('weberror', e => errors.push(e.error().message));
async function saveWindow(url, title, payload, from = true) {
  const page = await context.newPage();
  if (payload) await page.addInitScript(helper, payload);
  await page.goto(`${base}/add?url=${enc(url)}&title=${enc(title)}${from ? '&from=extension' : ''}`);
  return page;
}
const listBoxes = page => page.getByLabel('Posts on this page').getByRole('checkbox');

try {
  await check('the posts on a feed: none ticked, already saved marked, Tick all, Save adds the ticked ones', async () => {
    const page = await saveWindow(X_FEED_URL, 'sourdough - Search / X', { single: null, posts: X_POSTS });
    await page.getByRole('tab', { name: 'Posts on this page (4)', selected: true }).waitFor();
    assert.equal(await listBoxes(page).count(), 4, 'the post on another site and the second spelling are dropped');
    assert.deepEqual(await listBoxes(page).evaluateAll(boxes => boxes.map(b => b.checked)), [false, false, false, false], 'nothing is ticked to start with');
    await page.getByText('✓ Already saved · Recipes').waitFor();
    await page.getByText('0 of 4').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
    await page.screenshot({ path: join(evidence, 'posts-list.png') });
    await page.getByRole('button', { name: 'Tick all', exact: true }).click();
    assert.deepEqual(await listBoxes(page).evaluateAll(boxes => boxes.map(b => b.checked)), [true, false, true, true], 'Tick all leaves out the post already saved');
    await page.getByRole('checkbox', { name: /Tomás Ferreira/ }).uncheck();
    await page.getByRole('checkbox', { name: /Bread Lab Notes/ }).check();
    await page.getByText('3 of 4').waitFor();
    await page.getByLabel('Tags').fill('Sourdough, #bread');
    await page.getByRole('button', { name: 'Save 3 posts' }).click();
    await page.getByText('Saved 2 posts').waitFor();
    await page.getByText('1 was already saved and got the new tags; nothing was added twice.').waitFor();
    assert.notEqual(await page.title(), 'PWNED');
    const posts = await library();
    const mara = posts.find(p => p.url === 'https://x.com/maraquinn/status/1849000000000000001');
    const juniper = posts.find(p => p.url === 'https://x.com/JuniperBakes/status/1848700000000000004');
    assert.ok(mara && juniper, JSON.stringify(posts.map(p => p.url)));
    assert.deepEqual([mara.status, mara.tags, juniper.tags], ['inbox', ['sourdough', 'bread'], ['sourdough', 'bread']]);
    const bread = posts.filter(p => /1848900000000000002/.test(p.url));
    assert.equal(bread.length, 1, 'no second link for the post saved as twitter.com');
    assert.deepEqual([bread[0].status, bread[0].categories, bread[0].tags], ['reference', ['Recipes'], ['keep', 'sourdough', 'bread']]);
    assert.equal(posts.some(p => /1848800000000000003/.test(p.url)), false, 'the unticked post is not saved');
    await page.close();
  });

  await check('"This page" saves the page itself, as before', async () => {
    const page = await saveWindow(X_FEED_URL, 'sourdough - Search / X', { single: null, posts: X_POSTS.slice(0, 2) });
    await page.getByRole('tab', { name: 'This page', exact: true }).click();
    await page.getByRole('tab', { name: 'This page', exact: true, selected: true }).waitFor();
    assert.equal(await page.getByLabel('Title').inputValue(), 'sourdough - Search / X');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Saved', { exact: true }).waitFor();
    assert.ok((await library()).some(p => p.url === X_FEED_URL));
    await page.close();
  });

  await check('one open X post: what the extension read, then the ordinary save', async () => {
    const single = { ...X_POSTS[0], url: 'https://x.com/maraquinn/status/1849000000000000001', pictures: [X_POSTS[0].pictures[0]] };
    const page = await saveWindow('https://x.com/HaleAndCrumb/status/1849000000000000011', 'Hale & Crumb on X: "Class dates" / X',
      { single: { ...single, url: 'https://x.com/HaleAndCrumb/status/1849000000000000011', author: 'Hale & Crumb', handle: 'HaleAndCrumb', text: 'Weekend class dates are up.\nShaping and scoring.' }, posts: [] });
    const card = page.getByLabel('The X post');
    await card.getByText('Hale & Crumb').waitFor();
    await card.getByText('1 picture.', { exact: false }).waitFor();
    await page.getByLabel('Save a copy of the post').waitFor();
    assert.equal(await page.getByRole('tablist').count(), 0, 'one post: no list');
    await page.screenshot({ path: join(evidence, 'single-post.png') });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Saved', { exact: true }).waitFor();
    const saved = (await library()).find(p => p.url === 'https://x.com/HaleAndCrumb/status/1849000000000000011');
    // The name the library gives a post (owner, 2026-11-03), not X's tab title.
    assert.equal(saved.title, '@HaleAndCrumb on X');
    await page.close();
  });

  // The preview stand-in above answers as X's does, with no title: what the save gives a link is what the library shows.
  const NIGHT = { site: 'x', author: 'Night Baker', handle: 'nightbaker', text: 'Crumb shot from the 4 am bake.', takenAt: '', pictures: [], video: false };
  const titleOf = async url => {
    const post = (await library()).find(p => p.url === url);
    return [post.title, post.fieldSources?.title];
  };

  await check('a post from the list gets a name, not the number its address ends in, and the library shows that name', async () => {
    const x = 'https://x.com/nightbaker/status/1851200000000000001', tiktok = 'https://www.tiktok.com/@nightbaker/video/7430000000000000009';
    const page = await saveWindow(X_FEED_URL, 'sourdough - Search / X', { single: null, posts: [{ ...NIGHT, url: x }, { ...NIGHT, url: tiktok, site: 'tiktok' }] });
    await page.getByRole('button', { name: 'Tick all', exact: true }).click();
    await page.getByRole('button', { name: 'Save 2 posts' }).click();
    await page.getByText('Saved 2 posts').waitFor();
    assert.deepEqual(await titleOf(x), ['@nightbaker on X', 'derived']);
    assert.deepEqual(await titleOf(tiktok), ['@nightbaker on TikTok', 'derived'], 'TikTok\'s preview can still replace it with the caption');
    await page.close();
    const shelf = await context.newPage();
    await shelf.goto(`${base}/library`);
    await shelf.getByRole('link', { name: '@nightbaker on X', exact: true }).waitFor();
    assert.equal(await shelf.getByText('1851200000000000001').count(), 0);
    await shelf.close();
  });

  await check('a post\'s button on a feed sends no title: its link gets a name too', async () => {
    const url = 'https://x.com/nightbaker/status/1851200000000000002';
    const page = await saveWindow(url, '', { single: { ...NIGHT, url }, posts: [] });
    await page.getByLabel('The X post').waitFor();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Saved', { exact: true }).waitFor();
    assert.deepEqual(await titleOf(url), ['@nightbaker on X', 'derived']);
    await page.close();
  });

  await check('a post the extension kept gets a name too', async () => {
    const url = 'https://x.com/nightbaker/status/1851200000000000003';
    const page = await saveWindow('https://walks.example.invalid/other', 'Other', { single: null, posts: [],
      waiting: [{ id: 'mh6abc12xyz9', keptAt: at, url, title: '', single: { ...NIGHT, url }, files: [] }] });
    await page.getByRole('tab', { name: 'Waiting (1)', selected: true }).waitFor();
    await page.getByRole('button', { name: 'Save 1' }).click();
    await page.getByText('Saved 1 kept one').waitFor();
    assert.deepEqual(await titleOf(url), ['@nightbaker on X', 'derived']);
    await page.close();
  });

  await check('a link already saved under its number gets the name when the app opens, and SQLite keeps it', async () => {
    const url = 'https://x.com/nightbaker/status/1851200000000000004';
    await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deletedUrls: [], posts: [{
      id: 'numbered', url, source: 'manual', platform: 'x', domain: 'x.com', status: 'inbox', createdAt: at, updatedAt: at, metadataStatus: 'none',
      categories: ['Recipes'], categoryMode: 'manual', tags: [], projectIds: [], title: '1851200000000000004', fieldSources: { title: 'derived' } }] }) });
    const shelf = await context.newPage();
    await shelf.goto(`${base}/library`);
    await shelf.getByRole('link', { name: '@nightbaker on X', exact: true }).first().waitFor();
    for (let i = 0; i < 50 && (await titleOf(url))[0] !== '@nightbaker on X'; i++) await shelf.waitForTimeout(200);
    assert.deepEqual(await titleOf(url), ['@nightbaker on X', 'derived']);
    await shelf.close();
  });

  await check('a different post than the window is for is not shown as its post', async () => {
    const page = await saveWindow('https://x.com/HaleAndCrumb/status/1849000000000000099', 'x', { single: X_POSTS[0], posts: [] });
    await page.waitForFunction(() => window.__sbmSent === true);
    await page.waitForTimeout(500);
    assert.equal(await page.getByLabel('The X post').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isEnabled(), true);
    await page.close();
  });

  await check('Instagram posts from a profile: saved with copies made from what the tab showed', async () => {
    const page = await saveWindow('https://www.instagram.com/fieldnotes_ana/', 'Ana Field Notes (@fieldnotes_ana) • Instagram photos and videos', { single: null, posts: IG_POSTS });
    await page.getByRole('tab', { name: 'Posts on this page (3)' }).waitFor();
    assert.equal(await page.getByLabel('Save a copy of each post').isChecked(), true, 'Instagram posts need their copy for their pictures');
    await page.getByRole('checkbox', { name: /Photo by Ana Field Notes/ }).check();
    await page.getByRole('checkbox', { name: /Starter feeding routine/ }).check();
    await page.getByRole('button', { name: 'Save 2 posts' }).click();
    await page.getByText('Saved 2 posts').waitFor({ timeout: 45000 });
    const posts = await library();
    for (const code of ['CgridOne1', 'CgridTwo2']) {
      const post = posts.find(p => p.url.includes(code));
      assert.equal(post.title, 'Ana Field Notes on Instagram');
      assert.equal(post.archiveStatus, 'saved', `${code}: ${post.archiveStatus} ${post.archiveError ?? ''}`);
    }
    const { seen } = await (await fetch(base + '/__seen')).json();
    assert.deepEqual(seen.sort(), ['https://scontent.cdninstagram.com/v/grid1.jpg', 'https://scontent.cdninstagram.com/v/grid2.jpg']);
    await page.close();
  });

  await check('without from=extension a message from the window itself is not taken', async () => {
    const page = await saveWindow('https://x.com/search?q=rye', 'x', { single: null, posts: X_POSTS }, false);
    await page.evaluate(posts => window.postMessage({ type: 'sbm-posts', single: null, posts }, location.origin), X_POSTS);
    await page.waitForTimeout(800);
    assert.equal(await page.getByRole('tablist').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isEnabled(), true);
    await page.close();
  });

  await check('another window (a website that opened it) cannot hand over posts; the window stops waiting', async () => {
    const site = await context.newPage();
    await site.goto(`http://127.0.0.1:${sitePort}/`);
    const [popup] = await Promise.all([context.waitForEvent('page'),
      site.evaluate(url => { window.w = window.open(url, 'sbm-add', 'width=460,height=600'); }, `${base}/add?url=${enc('https://x.com/search?q=crumb')}&title=x&from=extension`)]);
    await site.evaluate(posts => {
      window.timer = setInterval(() => { try { window.w.postMessage({ type: 'sbm-posts', single: null, posts }, '*'); } catch {} }, 200);
    }, X_POSTS);
    await popup.getByText('Reading the posts on this page…').waitFor();
    await popup.getByRole('button', { name: 'Save', exact: true }).waitFor({ state: 'visible' });
    await popup.waitForFunction(() => !document.body.innerText.includes('Reading the posts'), null, { timeout: 15000 });
    assert.equal(await popup.getByRole('tablist').count(), 0, 'nothing taken from the other site');
    assert.equal(await popup.getByRole('button', { name: 'Save', exact: true }).isEnabled(), true, 'after waiting, the page can still be saved');
    await site.close();
  });

  await check('no page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await context.close();
  await browser.close();
  server.kill();
  siteServer.close();
}
if (failures.length) { console.error(`FAILED ${failures.length} | evidence: ${evidence}`); if (serverLog.includes('Traceback')) console.error(serverLog.slice(-2000)); process.exit(1); }
console.log(`ALL PASS | evidence: ${evidence}`);
