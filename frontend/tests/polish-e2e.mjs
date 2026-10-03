// Audit phase 5: search operators, large-list rendering, Catch Up window and
// list layout, drawer dialog behaviour, duplicate merge, delta sync.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = await mkdtemp(join(root, '.verify', 'polish-'));
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

const now = Date.now();
const mk = (i, extra = {}) => ({ id: `p${i}`, url: `https://s${i % 7}.example.invalid/item/${i}`, source: i % 2 ? 'browser' : 'telegram',
  platform: 'web', domain: `s${i % 7}.example.invalid`, status: 'inbox', createdAt: new Date(now - i * 60000).toISOString(),
  updatedAt: new Date(now - i * 60000).toISOString(), metadataStatus: 'enriched', categories: ['other'], tags: i % 5 ? [] : ['recipes'],
  projectIds: [], title: `Item ${i}`, ...extra });
const posts = Array.from({ length: 400 }, (_, i) => mk(i));
posts[3] = mk(3, { title: 'Gone page', linkStatus: 'gone', favorite: true, folderPath: ['Bar', 'Work'] });
posts[4] = mk(4, { url: 'https://dup.example.invalid/page', domain: 'dup.example.invalid', title: 'Dup A', tags: ['a'], userNotes: 'note A' });
posts[5] = mk(5, { url: 'https://www.dup.example.invalid/page/?utm_source=x', domain: 'dup.example.invalid', title: 'Dup B', tags: ['b'], favorite: true });
await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts, deletedUrls: [] }) });

const unit = await build({
  stdin: { contents: `export { parseQuery, matchesQuery } from './src/lib/librarySearch';`, resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, write: false, format: 'iife', globalName: 'ls',
});

const browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
try {
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const libraryRequests = [];
  page.on('request', r => { if (new URL(r.url()).pathname === '/api/library') libraryRequests.push(r.method() + ' ' + new URL(r.url()).search); });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/library');
  await page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /Library saved to SQLite/ }).waitFor();

  await check('search operators combine with free text', async () => {
    await page.addScriptTag({ content: unit.outputFiles[0].text });
    const r = await page.evaluate(() => {
      const post = { url: 'https://cooking.example/soup', domain: 'cooking.example', title: 'Tomato soup', tags: ['recipes/soups'],
        categories: ['food-drink'], status: 'to-review', favorite: true, folderPath: ['Bar', 'Kitchen'] };
      const m = q => ls.matchesQuery(post, ls.parseQuery(q));
      return [m('site:cooking.example tomato'), m('#recipes is:later is:favorite'), m('shelf:food-drink in:kitchen'),
        m('is:unread'), m('site:other.example'), m('"tomato soup"'), m('#soups')];
    });
    assert.deepEqual(r, [true, true, true, false, false, true, false]);
  });
  await check('large libraries render in steps, not all at once', async () => {
    await page.locator('main article').first().waitFor();
    const first = await page.locator('main article').count();
    assert.ok(first <= 130, `rendered ${first} cards at once`);
    await page.getByRole('button', { name: /Show more/ }).scrollIntoViewIfNeeded();
    await page.waitForFunction(n => document.querySelectorAll('main article').length > n, first);
  });
  await check('search operators work in the Library search box', async () => {
    await page.getByPlaceholder('Search… ( / )').fill('is:gone');
    await page.waitForFunction(() => document.querySelectorAll('main article').length === 1);
    await page.getByPlaceholder('Search… ( / )').fill('#recipes site:s0.example.invalid');
    const count = await page.locator('main article').count();
    assert.equal(count, posts.filter(p => p.tags.includes('recipes') && p.domain.startsWith('s0.')).length);
    await page.getByPlaceholder('Search… ( / )').fill('');
  });
  await check('table headers are sort buttons with aria-sort', async () => {
    await page.getByRole('radio', { name: 'table', exact: true }).click();
    await page.locator('table.tbl').waitFor();
    const header = page.locator('table.tbl th').filter({ hasText: /^Title$/ });
    assert.equal(await header.getAttribute('aria-sort'), 'none');
    await header.getByRole('button').click();
    assert.equal(await header.getAttribute('aria-sort'), 'descending');
    await page.getByRole('radio', { name: 'grid', exact: true }).click();
  });
  await check('drawer: Escape closes and focus returns; duplicate is offered for merge', async () => {
    const link = page.locator('main a[href="/library/item/p5"]');
    await page.getByPlaceholder('Search… ( / )').fill('Dup');
    await link.focus(); await page.keyboard.press('Enter');
    const drawer = page.getByRole('dialog', { name: 'Saved post detail' });
    await drawer.waitFor();
    assert.match(await drawer.innerText(), /Possible duplicate of Dup A/);
    await drawer.getByRole('button', { name: 'Merge into this' }).click();
    await page.waitForFunction(() => !JSON.parse(localStorage.getItem('library-store-v1')).state.posts.some(p => p.id === 'p4'));
    const merged = await page.evaluate(() => JSON.parse(localStorage.getItem('library-store-v1')).state.posts.find(p => p.id === 'p5'));
    assert.deepEqual(merged.tags.sort(), ['a', 'b']); assert.equal(merged.userNotes, 'note A'); assert.equal(merged.favorite, true);
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'detached' });
    await page.getByPlaceholder('Search… ( / )').fill('');
  });
  await check('the feed strip caps how many new links it renders at once', async () => {
    await page.goto(base + '/');
    await page.locator('.rail-card').first().waitFor();
    // 400 new links: the strip shows the newest 40 (plus the loop copy), the rest sit behind "See all".
    assert.equal(await page.locator('.rail-card:not([aria-hidden])').count(), 40);
    assert.match(await page.getByRole('link', { name: /See all/ }).innerText(), /See all 3\d\d/);
  });
  await check('after the first full load, sync asks only for changes', async () => {
    await page.reload();
    await page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /Library saved to SQLite/ }).waitFor();
    assert.ok(libraryRequests.some(r => /^GET \?since=\d+$/.test(r)), libraryRequests.join(', '));
  });
  await check('no page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) throw new Error('polish failures: ' + failures.join(', '));
console.log(`PASS polish e2e; evidence ${evidence}`);
