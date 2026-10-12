// The bookmark button, end to end in a real browser: the Settings card, the
// Save window it opens, saving, "already saved", and Instagram posts (read in
// the post's tab, handed over by postMessage). Synthetic data only: a local
// page plays "a website", and Instagram's address is answered by Playwright
// with a synthetic post page; the app server never contacts Instagram.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(join(root, '.verify'), { recursive: true });
const evidence = await mkdtemp(join(root, '.verify', 'bookmark-button-'));
const port = 15000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const IG_POST = 'https://www.instagram.com/p/CfixTure123/';
const IG_OLD = 'https://www.instagram.com/p/OldPost4567/';
const HOSTILE = 'Synthetic page <img src=x onerror="document.title=\'PWNED\'"> & more';

const server = spawn(process.env.C4_PYTHON || 'python3', ['-B', '-c', `
import base64, os, sys
sys.path.insert(0, ${JSON.stringify(root)})
sys.path.insert(0, ${JSON.stringify(join(root, 'frontend', 'tests'))})
os.environ["SAVED_POSTS_DB_PATH"] = ${JSON.stringify(join(evidence, 'fixture.sqlite'))}
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
    return jsonify(seen=seen, site=[r[0] for r in site.requests])
app.app.run(host="127.0.0.1", port=${port}, debug=False)
`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
let serverLog = ''; server.stderr.on('data', chunk => { serverLog += chunk; });

// "A website" on another origin.
const sitePort = 15000 + Math.floor(Math.random() * 20000);
const siteServer = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>${HOSTILE.replace(/</g, '&lt;')}</title><h1>Article</h1><p id="quote">Forty thousand tapes, one owner.</p>`);
}).listen(sitePort, '127.0.0.1');
const SITE_URL = `http://127.0.0.1:${sitePort}/2026/rental-shop`;

const PNG200 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAIAAAAiOjnJAAABdklEQVR42u3SMREAMAgAsVJdCEMisjDBwJBI+PvoygfbvgQYC2NhLDAWxsJYYCyMhbHAWBgLY4GxMBbGAmNhLIwFxsJYGAuMhbEwFhgLY2EsMBbGwlhgLIyFscBYGAtjgbEwFsYCY2EsjAXGwlgYC4yFsTAWGAtjYSwwFsbCWGAsjIWxwFgYC2OBsTAWxgJjYSyMBcbCWBgLjIWxMBYYC2NhLDAWxsJYYCyMhbHAWBgLY4GxMBbGwlhgLIyFscBYGAtjgbEwFsYCY2EsjAXGwlgYC4yFsTAWGAtjYSwwFsbCWGAsjIWxwFgYC2OBsTAWxgJjYSyMBcbCWBgLjIWxMBYYC2NhLDAWxsJYYCyMhbHAWBgLY4GxMBbGAmNhLIwFxsJYGAuMhbEwFhgLY2EsMBbGwlhgLIyFscBYGAtjgbEwFsYCY2EsjIWxwFgYC2OBsTAWxgJjYSyMBcbCWBgLjIWxMBYYC2NhLDAWxsJYYCyMhbHAWFwz2aMDDGxvi+sAAAAASUVORK5CYII=', 'base64');
const igPage = (code, caption) => `<!doctype html><html><head><title>Instagram</title>
<meta property="og:title" content="Ana Field Notes on Instagram: &quot;${caption}&quot;"><meta property="og:image" content="https://scontent.cdninstagram.com/v/og.jpg"></head>
<body><main><article><header><img alt="fieldnotes_ana's profile picture" src="https://scontent.cdninstagram.com/v/avatar.jpg" width="32">
<a href="/fieldnotes_ana/">fieldnotes_ana</a></header>
<div><img alt="Photo 1" srcset="https://scontent.cdninstagram.com/v/one_320.jpg 320w, https://scontent.cdninstagram.com/v/one_1080.jpg 1080w" src="https://scontent.cdninstagram.com/v/one_320.jpg"></div>
<div><img alt="Photo 2" src="https://scontent.cdninstagram.com/v/two_1080.jpg"></div>
<img alt="tracker" src="https://evil.invalid/pixel.jpg">
<h1>${caption}</h1><time datetime="2026-10-04T07:52:00.000Z">4 Oct</time></article></main></body></html>`;

const browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message.split('\n').slice(0, 6).join(' | ')}`); }
}
try {
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { try { up = (await fetch(base + '/api/stats')).ok; } catch {} if (!up) await new Promise(r => setTimeout(r, 100)); }
  assert.ok(up, 'server did not start: ' + serverLog.slice(-400));
  const api = async (path, init) => (await fetch(base + path, init)).json();
  const linkByUrl = async url => (await api('/api/library')).posts.find(p => p.url === url);
  const until = async (what, test, ms = 20000) => {
    const end = Date.now() + ms; let last;
    while (Date.now() < end) { last = await test(); if (last) return last; await new Promise(r => setTimeout(r, 150)); }
    throw new Error(`timed out waiting for ${what}`);
  };
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('https://www.instagram.com/**', route => {
    const url = route.request().url();
    const code = url.includes('OldPost4567') ? 'OldPost4567' : 'CfixTure123';
    route.fulfill({ status: 200, contentType: 'text/html', body: igPage(code, code === 'OldPost4567' ? 'An older walk' : 'Winter hedgerow walk &lt;b&gt;bold&lt;/b&gt; #birds') });
  });
  await context.route('https://scontent.cdninstagram.com/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: PNG200 }));
  await context.route('https://evil.invalid/**', route => route.fulfill({ status: 200, contentType: 'image/png', body: PNG200 }));
  const page = await context.newPage();
  const errors = []; context.on('page', p => p.on('pageerror', e => errors.push(e.message))); page.on('pageerror', e => errors.push(e.message));
  let source = '';

  await check('Settings offers the button for this address and warns that the address moved', async () => {
    await page.goto(base + '/library/settings#sources');
    const card = page.locator('section[aria-labelledby="save-from-browser-heading"]');
    await card.waitFor();
    const href = await card.getByTitle('Drag me to the bookmarks bar').getAttribute('href');
    assert.ok(href.startsWith('javascript:'));
    source = decodeURIComponent(href.slice('javascript:'.length));
    assert.ok(source.includes(`"${base}"`), 'the button points at this running app');
    assert.ok(!source.includes('cookie') && !source.includes('localStorage'), 'the button never reads logins or storage');
    await card.getByText(/The app is on a different address today/).waitFor();     // this test's port is not 5001
    await card.screenshot({ path: join(evidence, 'settings-card.png') });
  });

  const click = async target => {
    const [popup] = await Promise.all([context.waitForEvent('page'), target.evaluate(code => { (0, eval)(code); }, source)]);
    await popup.waitForLoadState();
    return popup;
  };

  await check('on a page, the window opens prefilled (nothing saved yet), escapes the title and saves on Save', async () => {
    const site = await context.newPage();
    await site.goto(SITE_URL);
    await site.evaluate(() => { const range = document.createRange(); range.selectNodeContents(document.getElementById('quote')); getSelection().addRange(range); });
    const popup = await click(site);
    assert.ok(popup.url().startsWith(base + '/add?url='));
    await popup.getByRole('textbox', { name: 'Title' }).waitFor();
    assert.equal(await popup.getByRole('textbox', { name: 'Title' }).inputValue(), HOSTILE);
    assert.equal(await popup.getByRole('textbox', { name: 'Note' }).inputValue(), 'Forty thousand tapes, one owner.');
    assert.equal(await popup.locator('img[src="x"]').count(), 0, 'the title is text, never markup');
    assert.equal(await popup.title(), 'Save to SuperBookmarks', 'no script from the title ran');
    assert.equal(await linkByUrl(SITE_URL), undefined, 'opening the window saved nothing');
    await popup.screenshot({ path: join(evidence, 'window-new.png') });
    await popup.getByRole('radio', { name: 'Reference' }).click();
    await popup.getByRole('textbox', { name: 'Tags' }).fill('Video, #shops, video');
    await popup.getByRole('button', { name: 'Save', exact: true }).click();
    await popup.getByText('Saved', { exact: true }).waitFor();
    await popup.waitForEvent('close', { timeout: 6000 });
    const saved = await linkByUrl(SITE_URL);
    assert.equal(saved.title, HOSTILE);
    assert.equal(saved.userNotes, 'Forty thousand tapes, one owner.');
    assert.deepEqual([saved.status, saved.tags], ['reference', ['video', 'shops']]);
    await site.close();
  });

  await check('clicking it again on the same page says it is already saved and adds nothing', async () => {
    const site = await context.newPage();
    await site.goto(SITE_URL);
    const popup = await click(site);
    await popup.getByText('Already in your library').waitFor();
    await popup.getByRole('textbox', { name: 'Add tags' }).fill('later');
    await popup.getByRole('button', { name: 'Update tags' }).click();
    await popup.getByText('Tags updated.').waitFor();
    const all = (await api('/api/library')).posts.filter(p => p.url === SITE_URL);
    assert.equal(all.length, 1);
    assert.deepEqual(all[0].tags, ['video', 'shops', 'later']);
    await popup.close(); await site.close();
  });

  await check('on an Instagram post, the window gets the caption and pictures from the tab and saves them', async () => {
    const ig = await context.newPage();
    await ig.goto(IG_POST);
    const popup = await click(ig);
    const box = popup.getByLabel('The Instagram post');
    await box.waitFor();
    await box.getByText('2 pictures and the caption will be saved with the link.').waitFor();
    await box.getByText('Winter hedgerow walk <b>bold</b> #birds').waitFor();
    await popup.screenshot({ path: join(evidence, 'window-instagram.png') });
    await popup.getByRole('button', { name: 'Save', exact: true }).click();
    await popup.getByText('Saved', { exact: true }).waitFor({ timeout: 20000 });
    const saved = await until('the Instagram copy', async () => { const p = await linkByUrl(IG_POST); return p?.archiveStatus === 'saved' && p; });
    assert.equal(saved.thumbnailUrl, '/thumb/CfixTure123');
    const seen = await api('/__seen');
    assert.deepEqual(seen.seen.sort(), ['https://scontent.cdninstagram.com/v/one_1080.jpg', 'https://scontent.cdninstagram.com/v/two_1080.jpg'],
      'the largest picture of each, no avatar, no foreign tracker');
    assert.deepEqual(seen.site, [], 'the app server fetched nothing itself');
    const copy = await (await fetch(`${base}/archive/${saved.archiveKey}`)).text();
    assert.ok(copy.includes('Winter hedgerow walk &lt;b&gt;bold&lt;/b&gt; #birds') && copy.includes('View on Instagram'));
    await ig.close();
  });

  await check('an Instagram link saved earlier without a picture: the panel says how, and the button fills it in', async () => {
    const old = { id: 'ig-old', url: IG_OLD, source: 'manual', platform: 'instagram', domain: 'instagram.com', status: 'inbox', title: 'Instagram post',
      categories: [], tags: [], projectIds: [], createdAt: '2026-09-20T10:00:00Z', updatedAt: '2026-09-20T10:00:00Z', metadataStatus: 'failed' };
    assert.deepEqual((await api('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts: [old], deletedUrls: [] }) })).rejected, []);
    await page.goto(`${base}/library/item/ig-old`);
    const section = page.locator('section[aria-label="Saved copy"]');
    await section.getByText('No picture yet').waitFor();
    await section.getByRole('button', { name: 'Get picture from Instagram' }).waitFor();
    const ig = await context.newPage();
    await ig.goto(IG_OLD);
    const popup = await click(ig);
    await popup.getByText('Picture added').waitFor({ timeout: 20000 });
    const filled = await until('the picture', async () => { const p = await linkByUrl(IG_OLD); return p?.thumbnailUrl === '/thumb/OldPost4567' && p.archiveStatus === 'saved' && p; });
    assert.equal((await api('/api/library')).posts.filter(p => p.url === IG_OLD).length, 1, 'no duplicate');
    assert.equal(filled.title, 'Instagram post', 'the existing link keeps its own fields');
    await popup.close(); await ig.close();
  });

  await check('a window opened with a hostile or empty address saves nothing', async () => {
    for (const bad of ['javascript:alert(1)', '', 'file:///C:/Windows/win.ini']) {
      const p = await context.newPage();
      await p.goto(`${base}/add?url=${encodeURIComponent(bad)}&title=x`);
      await p.getByRole('alert').getByText(/This page's address can't be saved/).waitFor();
      await p.close();
    }
  });

  await check('only the Instagram tab that opened the window can hand it data', async () => {
    // A window opened directly (no opener) on an Instagram address waits briefly, then saves only the link.
    const p = await context.newPage();
    await p.goto(`${base}/add?url=${encodeURIComponent('https://www.instagram.com/p/NoOpener99/')}&title=x`);
    await p.getByText(/The post's caption and pictures didn't come through/).waitFor({ timeout: 10000 });
    await p.evaluate(() => window.postMessage({ type: 'sbm-instagram', post: { caption: 'forged', pictures: [] } }, '*'));
    await p.waitForTimeout(300);
    assert.equal(await p.getByText('forged').count(), 0, 'a message from the app itself (not instagram.com) is ignored');
    await p.close();
  });

  await check('no page errors', async () => { assert.deepEqual(errors.filter(e => !/Failed to load resource/.test(e)), []); });
  await context.close();
} catch (error) {
  failures.push('setup'); console.error('FAIL setup:', error.message);
} finally {
  await browser.close();
  server.kill();
  siteServer.close();
}
console.log(failures.length ? `FAILED ${failures.length} | evidence: ${evidence}` : `ALL PASS | evidence: ${evidence}`);
process.exit(failures.length ? 1 : 0);
