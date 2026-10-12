// Share a shelf, end to end: the Share button, the dialog, the download, and
// the downloaded file opened on its own with every request recorded.
// Synthetic data only: link previews come from the owned loopback fixture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(join(root, '.verify'), { recursive: true });
const evidence = await mkdtemp(join(root, '.verify', 'share-'));
const port = 15000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAIAAAAiOjnJAAABdklEQVR42u3SMREAMAgAsVJdCEMisjDBwJBI+PvoygfbvgQYC2NhLDAWxsJYYCyMhbHAWBgLY4GxMBbGAmNhLIwFxsJYGAuMhbEwFhgLY2EsMBbGwlhgLIyFscBYGAtjgbEwFsYCY2EsjAXGwlgYC4yFsTAWGAtjYSwwFsbCWGAsjIWxwFgYC2OBsTAWxgJjYSyMBcbCWBgLjIWxMBYYC2NhLDAWxsJYYCyMhbHAWBgLY4GxMBbGwlhgLIyFscBYGAtjgbEwFsYCY2EsjAXGwlgYC4yFsTAWGAtjYSwwFsbCWGAsjIWxwFgYC2OBsTAWxgJjYSyMBcbCWBgLjIWxMBYYC2NhLDAWxsJYYCyMhbHAWBgLY4GxMBbGAmNhLIwFxsJYGAuMhbEwFhgLY2EsMBbGwlhgLIyFscBYGAtjgbEwFsYCY2EsjIWxwFgYC2OBsTAWxgJjYSyMBcbCWBgLjIWxMBYYC2NhLDAWxsJYYCyMhbHAWFwz2aMDDGxvi+sAAAAASUVORK5CYII=';

const server = spawn(process.env.C4_PYTHON || 'python3', ['-B', '-c', `
import base64, os, sys
sys.path.insert(0, ${JSON.stringify(root)})
sys.path.insert(0, ${JSON.stringify(join(root, 'frontend', 'tests'))})
os.environ["SAVED_POSTS_DB_PATH"] = ${JSON.stringify(join(evidence, 'fixture.sqlite'))}
os.environ["SBM_AI_CONFIG_FILE"] = ${JSON.stringify(join(evidence, 'ai.json'))}
os.environ["SBM_ARCHIVE_DIR"] = ${JSON.stringify(join(evidence, 'archive'))}
os.environ["SBM_THUMB_CACHE_DIR"] = ${JSON.stringify(join(evidence, 'thumbs'))}
from metadata_fixture import ControlledHTTP
import storage, app, metadata_fetcher
metadata_fetcher.fetch_metadata = lambda url: {"title": "", "summary": "", "thumbnail": "", "status": "empty", "error": ""}
site = ControlledHTTP().__enter__()
png = base64.b64decode("${PNG}")
site.routes["/preview.png"] = (200, {"Content-Type": "image/png"}, png)
os.makedirs(metadata_fetcher.THUMB_CACHE_DIR, exist_ok=True)
open(os.path.join(metadata_fetcher.THUMB_CACHE_DIR, "KeptPic123"), "wb").write(png + b"\\0" * 1200)
storage.init_db()
app.app.run(host="127.0.0.1", port=${port}, debug=False)
`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
let serverLog = ''; server.stderr.on('data', chunk => { serverLog += chunk; });

const browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message.split('\n').slice(0, 6).join(' | ')}`); }
}
const post = (n, changes) => ({
  id: `share-${n}`, url: `https://example.org/${n}`, source: 'manual', platform: 'web', domain: 'example.org', status: 'inbox',
  title: `Link ${n}`, description: `About link ${n}`, categories: ['food-drink'], tags: ['bread'], projectIds: [],
  createdAt: `2026-10-0${n}T10:00:00Z`, updatedAt: `2026-10-0${n}T10:00:00Z`, metadataStatus: 'enriched', ...changes,
});
try {
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { try { up = (await fetch(base + '/api/stats')).ok; } catch {} if (!up) await new Promise(r => setTimeout(r, 100)); }
  assert.ok(up, 'server did not start: ' + serverLog.slice(-400));
  const posts = [
    post(1, { title: 'Focaccia <script>alert(1)</script>', thumbnailUrl: 'http://cdn.fixture.test/preview.png', userNotes: 'my private note' }),
    post(2, { title: 'Night market', thumbnailUrl: '/thumb/KeptPic123', favorite: true }),
    post(3, { title: 'No picture here', tags: ['market'] }),
    post(4, { title: 'Other shelf', categories: ['travel'] }),
  ];
  const saved = await (await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts, deletedUrls: [] }) })).json();
  assert.deepEqual(saved.rejected, []);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let file = '';

  await check('a shelf has Share, the dialog says what goes in, and the page downloads', async () => {
    await page.goto(base + '/library/category/food-drink');
    await page.getByRole('button', { name: 'Share this shelf' }).click();
    const dialog = page.getByRole('dialog', { name: 'Share as a page' });
    await dialog.getByText('What goes in: 3 links').waitFor();
    for (const box of ['Your notes', 'Reading status', 'Favourites', 'Telegram message text', 'Leave out pictures']) {
      assert.equal(await dialog.getByLabel(box).isChecked(), false, box);
    }
    await dialog.getByLabel('Intro line').fill('Bread and markets <b>I</b> like');
    await dialog.getByLabel('Your notes').check();
    await dialog.screenshot({ path: join(evidence, 'dialog.png') });
    const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download the page' }).click()]);
    assert.match(download.suggestedFilename(), /^food-drink-\d{4}-\d\d-\d\d\.html$/);
    file = join(evidence, download.suggestedFilename());
    await download.saveAs(file);
    await dialog.getByText(/Downloaded food-drink-.*\.html/).waitFor();
  });

  await check('the file opens on its own with no requests, pictures inside, values escaped', async () => {
    const html = await readFile(file, 'utf8');
    assert.ok(html.includes('my private note'), 'the ticked note is in');
    assert.ok(!html.includes('<script>alert'), 'titles are text');
    assert.ok(html.includes('Bread and markets &lt;b&gt;I&lt;/b&gt; like'));
    assert.ok(!html.includes('Other shelf') && !html.includes('cdn.fixture.test') && !html.includes('/thumb/'), 'only this shelf, no outside addresses');
    assert.ok(!html.includes('Favourite'), 'favourites stay out unless ticked');
    const viewer = await browser.newContext({ viewport: { width: 1100, height: 760 } });
    const reader = await viewer.newPage();
    const outside = []; reader.on('request', r => { if (!/^(file|data):/.test(r.url())) outside.push(r.url()); });
    const problems = []; reader.on('pageerror', e => problems.push(e.message)); reader.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
    await reader.goto(pathToFileURL(file).href);
    await reader.locator('article.card').first().waitFor();
    assert.equal(await reader.locator('article.card').count(), 3);
    assert.equal(await reader.locator('article.card img').count(), 2, 'the remote preview (through the app) and the kept one');
    for (const img of await reader.locator('article.card img').all()) assert.ok(await img.evaluate(el => el.naturalWidth > 0));
    await reader.fill('#q', 'market');
    assert.equal(await reader.locator('article.card:not([hidden])').count(), 2);
    await reader.selectOption('#s', 'title');
    assert.deepEqual(await reader.locator('article.card .title').allTextContents(), ['Focaccia <script>alert(1)</script>', 'Night market', 'No picture here']);
    await reader.screenshot({ path: join(evidence, 'page.png') });
    assert.deepEqual(outside, []);
    assert.deepEqual(problems, []);
    // Scripts blocked: every card is still there.
    const noJs = await browser.newContext({ javaScriptEnabled: false });
    const plain = await noJs.newPage();
    await plain.goto(pathToFileURL(file).href);
    assert.equal(await plain.locator('article.card').count(), 3);
    assert.equal(await plain.locator('#q').isVisible(), false, 'the search box only shows when it can work');
    await noJs.close(); await viewer.close();
  });

  await check('a selection can be shared from the bulk bar', async () => {
    await page.goto(base + '/library');
    await page.locator('.tile__select').first().click({ force: true });
    await page.getByRole('toolbar', { name: 'Bulk actions' }).getByRole('button', { name: 'Share' }).click();
    await page.getByRole('dialog', { name: 'Share as a page' }).getByText('What goes in: 1 link').waitFor();
    await page.getByRole('toolbar', { name: 'Bulk actions' }).screenshot({ path: join(evidence, 'bulk-bar.png') });
  });

  await check('no page errors', async () => { assert.deepEqual(errors, []); });
  await context.close();
} catch (error) {
  failures.push('setup'); console.error('FAIL setup:', error.message);
} finally {
  await browser.close();
  server.kill();
}
console.log(failures.length ? `FAILED ${failures.length} | evidence: ${evidence}` : `ALL PASS | evidence: ${evidence}`);
process.exit(failures.length ? 1 : 0);
