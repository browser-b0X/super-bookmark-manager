// Feed revamp: new-links strip on top of the library, hover detail cells,
// drag-to-reorder ("My order"), filters in the main sidebar. Synthetic data only.
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
  const rail = page.getByRole('region', { name: /New to sort/ });
  const grid = () => page.locator('.tile-grid article');

  await check('new links ride in the strip; the grid holds the rest', async () => {
    await rail.waitFor();
    // Six new links, each shown once for people and assistive tech (the loop copy is hidden).
    assert.equal(await rail.locator('article:not([aria-hidden])').count(), 6);
    assert.equal(await grid().count(), 10);
    assert.equal(await page.locator('.tile-grid a[href="/library/item/f0"]').count(), 0);
  });
  await check('the strip pauses while the pointer is on it', async () => {
    const state = () => rail.locator('.rail__track').evaluate(el => getComputedStyle(el).animationPlayState);
    assert.equal(await state(), 'running');
    const box = await rail.locator('.rail__viewport').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(el => getComputedStyle(el).animationPlayState === 'paused', await rail.locator('.rail__track').elementHandle());
    await page.mouse.move(5, 5);
    await rail.getByRole('button', { name: 'Pause' }).click();
    assert.equal(await state(), 'paused');
  });
  await check('keeping a link from the strip moves it into the library', async () => {
    await rail.getByRole('button', { name: 'Keep Story 0' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.tile-grid article').length === 11);
    await page.waitForFunction(() => !Object.keys(JSON.parse(localStorage.getItem('library-store-v1')).state.pending).length);
    assert.equal((await api()).posts.find(p => p.id === 'f0').status, 'reference');
  });
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
  await check('shelves, lists and platforms filter from the main sidebar', async () => {
    const nav = page.getByRole('complementary', { name: 'Navigation' });
    await nav.getByRole('link', { name: /^travel/ }).click();
    await page.waitForURL(/\/library\/category\//);
    const ids = await page.locator('main article[data-post-id]').evaluateAll(els => els.map(e => e.dataset.postId));
    assert.ok(ids.length > 0 && ids.every(id => Number(id.slice(1)) % 2 === 1));
    await nav.getByRole('button', { name: /^Kept/ }).click();
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
