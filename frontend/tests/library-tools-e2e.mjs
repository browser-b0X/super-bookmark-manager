// Library tools (v0.4.0 phase 6a, mockups in Claude outputs/v040-review/phase6a/): the "reviewed" switch and its
// lock on the tile, and bulk edit (add, remove or replace tags and shelves, set the status) with a count before
// anything changes and Undo after. Synthetic data; nothing leaves the machine.
// Run from frontend/ after npm run build: node tests/library-tools-e2e.mjs (C4_PYTHON, C4_PLAYWRIGHT_MODULE)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(join(root, '.verify'), { recursive: true });
const evidence = await mkdtemp(join(root, '.verify', 'library-tools-'));
const port = 15000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;

const server = spawn(process.env.C4_PYTHON || 'python3', ['-B', '-c', `
import os, sys
sys.path.insert(0, ${JSON.stringify(root)})
sys.path.insert(0, ${JSON.stringify(join(root, 'frontend', 'tests'))})
os.environ["SAVED_POSTS_DB_PATH"] = ${JSON.stringify(join(evidence, 'fixture.sqlite'))}
os.environ["SUPER_BOOKMARK_MANAGER_DATA_DIR"] = ${JSON.stringify(join(evidence, 'data'))}
os.environ["SBM_AI_CONFIG_FILE"] = ${JSON.stringify(join(evidence, 'ai.json'))}
os.environ["SBM_ARCHIVE_DIR"] = ${JSON.stringify(join(evidence, 'archive'))}
os.environ["SBM_THUMB_CACHE_DIR"] = ${JSON.stringify(join(evidence, 'thumbs'))}
os.environ["SBM_SAVED_COPIES"] = "off"
from metadata_fixture import ControlledHTTP
import storage, app, metadata_fetcher
metadata_fetcher.fetch_metadata = lambda url: {"title": "", "summary": "", "thumbnail": "", "status": "empty", "error": ""}
site = ControlledHTTP().__enter__()          # nothing may leave the machine
storage.init_db()
app.app.run(host="127.0.0.1", port=${port}, debug=False, threaded=True)
`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
let serverLog = ''; server.stderr.on('data', c => { serverLog += c; });
for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/api/stats')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }

const at = '2026-10-20T10:00:00.000Z';
const link = (name, title, tags, shelf) => ({ id: `id-${name}`, url: `https://${name}.example.invalid/page`, source: 'browser', platform: 'web',
  domain: `${name}.example.invalid`, status: 'inbox', createdAt: at, updatedAt: at, metadataStatus: 'partial',
  categories: [shelf], categoryMode: 'manual', tags, projectIds: [], title });
const seeded = await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deletedUrls: [], posts: [
  link('slow', 'Slow bread', ['bread'], 'food-drink'), link('rye', 'Rye crackers', ['rye'], 'food-drink'), link('walks', 'Ten walks', ['walks'], 'travel')] }) });
assert.ok(seeded.ok, 'library seeded');
const stored = async () => Object.fromEntries((await (await fetch(base + '/api/library')).json()).posts.map(p => [p.id, p]));
const until = async (test, what, timeout = 10000) => {
  const end = Date.now() + timeout;
  for (;;) { const value = await test(); if (value) return value; if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 200)); }
};

const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message.split('\n').slice(0, 8).join(' | ')}`); }
}
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
const errors = []; context.on('weberror', e => errors.push(e.error().message));
const page = await context.newPage();
const tile = name => page.locator('article.tile', { hasText: name });

try {
  await check('the Reviewed switch: a lock on the tile, kept in SQLite, found by is:reviewed', async () => {
    await page.goto(`${base}/library/item/id-rye`);
    const lock = page.getByRole('switch', { name: 'Reviewed' });
    await lock.click();
    assert.equal(await lock.getAttribute('aria-checked'), 'true');
    await until(async () => (await stored())['id-rye'].reviewed === true, 'saved to SQLite');
    await page.goto(`${base}/library`);
    await tile('Rye crackers').getByRole('img', { name: 'Reviewed' }).waitFor();
    assert.equal(await tile('Slow bread').getByRole('img', { name: 'Reviewed' }).count(), 0);
    await page.locator('input[placeholder="Search… ( / )"]').fill('is:reviewed');
    await page.waitForFunction(() => document.querySelector('h1 + .chip')?.textContent?.trim() === '1');
    await page.locator('input[placeholder="Search… ( / )"]').fill('');
  });

  await check('bulk edit: says how many links change, applies in one go, and Undo puts them back', async () => {
    await page.waitForFunction(() => document.querySelector('h1 + .chip')?.textContent?.trim() === '3');
    for (const name of ['Slow bread', 'Rye crackers', 'Ten walks']) await tile(name).getByRole('checkbox', { name: 'Select post' }).check();
    await page.getByRole('toolbar', { name: 'Bulk actions' }).getByRole('button', { name: 'Edit…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit 3 links' });
    await dialog.getByLabel('Tag to add to the list').fill('to-bake');
    await dialog.getByLabel('Tag to add to the list').press('Enter');
    await dialog.getByRole('radiogroup', { name: 'Shelves: what to do' }).getByRole('radio', { name: 'Replace with' }).click();
    await dialog.getByLabel('Shelf to add to the list').selectOption('food-drink');
    await dialog.getByRole('status').getByText('3 links will change.').waitFor();
    await dialog.getByText('1 is marked Reviewed and changes too, because you chose it.').waitFor();
    await page.screenshot({ path: join(evidence, 'bulk-edit.png') });
    await dialog.getByRole('button', { name: 'Apply to 3 links' }).click();
    const note = page.getByRole('status').filter({ hasText: 'Changed 3 items' });
    await note.waitFor();
    await until(async () => { const s = await stored(); return s['id-walks'].categories.join() === 'food-drink' && s['id-slow'].tags.includes('to-bake'); }, 'saved to SQLite');
    const after = await stored();
    assert.deepEqual([after['id-rye'].tags, after['id-walks'].tags], [['rye', 'to-bake'], ['walks', 'to-bake']]);
    await note.getByRole('button', { name: 'Undo' }).click();
    await until(async () => { const s = await stored(); return s['id-walks'].categories.join() === 'travel' && !s['id-slow'].tags.includes('to-bake'); }, 'undone in SQLite');
    assert.equal((await stored())['id-rye'].reviewed, true, 'the mark stays');
  });

  await check('no page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await context.close();
  await browser.close();
  server.kill();
}
if (failures.length) { console.error(`FAILED ${failures.length} | evidence: ${evidence}`); if (serverLog.includes('Traceback')) console.error(serverLog.slice(-2000)); process.exit(1); }
console.log(`ALL PASS | evidence: ${evidence}`);
