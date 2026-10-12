// Feed revamp: new-links strip on top of the library, hover detail cells,
// drag-to-reorder ("My order"), filters on the All shelves page. Synthetic data only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = await mkdtemp(join(root, '.verify', 'feed-'));
const port = 15000 + Math.floor(Math.random() * 20000);
const server = spawn(process.env.C4_PYTHON || 'python3', ['-B', '-c', `
import os, sys
sys.path.insert(0, ${JSON.stringify(root)})
os.environ["SAVED_POSTS_DB_PATH"] = ${JSON.stringify(join(evidence, 'fixture.sqlite'))}
os.environ["SBM_AI_CONFIG_FILE"] = ${JSON.stringify(join(evidence, 'ai.json'))}
import storage, app, metadata_fetcher
metadata_fetcher.fetch_metadata = lambda url: {"title": "", "summary": "", "thumbnail": "", "status": "empty", "error": ""}
storage.init_db()
app.app.run(host="127.0.0.1", port=${port}, debug=False)
`], { cwd: root, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/stats')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
const api = async () => (await fetch(base + '/api/library')).json();

const now = Date.now();
const mk = (i, extra = {}) => ({ id: `f${i}`, url: `https://s${i}.example.invalid/story/${i}`, source: 'browser', platform: 'web',
  domain: `s${i}.example.invalid`, status: i < 6 ? 'inbox' : 'reference', createdAt: new Date(now - i * 3600e3).toISOString(),
  updatedAt: new Date(now - i * 3600e3).toISOString(), metadataStatus: 'enriched', categories: [i % 2 ? 'travel' : 'technology'],
  tags: [], projectIds: [], title: `Story ${i}`, description: `Description of story ${i}`, ...extra });
const posts = Array.from({ length: 16 }, (_, i) => mk(i));
await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts, deletedUrls: [] }) });

const browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
try {
  const page = await (await browser.newContext({ viewport: { width: 1365, height: 900 } })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/');
  await page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /Library saved to SQLite/ }).waitFor();
  const deck = page.getByRole('region', { name: 'New to sort' });
  const grid = () => page.locator('.tile-grid article');
  const status = async id => (await api()).posts.find(p => p.id === id).status;
  const synced = () => page.waitForFunction(() => !Object.keys(JSON.parse(localStorage.getItem('library-store-v1')).state.pending).length);

  await check('Home shows new links one at a time, Up next, and the shelves as rows', async () => {
    await deck.waitFor();
    assert.equal(await deck.locator('article[data-post-id]').getAttribute('data-post-id'), 'f0', 'newest first');
    assert.match(await deck.innerText(), /1 of 6 · from your browser/);
    const upNext = page.getByRole('region', { name: 'Up next' });
    assert.deepEqual(await upNext.getByRole('listitem').locator('b').allTextContents(), ['Story 1', 'Story 2', 'Story 3']);
    assert.match(await upNext.getByRole('link', { name: /See all 6/ }).getAttribute('href'), /\/library\/inbox$/);
    for (const [shelf, n] of [['technology', 5], ['travel', 5]]) {
      const row = page.getByRole('region', { name: shelf });
      assert.match(await row.innerText(), new RegExp(`${n} links`));
      assert.equal(await row.getByRole('listitem').count(), n);
    }
    assert.equal(await page.locator('.shelf-row a[href="/library/item/f0"]').count(), 0, 'new links are not in the rows yet');
  });
  await check('the keyboard sorts: → keeps, ← archives, ↓ later, Z undoes, Enter opens', async () => {
    await page.keyboard.press('ArrowRight');
    await deck.locator('article[data-post-id="f1"]').waitFor();
    await page.keyboard.press('ArrowLeft');
    await deck.locator('article[data-post-id="f2"]').waitFor();
    await page.keyboard.press('ArrowDown');
    await deck.locator('article[data-post-id="f3"]').waitFor();
    assert.match(await deck.innerText(), /4 of 6/);
    await synced();
    assert.deepEqual([await status('f0'), await status('f1'), await status('f2')], ['reference', 'archived', 'to-review']);
    await page.keyboard.press('z');
    await deck.locator('article[data-post-id="f2"]').waitFor();
    await synced();
    assert.equal(await status('f2'), 'inbox');
    await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: 'Saved post detail' }).waitFor();
    assert.match(page.url(), /\/library\/item\/f2$/);
    await page.keyboard.press('Escape');
    await page.waitForURL(base + '/');
    await deck.locator('article[data-post-id="f2"]').waitFor();
  });
  await check('the buttons do the same, and Keep in Up next files a link without opening it', async () => {
    await deck.getByRole('button', { name: 'Keep: Story 2' }).click();
    await deck.locator('article[data-post-id="f3"]').waitFor();
    await page.getByRole('region', { name: 'Up next' }).getByRole('button', { name: 'Keep Story 5' }).click();
    await synced();
    assert.deepEqual([await status('f2'), await status('f5')], ['reference', 'reference']);
    assert.equal(await page.getByRole('region', { name: 'technology' }).getByRole('listitem').count(), 7, 'kept links join their shelf row');
  });
  await page.goto(base + '/library');
  await grid().first().waitFor();
  await check('hovering a tile opens a details cell without covering the picture', async () => {
    const tile = grid().first();
    await tile.hover();
    const pop = tile.locator('.tile__pop');
    await page.waitForFunction(el => getComputedStyle(el).visibility === 'visible' && getComputedStyle(el).opacity === '1', await pop.elementHandle());
    const media = await tile.locator('.tile__media').boundingBox(), box = await pop.boundingBox();
    assert.ok(box.y > media.y + media.height * 0.6, 'details cell sits at the bottom edge, not over the picture');
    assert.match(await pop.innerText(), /Description of story/);
  });
  await check('dragging a tile saves "My order" to SQLite', async () => {
    const before = await grid().evaluateAll(els => els.map(e => e.dataset.postId));
    const grip = grid().nth(0).locator('.tile__grip');
    await grid().nth(0).hover();
    await grip.focus();
    // dnd-kit measures the tiles a frame after pick-up; a person's key presses are never this fast.
    const press = async key => { await page.keyboard.press(key); await page.waitForTimeout(150); };
    await press('Space'); await press('ArrowRight'); await press('ArrowRight'); await press('Space');
    await page.waitForFunction(first => document.querySelector('.tile-grid article')?.dataset.postId !== first, before[0]);
    assert.equal(await page.getByRole('combobox', { name: 'Sort' }).inputValue(), 'custom');
    const after = await grid().evaluateAll(els => els.map(e => e.dataset.postId));
    await page.waitForFunction(() => !Object.keys(JSON.parse(localStorage.getItem('library-store-v1')).state.pending).length);
    const saved = (await api()).posts.filter(p => after.includes(p.id)).sort((a, b) => a.position - b.position).map(p => p.id);
    assert.deepEqual(saved, after);
    await page.reload();
    await page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /Library saved to SQLite/ }).waitFor();
    assert.deepEqual(await grid().evaluateAll(els => els.map(e => e.dataset.postId)), after);
  });
  await check('shelves, lists and platforms filter from the All shelves page', async () => {
    const sections = page.getByRole('navigation', { name: 'Sections' });
    await sections.getByRole('link', { name: 'All shelves' }).click();
    await page.waitForURL(/\/shelves$/);
    await page.getByRole('link', { name: /^travel \d/ }).click();
    await page.waitForURL(/\/library\/category\//);
    const ids = await page.locator('main article[data-post-id]').evaluateAll(els => els.map(e => e.dataset.postId));
    assert.ok(ids.length > 0 && ids.every(id => Number(id.slice(1)) % 2 === 1));
    await sections.getByRole('link', { name: 'All shelves' }).click();
    await page.getByRole('complementary', { name: 'Lists, platforms and saved views' }).getByRole('link', { name: /^Kept / }).click();
    await page.waitForURL(/status=reference/);
    assert.equal(await page.locator('.library-filters, nav[aria-label="Library filters"]').count(), 0, 'no second filter column');
  });
  await check('the geometric backdrop sits behind the app in both themes', async () => {
    const info = () => page.evaluate(() => {
      const el = document.querySelector('.backdrop');
      return { shapes: el?.querySelectorAll('.backdrop__shape').length, hidden: el?.getAttribute('aria-hidden'),
        pointer: el && getComputedStyle(el).pointerEvents, bg: getComputedStyle(document.body).backgroundColor };
    });
    const dark = await info();
    assert.ok(dark.shapes >= 12 && dark.hidden === 'true' && dark.pointer === 'none');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.waitForTimeout(300);
    assert.notEqual((await info()).bg, dark.bg);
  });
  await check('no page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) throw new Error('feed failures: ' + failures.join(', '));
console.log(`PASS feed e2e; evidence ${evidence}`);
