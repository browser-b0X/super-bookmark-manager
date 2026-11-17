// Search syntax and smart shelves (v0.4.0 phase 6a, mockups in Claude outputs/v040-review/phase6a/): the library
// reads a search back as chips, with help; a smart shelf is made from groups of rules, listed with a count, opened
// as a shelf, and keeps every part of its rules through saving, a reload and SQLite (a search the rules can't show
// stays text, never cut down). Synthetic data; nothing leaves the machine.
// Run from frontend/ after npm run build: node tests/smart-shelves-e2e.mjs (C4_PYTHON, C4_PLAYWRIGHT_MODULE)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(join(root, '.verify'), { recursive: true });
const evidence = await mkdtemp(join(root, '.verify', 'smart-shelves-'));
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
const link = (name, title, tags, extra = {}) => ({ id: `id-${name}`, url: `https://${name}.example.invalid/page`, source: 'browser', platform: 'web',
  domain: `${name}.example.invalid`, status: 'reference', createdAt: at, updatedAt: at, metadataStatus: 'partial',
  categories: ['food-drink'], categoryMode: 'manual', tags, projectIds: [], title, ...extra });
const seeded = await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deletedUrls: [], posts: [
  link('slow', 'Slow bread: a sourdough schedule', ['bread']), link('rye', 'Rye crackers', ['rye']),
  link('video', 'Why sourdough is flat, a video', ['bread']), link('videos', 'Ten videos of bread rising', ['bread']),
  link('walks', 'Ten walks near the city', ['walks'], { categories: ['travel'] })] }) });
assert.ok(seeded.ok, 'library seeded');

const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message.split('\n').slice(0, 8).join(' | ')}`); }
}
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
const errors = []; context.on('weberror', e => errors.push(e.error().message));
const page = await context.newPage();
const titles = async () => (await page.locator('main h3, main [data-post-title]').allTextContents()).map(t => t.trim()).filter(Boolean);
const count = async () => Number((await page.locator('h1 + .chip').first().textContent()).trim());
const search = page.locator('input[placeholder="Search… ( / )"]');
const sidebar = page.getByRole('navigation', { name: 'Smart shelves' });
const editor = page.getByRole('dialog', { name: /smart shelf/ });

try {
  await check('a search is read back as chips, with help', async () => {
    await page.goto(`${base}/library`);
    await page.waitForFunction(() => document.querySelector('h1 + .chip')?.textContent?.trim() === '5');   // the library has loaded
    await search.fill('(#bread or #rye) -video "sourdough"');
    const read = page.getByLabel('How the search is read');
    await read.getByText('any of: #bread, #rye').waitFor();
    await read.getByText('not the word “video”').waitFor();
    await read.getByText('the phrase “sourdough”').waitFor();
    assert.equal(await count(), 1, 'only "Slow bread": "a video" is left out, "videos" has no "sourdough"');
    await read.getByRole('button', { name: 'Search help' }).click();
    await page.getByLabel('Search help').getByText('leave out links with that whole word', { exact: false }).waitFor();
    await search.fill('bread -video');
    await page.waitForTimeout(200);
    assert.equal(await count(), 2, '-video leaves out "a video" but keeps "videos"');
    await search.fill('');
    assert.equal(await page.getByLabel('How the search is read').count(), 0);
  });

  await check('a smart shelf made from groups of rules: listed with its count, opened as a shelf', async () => {
    await page.goto(`${base}/shelves`);
    await sidebar.getByRole('button', { name: 'New smart shelf' }).click();
    await editor.getByLabel('Name').fill('Bread to bake');
    const first = editor.getByRole('group', { name: 'Rule group 1' });
    for (const tag of ['bread', 'rye']) {
      await first.getByLabel('Condition value').fill(tag);
      await first.getByRole('button', { name: 'Add' }).click();
    }
    await editor.getByRole('button', { name: 'Add a group' }).click();
    const second = editor.getByRole('group', { name: 'Rule group 2' });
    await second.getByLabel('Which of these').selectOption('none');
    await second.getByLabel('What the condition tests').selectOption('text');
    await second.getByLabel('Condition value').fill('video');
    await second.getByRole('button', { name: 'Add' }).click();
    await editor.getByText('(#bread or #rye) -video').waitFor();
    await editor.getByRole('status').getByText('3 links').waitFor();
    await page.screenshot({ path: join(evidence, 'editor.png') });
    await editor.getByRole('button', { name: 'Save smart shelf' }).click();
    await sidebar.getByRole('link', { name: 'Bread to bake 3' }).click();
    await page.getByText('Smart shelf: Bread to bake — applied').waitFor();
    assert.equal(await count(), 3);
  });

  await check('its rules come back whole: in the editor, after a reload, and in SQLite', async () => {
    await page.reload();
    await page.getByText('Smart shelf: Bread to bake — applied').waitFor();
    await page.getByRole('button', { name: 'Edit rules' }).click();
    await editor.getByRole('group', { name: 'Rule group 1' }).getByText('#bread').waitFor();
    assert.equal(await editor.getByRole('group', { name: 'Rule group 2' }).getByLabel('Which of these').inputValue(), 'none');
    await editor.getByText('(#bread or #rye) -video').waitFor();
    await editor.getByRole('button', { name: 'Cancel' }).click();
    const views = (await (await fetch(base + '/api/library')).json()).views;
    const view = views.find(v => v.name === 'Bread to bake');
    assert.deepEqual(view?.filter, { kind: 'all', search: '(#bread or #rye) -video', smart: true });
  });

  await check('a search the rules can\'t show is kept as text, never cut down', async () => {
    await page.goto(`${base}/shelves`);
    await sidebar.getByRole('button', { name: 'New smart shelf' }).click();
    await editor.getByLabel('Name').fill('Odd one');
    await editor.getByRole('button', { name: 'Edit as text' }).click();
    await editor.getByLabel('Search').fill('walks or (#bread rising)');
    await editor.getByText('can\'t be shown as rules', { exact: false }).waitFor();
    assert.equal(await editor.getByRole('button', { name: 'Edit as rules' }).isDisabled(), true);
    await editor.getByRole('button', { name: 'Save smart shelf' }).click();
    await page.reload();
    await sidebar.getByRole('button', { name: 'Edit the rules of Odd one' }).click();
    assert.equal(await editor.getByLabel('Search').inputValue(), 'walks or (#bread rising)', 'every part kept');
    await editor.getByRole('button', { name: 'Cancel' }).click();
    await sidebar.getByRole('link', { name: 'Odd one 2' }).waitFor();
  });

  await check('saved views that aren\'t smart shelves stay where they were', async () => {
    await page.goto(`${base}/library`);
    await search.fill('rye');
    await page.getByRole('button', { name: 'Saved Views' }).click();
    await page.getByLabel('View name').fill('Just rye');
    await page.getByRole('button', { name: 'Save current' }).click();
    await page.getByRole('button', { name: 'Close' }).click();
    await page.goto(`${base}/shelves`);
    await page.getByRole('link', { name: 'Just rye' }).waitFor();
    assert.equal(await sidebar.getByText('Just rye').count(), 0, 'not among the smart shelves');
    // Opened from All shelves, the view is applied (the page used to lose it on the way).
    await page.getByRole('link', { name: 'Just rye' }).click();
    await page.getByText('Just rye — applied').waitFor();
    assert.equal(await search.inputValue(), 'rye');
    assert.equal(await count(), 1);
  });

  await check('no page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await context.close();
  await browser.close();
  server.kill();
}
if (failures.length) { console.error(`FAILED ${failures.length} | evidence: ${evidence}`); if (serverLog.includes('Traceback')) console.error(serverLog.slice(-2000)); process.exit(1); }
console.log(`ALL PASS | evidence: ${evidence}`);
