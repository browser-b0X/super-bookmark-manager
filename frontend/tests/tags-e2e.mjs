// Nested tags (v0.4.0 phase 6a, mockup Claude outputs/v040-review/phase6a/mockup-6): the Tags dialog puts a tag under
// several others and gives it other names (refusing one that is another tag), a search or a tag's page finds the
// tags under it and its other names, merging keeps both names and has Undo, and it all stays in SQLite.
// Synthetic data; nothing leaves the machine.
// Run from frontend/ after npm run build: node tests/tags-e2e.mjs (C4_PYTHON, C4_PLAYWRIGHT_MODULE)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(join(root, '.verify'), { recursive: true });
const evidence = await mkdtemp(join(root, '.verify', 'tags-'));
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
const link = (name, title, tags) => ({ id: `id-${name}`, url: `https://${name}.example.invalid/page`, source: 'browser', platform: 'web',
  domain: `${name}.example.invalid`, status: 'reference', createdAt: at, updatedAt: at, metadataStatus: 'partial',
  categories: ['arts-culture'], categoryMode: 'manual', tags, projectIds: [], title });
const seeded = await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deletedUrls: [], posts: [
  link('bars', 'Colour bars, a short history', ['colour-bars']), link('cards', 'Test cards of the world', ['colorbars']),
  link('fractal', 'A fractal zoom', ['pattern']), link('walks', 'Ten walks', ['walks'])] }) });
assert.ok(seeded.ok, 'library seeded');
const stored = async () => (await (await fetch(base + '/api/library')).json());
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
const dialog = page.getByRole('dialog', { name: 'Tags' });
const row = name => dialog.getByRole('listitem', { name: `#${name}` });
const count = async () => Number((await page.locator('h1 + .chip').first().textContent()).trim());

try {
  await check('a tag under several others, with another name; a name that is a tag of its own is refused', async () => {
    await page.goto(`${base}/shelves`);
    await page.getByRole('button', { name: 'Manage tags…' }).click();
    await row('colour-bars').getByRole('button').first().click();
    const editor = row('colour-bars');
    await editor.getByLabel('Put #colour-bars under another tag').selectOption('pattern');
    await editor.getByLabel('Another name for #colour-bars').fill('bars');
    await editor.getByLabel('Another name for #colour-bars').press('Enter');
    await editor.getByText('under #pattern').waitFor();
    await editor.getByText('also: bars').waitFor();
    await editor.getByLabel('Another name for #colour-bars').fill('walks');
    await editor.getByLabel('Another name for #colour-bars').press('Enter');
    await editor.getByRole('alert').getByText('#walks is on links already: merge it into #colour-bars instead.').waitFor();
    await page.screenshot({ path: join(evidence, 'tags.png') });
    await until(async () => (await stored()).docs?.tags?.some(t => t.name === 'colour-bars' && t.parents.includes('pattern') && t.aliases.includes('bars')), 'saved to SQLite');
  });

  await check('searching a tag finds the tags under it and its other names; so does its page', async () => {
    await page.goto(`${base}/library`);
    await page.waitForFunction(() => document.querySelector('h1 + .chip')?.textContent?.trim() === '4');
    await page.locator('input[placeholder="Search… ( / )"]').fill('#pattern');
    await page.waitForFunction(() => document.querySelector('h1 + .chip')?.textContent?.trim() === '2');
    await page.locator('input[placeholder="Search… ( / )"]').fill('#bars');
    await page.waitForFunction(() => document.querySelector('h1 + .chip')?.textContent?.trim() === '1');
    await page.goto(`${base}/library/tag/pattern`);
    await page.waitForFunction(() => document.querySelector('h1 + .chip')?.textContent?.trim() === '2');
  });

  await check('merging keeps both names, and Undo puts the links and tags back', async () => {
    await page.goto(`${base}/shelves`);
    await page.getByRole('button', { name: 'Manage tags…' }).click();
    await row('colorbars').getByRole('button').first().click();
    await row('colorbars').getByLabel('Merge #colorbars into').selectOption('colour-bars');
    await row('colorbars').getByText('Its 1 link gets #colour-bars', { exact: false }).waitFor();
    await row('colorbars').getByRole('button', { name: 'Merge' }).click();
    const done = dialog.getByRole('status').filter({ hasText: 'Merged #colorbars into #colour-bars' });
    await done.waitFor();
    await until(async () => { const s = await stored(); return s.posts.find(p => p.id === 'id-cards').tags.join() === 'colour-bars'
      && s.docs.tags.find(t => t.name === 'colour-bars').aliases.includes('colorbars'); }, 'merged in SQLite');
    await done.getByRole('button', { name: 'Undo' }).click();
    await until(async () => { const s = await stored(); return s.posts.find(p => p.id === 'id-cards').tags.join() === 'colorbars'
      && !s.docs.tags.find(t => t.name === 'colour-bars').aliases.includes('colorbars'); }, 'undone in SQLite');
  });

  await check('after a reload the tags are as they were left', async () => {
    await page.reload();
    await page.getByRole('button', { name: 'Manage tags…' }).click();
    await row('colour-bars').getByText('under #pattern').waitFor();
    await row('colour-bars').getByText('also: bars').waitFor();
  });

  await check('no page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await context.close();
  await browser.close();
  server.kill();
}
if (failures.length) { console.error(`FAILED ${failures.length} | evidence: ${evidence}`); if (serverLog.includes('Traceback')) console.error(serverLog.slice(-2000)); process.exit(1); }
console.log(`ALL PASS | evidence: ${evidence}`);
