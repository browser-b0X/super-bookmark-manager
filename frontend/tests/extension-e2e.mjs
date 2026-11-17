// The SuperBookmarks browser extension (v0.4.0 phase 2, owner-approved mockups p2-1 to p2-4; phase 3,
// mockups in Claude outputs/v040-review/phase3), loaded unpacked in Chromium against a synthetic library:
// pairing with a one-time code from Settings, the Save window opened as the toolbar button opens it
// (tracking parameters gone), the posts on X, Instagram and TikTok stand-in pages handed to that window,
// the check mark on a saved page, and disconnecting. No real site is contacted.
// Run from frontend/ after npm run build: node tests/extension-e2e.mjs (C4_PYTHON, C4_PLAYWRIGHT_MODULE)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pages from './post-pages.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
// The extension as shipped, with the three sites allowed (in real use the toolbar click lets it into the tab:
// activeTab, which a test can't click; the Download buttons ask for each site when switched on).
const shipped = JSON.parse(await readFile(join(root, 'extension', 'manifest.json'), 'utf8'));
const extensionDir = await mkdtemp(join(tmpdir(), 'sbm-ext-'));
await cp(join(root, 'extension'), extensionDir, { recursive: true });
await writeFile(join(extensionDir, 'manifest.json'), JSON.stringify({ ...shipped,
  host_permissions: [...shipped.host_permissions, 'https://x.com/*', 'https://twitter.com/*', 'https://www.instagram.com/*', 'https://www.tiktok.com/*'] }));
const { chromium } = createRequire(import.meta.url)(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
await mkdir(join(root, '.verify'), { recursive: true });
const evidence = await mkdtemp(join(root, '.verify', 'extension-'));
const port = 15000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const startServer = () => spawn(process.env.C4_PYTHON || 'python3', ['-B', '-c', `
import os, sys
sys.path.insert(0, ${JSON.stringify(root)})
os.environ["SAVED_POSTS_DB_PATH"] = ${JSON.stringify(join(evidence, 'fixture.sqlite'))}
os.environ["SUPER_BOOKMARK_MANAGER_DATA_DIR"] = ${JSON.stringify(join(evidence, 'data'))}
os.environ["SBM_AI_CONFIG_FILE"] = ${JSON.stringify(join(evidence, 'ai.json'))}
os.environ["SBM_ARCHIVE_DIR"] = ${JSON.stringify(join(evidence, 'archive'))}
os.environ["SBM_SAVED_COPIES"] = "off"
os.environ["SBM_THUMB_CACHE_DIR"] = ${JSON.stringify(join(evidence, 'thumbs'))}
import storage, app, metadata_fetcher
metadata_fetcher.fetch_metadata = lambda url: {"title": "", "summary": "", "thumbnail": "", "status": "empty", "error": ""}
storage.init_db()
app.app.run(host="127.0.0.1", port=${port}, debug=False, threaded=True)
`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
let server = startServer();
let serverLog = ''; server.stderr.on('data', c => { serverLog += c; });
const up = async () => { for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/api/stats')).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); } throw new Error('server did not start'); };
await up();
const at = '2026-10-24T10:00:00.000Z';
await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deletedUrls: [], posts: [{
  id: 'b1', url: 'https://bread.example.invalid/slow-bread', source: 'browser', platform: 'web', domain: 'bread.example.invalid', status: 'reference',
  createdAt: at, updatedAt: at, metadataStatus: 'partial', categories: ['food'], categoryMode: 'manual', tags: [], projectIds: [], title: 'Slow bread' }] }) });

const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message.split('\n').slice(0, 6).join(' | ')}`); }
}
const library = async () => (await (await fetch(base + '/api/library')).json()).posts;
const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'sbm-ext-profile-')), {
  // Full Chromium can load extensions headless; where it won't start (Windows N editions here), C4_EXTENSION_CHANNEL=msedge.
  channel: process.env.C4_EXTENSION_CHANNEL || 'chromium', headless: true, viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
});
try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const errors = []; context.on('weberror', e => errors.push(e.error().message));

  await check('the extension asks only for what the mockups name', async () => {
    const manifest = shipped;
    assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'contextMenus', 'scripting', 'storage']);
    assert.deepEqual(manifest.optional_permissions, ['tabs'], 'the address of the page you\'re on only for the check mark');
    assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
    assert.deepEqual(manifest.optional_host_permissions, ['https://x.com/*', 'https://twitter.com/*', 'https://www.instagram.com/*', 'https://www.tiktok.com/*'],
      'each site only when its Download button is switched on');
  });
  await pages.serveStandIns(context);

  const settings = await context.newPage();
  const options = await context.newPage();
  await check('before pairing, nothing goes to the app\'s address: the extension\'s own window says how to pair', async () => {
    // The pre-release review (2026-11-09): an unpaired extension opened the app's address with the page's address and
    // title, for whatever program answered there. (Before that, 2026-11-03: unpaired in Chrome, every save came empty.)
    const url = 'https://www.instagram.com/p/CfixTure123/';
    const seen = [];
    const listener = createServer((request, response) => { seen.push(request.url); response.end('not the app'); });
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    try {
      // A listener of this test's own, never the default address: 127.0.0.1:5001 is the owner's own app on this PC.
      await worker.evaluate(app => chrome.storage.local.set({ app }), `http://127.0.0.1:${listener.address().port}`);
      const [popup] = await Promise.all([context.waitForEvent('page'), worker.evaluate(url => sbm.openSaveWindow(url, 'A private title',
        { single: { url, site: 'instagram', author: 'Ana Field Notes', handle: 'fieldnotes_ana', text: 'Slow rise rye', takenAt: '', pictures: [], video: false },
          posts: [] }), url)]);
      await popup.waitForLoadState();
      assert.equal(popup.url(), `chrome-extension://${extensionId}/kept.html#pair`);
      await popup.getByText('Not connected yet').waitFor();
      await popup.getByText('nothing was saved and nothing was sent', { exact: false }).waitFor();
      await popup.getByText('Settings → Sources → Save from your browser', { exact: false }).waitFor();
      await popup.setViewportSize({ width: 480, height: 300 });     // the window's own size
      await popup.screenshot({ path: join(evidence, 'not-connected.png') });
      await popup.emulateMedia({ colorScheme: 'dark' });
      await popup.screenshot({ path: join(evidence, 'not-connected-dark.png') });
      await popup.emulateMedia({ colorScheme: null });
      // A plain page (the toolbar button anywhere, a link's menu entry): the same.
      const [plain] = await Promise.all([context.waitForEvent('page'), worker.evaluate(() => sbm.openSaveWindow('https://walks.example.invalid/ten?key=abc', 'Ten walks'))]);
      await plain.waitForLoadState();
      assert.equal(plain.url(), `chrome-extension://${extensionId}/kept.html#pair`);
      await plain.close();
      assert.deepEqual(seen, [], 'nothing reached the app address');
      assert.deepEqual((await worker.evaluate(() => sbm.readQueue())).items, [], 'and nothing is kept');
      // Its button opens the options, where the pairing code goes (the browser may use a blank tab it already has), and
      // the window closes itself.
      await popup.getByRole('button', { name: 'Open the options' }).click();
      const atOptions = () => context.pages().filter(page => page.url() === `chrome-extension://${extensionId}/options.html`);
      for (let i = 0; i < 100 && !(atOptions().length && popup.isClosed()); i++) await new Promise(resolve => setTimeout(resolve, 100));
      assert.ok(atOptions().length >= 1, 'the options are open');
      assert.ok(popup.isClosed(), 'the window closed itself');
      for (const page of atOptions()) if (page !== options) await page.close();
    } finally {
      await worker.evaluate(app => chrome.storage.local.set({ app }), base);
      listener.close();
    }
  });

  await check('pairing: a code from Settings, typed into the options, connects both sides', async () => {
    await settings.goto(base + '/library/settings#sources');
    const card = settings.getByLabel('SuperBookmarks extension');
    await card.getByText('○ Not connected yet').waitFor();
    await card.getByRole('button', { name: 'Show a pairing code' }).click();
    const code = (await card.getByLabel('Pairing code').innerText()).trim();
    assert.match(code, /^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    await card.screenshot({ path: join(evidence, 'settings-code.png') });
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.locator('#status').filter({ hasText: 'Not connected yet.' }).waitFor();

    // A program at the address the extension was given: it answers everything with a token of its own, and would work
    // the code out if it were given anything to work from.
    const heard = [];
    const impostor = createServer((request, response) => {
      let body = '';
      request.on('data', part => { body += part; });
      request.on('end', () => {
        heard.push(body);
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ ok: true, challenge: 'a'.repeat(32), token: 'y'.repeat(43), id: 'impostor', proof: 'f'.repeat(64) }));
      });
    });
    await new Promise(resolve => impostor.listen(0, '127.0.0.1', resolve));
    await options.locator('#app').fill(`http://127.0.0.1:${impostor.address().port}`);
    await options.locator('#app').dispatchEvent('change');
    await options.locator('#code').fill(code.toLowerCase());
    await options.getByRole('button', { name: 'Connect' }).click();
    await options.locator('#status').filter({ hasText: 'something other than SuperBookmarks is answering at this app address' }).waitFor();
    assert.equal((await worker.evaluate(() => chrome.storage.local.get('token'))).token ?? '', '', 'not paired with it');
    assert.equal(heard.length, 1, 'it stopped at the first step');
    assert.deepEqual(Object.keys(JSON.parse(heard[0])), ['nonce'], 'and gave nothing away: only a random number');
    await new Promise(resolve => impostor.close(resolve));

    await options.locator('#app').fill(base);
    await options.locator('#app').dispatchEvent('change');
    await options.locator('#code').fill(code.toLowerCase());
    await options.getByRole('button', { name: 'Connect' }).click();
    await options.locator('#status').filter({ hasText: 'Connected to SuperBookmarks on this computer.' }).waitFor();
    await options.screenshot({ path: join(evidence, 'options-connected.png'), fullPage: true });
    // Settings notices by itself (it looks while a code is shown).
    await card.getByText('● Connected').waitFor({ timeout: 10000 });
    await card.getByLabel('Connected browsers').getByText(process.env.C4_EXTENSION_CHANNEL === 'msedge' ? 'Edge' : 'Chrome').waitFor();
    assert.equal(await card.getByLabel('Pairing code').count(), 0, 'the code is used up');
    await card.screenshot({ path: join(evidence, 'settings-connected.png') });
  });

  await check('the toolbar button opens the Save window; the saved address has no tracking parameters', async () => {
    const [popup] = await Promise.all([context.waitForEvent('page'),
      worker.evaluate(() => sbm.openSaveWindow('https://walks.example.invalid/ten-walks?utm_source=newsletter&id=7&fbclid=abc#top', 'Ten walks'))]);
    await popup.waitForLoadState();
    assert.ok(popup.url().startsWith(base + '/add?url='));
    await popup.getByRole('button', { name: /^Save/ }).first().click();
    await popup.getByText('Saved', { exact: true }).waitFor();
    await popup.screenshot({ path: join(evidence, 'save-window.png') });
    const saved = (await library()).find(p => p.url.startsWith('https://walks.example.invalid/'));
    assert.equal(saved.url, 'https://walks.example.invalid/ten-walks?id=7#top');
    assert.equal(saved.title, 'Ten walks');
    await popup.close();
  });

  /** What a click on the toolbar button does on this page (the click itself is the browser's): the tab is read
   *  when it is X, Instagram or TikTok, then the Save window opens. */
  async function toolbar(url) {
    const tab = await context.newPage();
    await tab.goto(url);
    await tab.bringToFront();
    const [popup] = await Promise.all([context.waitForEvent('page'),
      worker.evaluate(async ({ url, title }) => {
        // The tab by its address where the extension may see it (the three sites), else the one in front.
        const tab = (await chrome.tabs.query({})).find(t => t.url === url) ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
        await sbm.saveFromTab({ id: tab.id, url, title });
      }, { url, title: await tab.title() })]);
    await popup.waitForLoadState();
    return { tab, popup };
  }

  await check('the toolbar button on an X search page: the Save window lists the posts loaded there', async () => {
    const { tab, popup } = await toolbar(pages.X_FEED_URL);
    assert.ok(popup.url().endsWith('&from=extension'), popup.url());
    await popup.getByRole('tab', { name: 'Posts on this page (4)', selected: true }).waitFor();
    await popup.getByRole('checkbox', { name: /Mara Quinn/ }).check();
    await popup.getByRole('checkbox', { name: /Juniper Wells/ }).check();
    await popup.screenshot({ path: join(evidence, 'posts-from-x.png') });
    await popup.getByRole('button', { name: 'Save 2 posts' }).click();
    await popup.getByText('Saved 2 posts').waitFor();
    const urls = (await library()).map(p => p.url);
    assert.ok(urls.includes('https://x.com/maraquinn/status/1849000000000000001') && urls.includes('https://x.com/JuniperBakes/status/1848700000000000004'), JSON.stringify(urls));
    assert.ok(!urls.some(u => u.startsWith('https://x.com/search')), 'the search page itself is not saved');
    await tab.close();
  });

  await check('the toolbar button on an open Instagram post: its caption and pictures come with it', async () => {
    const { tab, popup } = await toolbar(pages.IG_POST_URL);
    assert.ok(popup.url().startsWith(`${base}/add?url=${encodeURIComponent('https://www.instagram.com/p/CfixTure123/')}&`), popup.url());
    const card = popup.getByLabel('The Instagram post');
    await card.getByText('Slow rise rye, day three. Recipe in the comments.').waitFor();
    await card.getByText('2 pictures and the caption will be saved with the link.', { exact: false }).waitFor();
    assert.equal(await popup.getByLabel('Title').inputValue(), 'Ana Field Notes on Instagram');
    await popup.getByRole('button', { name: 'Save', exact: true }).click();
    await popup.getByText('Saved', { exact: true }).waitFor();
    assert.ok((await library()).some(p => p.url === 'https://www.instagram.com/p/CfixTure123/' && p.title === 'Ana Field Notes on Instagram'));
    await tab.close();
  });

  await check('the toolbar button on a TikTok video: the window shows the video it read', async () => {
    const { tab, popup } = await toolbar(pages.TT_VIDEO_URL);
    const card = popup.getByLabel('The TikTok post');
    await card.getByText('Rye crackers from leftover starter #sourdough').waitFor();
    await card.getByText('Juniper Wells').waitFor();
    await card.getByText('A video.', { exact: false }).waitFor();
    assert.ok(popup.url().startsWith(`${base}/add?url=${encodeURIComponent('https://www.tiktok.com/@juniperbakes/video/7430000000000000001')}&`), 'saved without the tracking');
    assert.equal(await popup.getByLabel('Title').inputValue(), '@juniperbakes on TikTok', 'the name the library gives it, not the tab\'s');
    await popup.close();
    await tab.close();
  });

  await check('anywhere else the toolbar button reads nothing and opens the plain Save window', async () => {
    await context.route('https://walks.example.invalid/**', route => route.fulfill({ status: 200, contentType: 'text/html',
      body: '<title>Ten walks</title><article><a href="https://x.com/someone/status/123">a post</a></article>' }));
    const { tab, popup } = await toolbar('https://walks.example.invalid/ten');
    assert.ok(!popup.url().includes('from=extension'), popup.url());
    assert.equal(await popup.getByLabel('Title').inputValue(), 'Ten walks');
    await popup.close();
    await tab.close();
  });

  await check('the check mark: on a saved page with the switch on, and nowhere else', async () => {
    const page = await context.newPage();
    await page.goto(base + '/library');
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url).id, base + '/library');
    const badge = () => worker.evaluate(async id => [await chrome.action.getBadgeText({ tabId: id }), await chrome.action.getTitle({ tabId: id })], tabId);
    await worker.evaluate(id => sbm.checkTab(id, 'https://bread.example.invalid/slow-bread'), tabId);
    assert.deepEqual(await badge(), ['', 'Save to SuperBookmarks'], 'off by default: nothing is asked');
    await worker.evaluate(() => chrome.storage.local.set({ checkMark: true }));
    // Turning it on checks the tab's real page (the library, not saved) by itself: let that finish first.
    await new Promise(r => setTimeout(r, 700));
    await worker.evaluate(id => sbm.checkTab(id, 'https://bread.example.invalid/slow-bread'), tabId);
    assert.deepEqual(await badge(), ['✓', 'SuperBookmarks: already saved, on food']);
    await worker.evaluate(id => sbm.checkTab(id, 'https://elsewhere.example.invalid/'), tabId);
    assert.deepEqual(await badge(), ['', 'Save to SuperBookmarks'], 'not saved: no check mark');
    // The app stopped: no check mark and no message.
    server.kill();
    await new Promise(r => setTimeout(r, 500));
    await worker.evaluate(id => sbm.checkTab(id, 'https://bread.example.invalid/slow-bread'), tabId);
    assert.deepEqual(await badge(), ['', 'Save to SuperBookmarks']);
    server = startServer(); server.stderr.on('data', c => { serverLog += c; });
    await up();
    await page.close();
  });

  // The Download buttons sit in a closed shadow root (the site's scripts can't read which posts are saved):
  // the test reads their labels from the browser's accessibility tree.
  const isDownloadButton = n => n.role?.value === 'button' && /SuperBookmarks|Already saved/.test(n.name?.value ?? '');
  const buttonNames = async page => {
    const cdp = await context.newCDPSession(page);
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    await cdp.detach();
    return nodes.filter(isDownloadButton).map(n => n.name.value);
  };
  // What each one draws, reached from the same tree: a picture outside the SVG namespace takes no room at all,
  // and the button is an empty circle whatever its label says.
  const buttonPictures = async page => {
    const cdp = await context.newCDPSession(page);
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const pictures = [];
    for (const n of nodes.filter(isDownloadButton)) {
      const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: n.backendDOMNodeId });
      const { result } = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, returnByValue: true, functionDeclaration:
        'function () { const picture = this.firstElementChild, box = picture.getBoundingClientRect(); return [picture.namespaceURI, box.width, box.height]; }' });
      pictures.push(result.value);
    }
    await cdp.detach();
    return pictures;
  };

  await check('Download buttons: none until switched on for a site; then one per post, and a click opens the Save window for that post', async () => {
    const feed = await context.newPage();
    await feed.goto(pages.X_FEED_URL);
    await feed.waitForTimeout(800);
    assert.equal(await feed.locator('[data-sbm-mark]').count(), 0, 'off by default');
    await options.reload();
    const x = options.getByRole('switch', { name: 'X' });
    assert.equal(await x.getAttribute('aria-checked'), 'false');
    await options.getByText('Asks your browser for x.com and twitter.com when you turn it on').waitFor();
    await x.click();
    await options.getByText('Allowed: x.com and twitter.com').waitFor();
    assert.equal(await options.getByRole('switch', { name: 'Instagram' }).getAttribute('aria-checked'), 'false', 'one site at a time');
    await options.screenshot({ path: join(evidence, 'options-download-buttons.png'), fullPage: true });
    // The tab already open gets them now; one per post card.
    await feed.locator('[data-sbm-mark]').first().waitFor({ timeout: 10000 });
    assert.equal(await feed.locator('[data-sbm-mark]').count(), 5);
    await feed.evaluate(() => { window.cardClicks = 0; document.querySelectorAll('article').forEach(a => a.addEventListener('click', () => window.cardClicks++)); });
    // A click made up by the page's own script does nothing.
    await feed.evaluate(() => document.querySelector('[data-sbm-mark]').click());
    await feed.waitForTimeout(1000);
    assert.equal(context.pages().filter(p => p.url().includes('/add?')).length, 0, 'no Save window from a script\'s click');
    await feed.bringToFront();
    await feed.screenshot({ path: join(evidence, 'download-buttons.png') });
    const [popup] = await Promise.all([context.waitForEvent('page'), feed.locator('[data-sbm-mark]').nth(2).click()]);
    await popup.waitForLoadState();
    assert.ok(popup.url().startsWith(`${base}/add?url=${encodeURIComponent('https://x.com/tferreira/status/1848800000000000003')}&title=&from=extension`), popup.url());
    const card = popup.getByLabel('The X post');
    await card.getByText('Tomás Ferreira').waitFor();
    await card.getByText('A video.', { exact: false }).waitFor();
    assert.equal(await popup.getByLabel('Title').inputValue(), '@tferreira on X', 'a post from a feed comes with no title: it gets the library\'s name');
    assert.equal(await feed.evaluate(() => window.cardClicks), 0, 'the click on the button never reaches the post (which would open it)');
    await popup.getByRole('button', { name: 'Save', exact: true }).click();
    await popup.getByText('Saved', { exact: true }).waitFor();
    const saved = (await library()).find(p => p.url === 'https://x.com/tferreira/status/1848800000000000003');
    assert.equal(saved?.title, '@tferreira on X');
    assert.notEqual(saved?.fieldSources?.title, 'user', 'not taken for a title the owner typed');
    await feed.close();
  });

  await check('with the check mark on, the buttons of posts already saved turn green; off, they all look the same', async () => {
    const feed = await context.newPage();
    await feed.goto(pages.X_FEED_URL);
    await feed.locator('[data-sbm-mark]').first().waitFor({ timeout: 10000 });
    const greens = async () => (await buttonNames(feed)).map(n => n.startsWith('Already saved'));
    try {
      await worker.evaluate(() => chrome.storage.local.set({ checkMark: false }));
      await feed.reload();
      await feed.locator('[data-sbm-mark]').first().waitFor({ timeout: 10000 });
      await feed.waitForTimeout(800);
      assert.deepEqual([...new Set(await buttonNames(feed))], ['Save to SuperBookmarks']);
    } finally {
      await worker.evaluate(() => chrome.storage.local.set({ checkMark: true }));
    }
    await feed.reload();
    await feed.locator('[data-sbm-mark]').first().waitFor({ timeout: 10000 });
    // Mara Quinn's and Tomás Ferreira's posts were saved above (the second post of Mara's is the same post).
    for (let i = 0; i < 50 && (await greens()).filter(Boolean).length < 4; i++) await feed.waitForTimeout(200);
    assert.deepEqual(await greens(), [true, false, true, true, true], JSON.stringify(await buttonNames(feed)));
    assert.equal(await feed.evaluate(() => window.find('✓')), false, 'the check is drawn, not text the page could search for');
    await feed.screenshot({ path: join(evidence, 'download-buttons-saved.png') });
    // A focus event the page makes up asks nothing: switched off, the green stays until a real return to the tab.
    await worker.evaluate(() => chrome.storage.local.set({ checkMark: false }));
    await feed.evaluate(() => { for (let i = 0; i < 20; i++) window.dispatchEvent(new Event('focus')); });
    await feed.waitForTimeout(1500);
    assert.deepEqual(await greens(), [true, false, true, true, true]);
    await worker.evaluate(() => chrome.storage.local.set({ checkMark: true }));
    await feed.close();
  });

  await check('the Download buttons draw their picture: the logo, and the tick on a post already saved', async () => {
    const feed = await context.newPage();
    await feed.goto(pages.X_FEED_URL);
    await feed.locator('[data-sbm-mark]').first().waitFor({ timeout: 10000 });
    for (let i = 0; i < 50 && (await buttonNames(feed)).filter(n => n.startsWith('Already saved')).length < 4; i++) await feed.waitForTimeout(200);
    const SVG = 'http://www.w3.org/2000/svg', logo = [SVG, 16, 16], tick = [SVG, 14, 14];
    assert.deepEqual(await buttonPictures(feed), [tick, logo, tick, tick, tick]);
    await feed.close();
  });

  await check('TikTok, 2026 layout: no button on a For You video (it has no address there); the open video\'s button saves it', async () => {
    // The owner's report (2026-11-03): on TikTok the Download button did nothing.
    const tiktok = options.getByRole('switch', { name: 'TikTok' });
    await options.reload();
    if (await tiktok.getAttribute('aria-checked') !== 'true') await tiktok.click();
    await options.getByText('Allowed: tiktok.com').waitFor();
    try {
      const feed = await context.newPage();
      await feed.goto(pages.TT_FOR_YOU_URL);
      await feed.waitForTimeout(1500);
      assert.equal(await feed.locator('[data-sbm-mark]:visible').count(), 0, 'no button that would do nothing');
      // The toolbar button there: nothing to list, and the Save window says where TikTok videos can be saved from.
      const [plain] = await Promise.all([context.waitForEvent('page'), worker.evaluate(url => sbm.openSaveWindow(url, 'TikTok - Make Your Day'), pages.TT_FOR_YOU_URL)]);
      await plain.waitForLoadState();
      await plain.getByText("TikTok's For You feed doesn't show each video's own address", { exact: false }).waitFor();
      await plain.close();
      await feed.goto(pages.TT_CINEMA_URL);
      await feed.locator('[data-sbm-mark]:visible').first().waitFor({ timeout: 10000 });
      assert.equal(await feed.locator('[data-sbm-mark]:visible').count(), 2, 'the open video and the related one');
      const [popup] = await Promise.all([context.waitForEvent('page'), feed.locator('[data-sbm-mark]:visible').first().click()]);
      await popup.waitForLoadState();
      assert.ok(popup.url().startsWith(`${base}/add?url=${encodeURIComponent(pages.TT_CINEMA_URL)}`), popup.url());
      await popup.getByLabel('The TikTok post').getByText('Juniper Wells').waitFor();
      await popup.close();
      await feed.close();
    } finally {
      await tiktok.click();
    }
  });

  await check('Instagram reels, 2026: a button on the reel in view and on a reel opened in a dialog; a click opens its Save window', async () => {
    // The owner's report (2026-11-08): in Instagram's reels the Download button doesn't show. The Reels tab has no
    // <article>s, and a reel's own page shows it in a dialog that cuts off its article's corner.
    const instagram = options.getByRole('switch', { name: 'Instagram' });
    await options.reload();
    if (await instagram.getAttribute('aria-checked') !== 'true') await instagram.click();
    await options.getByText('Allowed: instagram.com').waitFor();
    const tab = await context.newPage();
    try {
      await tab.goto(pages.IG_REELS_TAB_URL);
      await tab.locator('[data-sbm-mark]:visible').first().waitFor({ timeout: 10000 });
      assert.equal(await tab.locator('[data-sbm-mark]:visible').count(), 1, 'one button: on the reel in view, none on audio links');
      const [popup] = await Promise.all([context.waitForEvent('page'), tab.locator('[data-sbm-mark]:visible').first().click()]);
      await popup.waitForLoadState();
      assert.ok(popup.url().startsWith(`${base}/add?url=${encodeURIComponent('https://www.instagram.com/reel/CreelAAA11/')}&`), popup.url());
      await popup.getByLabel('The Instagram post').getByText('Proofing in the fridge overnight').waitFor();
      assert.equal(await popup.getByLabel('Title').inputValue(), 'kit.a on Instagram', 'named after its creator, not "Instagram"');
      await popup.close();
      // Scrolling on, Instagram gives the page the next reel's address: the button moves to that reel.
      await tab.evaluate(() => { history.replaceState(null, '', '/reels/CreelBBB22/'); scrollTo(0, innerHeight); });
      await tab.waitForFunction(() => {
        const shown = [...document.querySelectorAll('[data-sbm-mark]')].filter(host => getComputedStyle(host).display !== 'none');
        return shown.length === 1 && shown[0].closest('.reel-box') === document.querySelectorAll('.reel-box')[1];
      }, null, { timeout: 5000 });
      await tab.goto(pages.IG_REEL_DIALOG_URL);
      await tab.locator('[data-sbm-mark]:visible').first().waitFor({ timeout: 10000 });
      const [dialog] = await Promise.all([context.waitForEvent('page'), tab.locator('[data-sbm-mark]:visible').first().click()]);
      await dialog.waitForLoadState();
      assert.ok(dialog.url().startsWith(`${base}/add?url=${encodeURIComponent(pages.IG_REEL_DIALOG_URL)}&`), dialog.url());
      const card = dialog.getByLabel('The Instagram post');
      await card.getByText('Shaping a batard').waitFor();
      // Its cover from the page's tags (they are the reel's here); the page holds no file of the video.
      await card.getByText("The cover picture and the caption will be saved with the link. They come from your tab: SuperBookmarks doesn't contact Instagram. "
        + "The page doesn't hold the video's file, so the video isn't kept.").waitFor({ timeout: 20000 });
      await dialog.close();
    } finally {
      await tab.close();
      await instagram.click();
    }
  });

  await check('switching a site off: the buttons leave its open tabs, and its posts get none any more', async () => {
    const open = await context.newPage();
    await open.goto(pages.X_FEED_URL);
    await open.locator('[data-sbm-mark]').first().waitFor({ timeout: 10000 });
    await options.reload();
    const x = options.getByRole('switch', { name: 'X' });
    await options.getByText('Allowed: x.com and twitter.com').waitFor();
    await x.click();
    await open.waitForFunction(() => !document.querySelector('[data-sbm-mark]'), null, { timeout: 5000 });
    await open.close();
    await options.getByText('Asks your browser for x.com and twitter.com when you turn it on').waitFor();
    await worker.evaluate(() => sbm.syncMarks());
    assert.deepEqual(await worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map(s => s.id)), []);
    const feed = await context.newPage();
    await feed.goto(pages.X_FEED_URL);
    await feed.waitForTimeout(1000);
    assert.equal(await feed.locator('[data-sbm-mark]').count(), 0);
    await feed.close();
  });

  await check('another program on the app\'s address gets neither the token nor the page address', async () => {
    // It answers everything, claims every page is saved, and fakes the proof.
    const seen = [];
    const impostor = createServer((req, res) => {
      seen.push({ url: req.url, token: req.headers['x-sbm-pair'] });
      if (req.url.startsWith('/add')) {
        res.setHeader('Content-Type', 'text/html');
        res.end(`<title>Save</title><script>setInterval(() => postMessage({ type: 'sbm-ready' }, location.origin), 200);
          addEventListener('message', e => { if (e.data && e.data.type === 'sbm-posts') fetch('/got-posts'); });</script>`);
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(req.url.startsWith('/api/extension/hello') ? JSON.stringify({ ok: true, proof: '00'.repeat(32) }) : JSON.stringify({ ok: true, saved: true, shelf: 'food' }));
    });
    await new Promise(resolve => impostor.listen(0, '127.0.0.1', resolve));
    const fake = `http://127.0.0.1:${impostor.address().port}`;
    try {
      await worker.evaluate(app => chrome.storage.local.set({ app }), fake);
      const page = await context.newPage();
      await page.goto(base + '/library');
      const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url).id, base + '/library');
      await worker.evaluate(id => sbm.checkTab(id, 'https://bread.example.invalid/slow-bread'), tabId);
      assert.equal(await worker.evaluate(id => chrome.action.getBadgeText({ tabId: id }), tabId), '');
      assert.ok(seen.length >= 1 && seen.every(r => r.url.startsWith('/api/extension/hello') && !r.token), JSON.stringify(seen));
      assert.ok(seen.every(r => !r.url.includes('bread')), 'the page address never reached it (the check mark asks by itself)');
      await options.reload();
      await options.locator('#status').filter({ hasText: 'Something else is answering at this app address' }).waitFor();
      await page.close();
      // The toolbar on a feed: the app's address isn't opened at all, so no page of that program loads in this browser.
      const { tab, popup } = await toolbar(pages.X_FEED_URL);
      assert.match(popup.url(), /kept\.html#list&why=impostor/);
      await popup.getByText('Something other than SuperBookmarks is answering at the app address').waitFor();
      await popup.close().catch(() => {});
      await tab.close();
      // A page or a link: it waits in the extension, and says why.
      const kept = context.waitForEvent('page');
      await worker.evaluate(() => sbm.openSaveWindow('https://bread.example.invalid/slow-bread', 'Slow bread'));
      const note = await kept;
      await note.getByText('Something other than SuperBookmarks is answering at the app address').waitFor();
      assert.deepEqual((await worker.evaluate(() => sbm.readQueue())).items.map(item => item.url), ['https://bread.example.invalid/slow-bread']);
      await note.close().catch(() => {});
      await worker.evaluate(async () => { await chrome.storage.local.remove('queue'); await chrome.action.setBadgeText({ text: '' }); });
      assert.ok(seen.every(r => r.url.startsWith('/api/extension/hello')), JSON.stringify(seen));
    } finally {
      await worker.evaluate(app => chrome.storage.local.set({ app }), base);
      impostor.close();
    }
  });

  await check('a program that passes on the real app\'s proof from another port still gets nothing', async () => {
    // It forwards the proof request to the real app (now on another port) and answers with its proof.
    const seen = [];
    const relay = createServer(async (req, res) => {
      seen.push({ url: req.url, token: req.headers['x-sbm-pair'] });
      if (req.url.startsWith('/api/extension/hello')) {
        const answer = await fetch(base + req.url, { headers: { Host: req.headers.host } }).catch(() => null);
        res.writeHead(answer ? answer.status : 502, { 'Content-Type': 'application/json' });
        res.end(answer ? await answer.text() : '{}');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, saved: true, shelf: 'food', items: [] }));
    });
    await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve));
    const fake = `http://127.0.0.1:${relay.address().port}`;
    try {
      await worker.evaluate(app => chrome.storage.local.set({ app }), fake);
      const page = await context.newPage();
      await page.goto(base + '/library');
      const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url).id, base + '/library');
      await worker.evaluate(id => sbm.checkTab(id, 'https://bread.example.invalid/slow-bread'), tabId);
      assert.equal(await worker.evaluate(id => chrome.action.getBadgeText({ tabId: id }), tabId), '');
      assert.deepEqual(await worker.evaluate(() => sbm.savedPosts(['https://x.com/maraquinn/status/1849000000000000001'])), null);
      assert.ok(seen.length >= 2 && seen.every(r => r.url.startsWith('/api/extension/hello') && !r.token), JSON.stringify(seen));
      await options.reload();
      await options.locator('#status').filter({ hasText: 'Something else is answering at this app address' }).waitFor();
      await page.close();
    } finally {
      await worker.evaluate(app => chrome.storage.local.set({ app }), base);
      relay.close();
    }
  });

  await check('disconnecting in Settings: the extension can no longer ask', async () => {
    await settings.reload();
    const card = settings.getByLabel('SuperBookmarks extension');
    await card.getByLabel('Connected browsers').getByRole('button', { name: 'Disconnect' }).click();
    await card.getByText('○ Not connected yet').waitFor();
    await options.reload();
    await options.locator('#status').filter({ hasText: "doesn't know this browser any more" }).waitFor();
  });

  await check('the page structure for support: what the page is built of, and nothing it says, links to or names', async () => {
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.getByText('For support').click();     // folded away until asked for
    await options.locator('#structureMenu').click();
    assert.equal((await worker.evaluate(() => chrome.storage.local.get('structureMenu'))).structureMenu, true, 'the switch is kept');
    const tab = await context.newPage();
    await tab.goto(pages.X_FEED_URL);
    const page = await tab.evaluate(() => ({
      handles: [...new Set([...document.querySelectorAll('a[href]')].map(a => new URL(a.href).pathname.split('/')[1]).filter(h => h && h.length > 2))],
      words: document.body.innerText.split(/\s+/).filter(word => /^[A-Za-z]{6,}$/.test(word)),
      pictures: [...document.querySelectorAll('img')].map(img => img.getAttribute('src')).filter(Boolean),
      structure: [...new Set([...document.querySelectorAll('*')].flatMap(el => [el.localName, ...el.classList, el.getAttribute('data-testid'),
        el.getAttribute('data-e2e'), el.getAttribute('role')]).filter(Boolean).join(' ').toLowerCase().split(/[^a-z]+/))],
    }));
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url).id, pages.X_FEED_URL);
    const [shown] = await Promise.all([context.waitForEvent('page'), worker.evaluate(id => sbm.copyStructure(id), tabId)]);
    await shown.waitForLoadState();
    const text = await shown.locator('#text').inputValue();
    assert.match(text, /^SuperBookmarks page structure/);
    assert.match(text, /\[testid=tweet\]/, 'the test ids the readers look for');
    assert.match(text, /\[role=article\]|article/);
    assert.match(text, /readers: one post: none; posts on the page: [1-9]/, 'what the readers made of it, as counts');
    assert.match(text, /more like this/, 'a feed shows one post whole');
    assert.ok(page.handles.length >= 2 && page.words.length > 10, 'the stand-in page has names and words to leave out');
    for (const handle of page.handles) assert.ok(!text.toLowerCase().includes(handle.toLowerCase()), `no ${handle}`);
    for (const word of page.words) assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(text) || page.structure.includes(word.toLowerCase()), `no text: ${word}`);
    for (const picture of page.pictures) assert.ok(!text.includes(picture), 'no picture addresses');
    assert.ok(!/https?:\/\//.test(text), 'no addresses at all');
    assert.equal((await worker.evaluate(() => chrome.storage.local.get('snapshot'))).snapshot, undefined, 'shown once, not kept');
    await shown.close();
    await tab.close();
    await options.locator('#structureMenu').click();
  });

  await check('the page structure says where the Download buttons are: shown, or covered and by what', async () => {
    // The owner's report (2026-11-08): in Instagram's reels the buttons don't show. They were on the page, so something
    // covers them; the structure names it (its tags and classes, position and z-index), never what it says.
    const instagram = options.getByRole('switch', { name: 'Instagram' });
    await options.goto(`chrome-extension://${extensionId}/options.html`);
    await options.getByText('For support').click();
    if (await options.locator('#structureMenu').getAttribute('aria-checked') !== 'true') await options.locator('#structureMenu').click();
    if (await instagram.getAttribute('aria-checked') !== 'true') await instagram.click();
    await options.getByText('Allowed: instagram.com').waitFor();
    const tab = await context.newPage();
    try {
      await tab.goto(pages.IG_REELS_URL);
      await tab.locator('[data-sbm-mark]').first().waitFor({ timeout: 10000 });
      const snapshotOf = async address => {
        const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url).id, address);
        const [shown] = await Promise.all([context.waitForEvent('page'), worker.evaluate(id => sbm.copyStructure(id), tabId)]);
        await shown.waitForLoadState();
        const text = await shown.locator('#text').inputValue();
        await shown.close();
        return text;
      };
      const snapshot = () => snapshotOf(pages.IG_REELS_URL);
      assert.match(await snapshot(), /download buttons: 2 \(2 shown\)/);
      // What Instagram's reels seem to do: a layer over the whole reel, after the button.
      await tab.evaluate(() => document.querySelectorAll('article').forEach(a =>
        a.insertAdjacentHTML('beforeend', '<div class="reel-layer x10l6tqk" style="position:absolute;inset:0;z-index:5"></div>')));
      const text = await snapshot();
      assert.match(text, /download buttons: 2 \(2 covered\)/);
      assert.match(text, /sbm-download-button \(covered by div\.reel-layer\.x10l6tqk \[position:absolute, z-index:5\]\)/);
      assert.ok(!/bakehouse|otherbaker|https?:\/\//i.test(text), 'still no names or addresses');
      // The owner's reels (2026-11-08): in the Reels tab the reel in view has the one button, over the player's own layers;
      // a reel opened in a dialog has it on its video, inside what the dialog shows (it was cut off with the article's corner).
      await tab.goto(pages.IG_REELS_TAB_URL);
      await tab.locator('[data-sbm-mark]').first().waitFor({ state: 'attached', timeout: 10000 });
      await tab.waitForTimeout(800);
      assert.match(await snapshotOf(pages.IG_REELS_TAB_URL), /download buttons: 3 \(1 shown, 2 hidden\)/);
      await tab.goto(pages.IG_REEL_DIALOG_URL);
      await tab.locator('[data-sbm-mark]').first().waitFor({ state: 'attached', timeout: 10000 });
      await tab.waitForTimeout(800);
      assert.match(await snapshotOf(pages.IG_REEL_DIALOG_URL), /download buttons: 1 \(1 shown\)/);
    } finally {
      await tab.close();
      await instagram.click();
      await options.locator('#structureMenu').click();
    }
  });

  await check('no page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await context.close();
  server.kill();
}
if (failures.length) { console.error(`FAILED ${failures.length} | evidence: ${evidence}`); if (serverLog.includes('Traceback')) console.error(serverLog.slice(-2000)); process.exit(1); }
console.log(`ALL PASS | evidence: ${evidence}`);
