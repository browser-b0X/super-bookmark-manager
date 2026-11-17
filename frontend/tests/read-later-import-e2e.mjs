// Pocket and Instapaper exports, and Raindrop.io's HTML (owner, 2026-10-23: mockup p1-5a "Build as
// shown"): through Settings > Import links, preview to SQLite. Synthetic files and links only; previews
// are answered by a stand-in, nothing is fetched from the internet.
// Run from frontend/ after npm run build: node tests/read-later-import-e2e.mjs (C4_PYTHON, C4_PLAYWRIGHT_MODULE)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importThroughField } from './importField.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { chromium } = createRequire(import.meta.url)(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
await mkdir(join(root, '.verify'), { recursive: true });
const evidence = await mkdtemp(join(root, '.verify', 'read-later-'));
const port = 15000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.env.C4_PYTHON || 'python3', ['-B', '-c', `
import os, sys
sys.path.insert(0, ${JSON.stringify(root)})
os.environ["SAVED_POSTS_DB_PATH"] = ${JSON.stringify(join(evidence, 'fixture.sqlite'))}
os.environ["SBM_AI_CONFIG_FILE"] = ${JSON.stringify(join(evidence, 'ai.json'))}
os.environ["SBM_ARCHIVE_DIR"] = ${JSON.stringify(join(evidence, 'archive'))}
os.environ["SBM_SAVED_COPIES"] = "off"
os.environ["SBM_THUMB_CACHE_DIR"] = ${JSON.stringify(join(evidence, 'thumbs'))}
import storage, app, metadata_fetcher
metadata_fetcher.fetch_metadata = lambda url: {"title": "Fetched title", "summary": "Fetched words.", "thumbnail": "", "status": "ok", "error": ""}
storage.init_db()
app.app.run(host="127.0.0.1", port=${port}, debug=False, threaded=True)
`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
let serverLog = ''; server.stderr.on('data', c => { serverLog += c; });
for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/stats')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }

const files = {
  // Pocket's CSV, with the cursor column some exports have, a title with a comma and quotes, tags split by "|".
  'pocket_export.csv': 'title,url,time_added,cursor,tags,status\n'
    + '"Slow bread, part one: a ""beginner\'s"" schedule",https://bread.example.invalid/sourdough,1727000000,c1,baking|sourdough,archive\n'
    + 'The quiet joy of mechanical keyboards,https://desk.example.invalid/keyboards,1727086400,c2,,unread\n'
    + 'Ten walks,https://walks.example.invalid/ten,1727172800,c3,Walking,unread\n'
    + 'Again,https://walks.example.invalid/ten,1727172800,c4,,unread\n'
    + 'A script,javascript:alert(1),1727172800,c5,,unread\n',
  'instapaper-export.csv': 'URL,Title,Selection,Folder,Timestamp\n'
    + 'https://read.example.invalid/one,Read later one,,Unread,1727000000\n'
    + 'https://read.example.invalid/two,Read already,,Archive,1727086400\n'
    + 'https://read.example.invalid/three,A favourite,,Starred,1727172800\n'
    + 'https://read.example.invalid/four,In a folder,,Recipes,1727259200\n',
  'ril_export.html': '<!DOCTYPE html><html><head><title>Pocket Export</title></head><body>'
    + '<h1>Unread</h1><ul><li><a href="https://old.example.invalid/unread" time_added="1600000000" tags="news">Old unread</a></li></ul>'
    + '<h1>Read Archive</h1><ul><li><a href="https://old.example.invalid/read" time_added="1600086400" tags="">Old read</a></li></ul></body></html>',
  'raindrop.html': '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Raindrop.io Bookmarks</TITLE>\n<H1>Raindrop.io Bookmarks</H1>\n<DL><p>\n'
    + '<DT><H3 ADD_DATE="1727000000">Design</H3>\n<DL><p>\n'
    + '<DT><A HREF="https://drop.example.invalid/grid" ADD_DATE="1727000000" TAGS="layout,Grids" DATA-COVER="https://drop.example.invalid/c.jpg">A grid system</A>\n'
    + '<DD>My note: read the part about baselines.\n'
    + '<DT><A HREF="https://drop.example.invalid/type" ADD_DATE="1727086400">Type scales</A>\n'
    + '</DL><p>\n</DL><p>\n',
  'other-app.csv': 'name,address\nShop,https://shop.example.invalid/\n',
};
for (const [name, text] of Object.entries(files)) await writeFile(join(evidence, name), text);

const browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message.split('\n').slice(0, 6).join(' | ')}`); }
}
const library = async () => Object.fromEntries((await (await fetch(base + '/api/library')).json()).posts.map(p => [p.url, p]));
const until = async (what, test, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await test()) return; await new Promise(r => setTimeout(r, 300)); }
  throw new Error(`timed out waiting for ${what}`);
};
try {
  const page = await (await browser.newContext({ viewport: { width: 1365, height: 900 } })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/library/settings');
  await page.getByRole('heading', { name: 'Import links' }).waitFor();
  const preview = page.getByLabel('Import preview');

  await check('the panel names Raindrop.io, Pocket and Instapaper', async () => {
    const intro = await page.locator('[aria-labelledby="import-heading"] p').first().innerText();
    assert.match(intro, /Raindrop\.io/); assert.match(intro, /Pocket or Instapaper export \(\.csv\)/);
  });

  await check('Pocket CSV: unread to Inbox, archived to Kept, tags and saved dates kept', async () => {
    await page.getByLabel('Choose a file to import').setInputFiles(join(evidence, 'pocket_export.csv'));
    await preview.waitFor();
    assert.match(await preview.innerText(), /Pocket export \(CSV\) · nothing saved yet/);
    const note = preview.getByLabel('From Pocket');
    assert.match(await note.innerText(), /Unread → Inbox \(2\) · Archived → Kept \(1\) · Pocket tags become tags \(2 links\) · the date each was saved is kept\./);
    assert.equal(await preview.getByLabel('Which imported bookmarks appear in Catch Up').count(), 0, 'the export decides, not the age');
    await preview.getByRole('button', { name: 'Cancel', exact: true }).click();
    const result = await importThroughField(page, join(evidence, 'pocket_export.csv'));
    assert.equal(result.added, 3);
    await until('three Pocket links in SQLite', async () => Object.keys(await library()).length === 3);
    const lib = await library();
    const bread = lib['https://bread.example.invalid/sourdough'];
    assert.deepEqual([bread.title, bread.status, bread.tags, bread.createdAt], [`Slow bread, part one: a "beginner's" schedule`, 'reference', ['baking', 'sourdough'], new Date(1727000000e3).toISOString()]);
    assert.deepEqual([lib['https://desk.example.invalid/keyboards'].status, lib['https://desk.example.invalid/keyboards'].tags], ['inbox', []]);
    assert.deepEqual(lib['https://walks.example.invalid/ten'].tags, ['walking']);
  });

  await check('Instapaper CSV: Unread, Archive, Starred and a folder of the owner\'s', async () => {
    const result = await importThroughField(page, join(evidence, 'instapaper-export.csv'));
    assert.match(result.preview, /Instapaper export \(CSV\)/);
    assert.match(result.preview, /Unread → Inbox \(3\) · Archive → Kept \(1\) · Starred → Favourites \(1\)/);
    assert.equal(result.added, 4);
    await until('four Instapaper links', async () => Object.keys(await library()).length === 7);
    const lib = await library();
    assert.equal(lib['https://read.example.invalid/one'].status, 'inbox');
    assert.equal(lib['https://read.example.invalid/two'].status, 'reference');
    assert.deepEqual([lib['https://read.example.invalid/three'].favorite, lib['https://read.example.invalid/three'].status], [true, 'inbox']);
    assert.deepEqual(lib['https://read.example.invalid/four'].folderPath, ['Recipes']);
    assert.equal(lib['https://read.example.invalid/four'].createdAt, new Date(1727259200e3).toISOString());
  });

  await check('Pocket\'s older HTML export: its Unread and Read Archive lists', async () => {
    const result = await importThroughField(page, join(evidence, 'ril_export.html'));
    assert.match(result.preview, /Pocket export \(HTML\)/);
    assert.equal(result.added, 2);
    await until('two more links', async () => Object.keys(await library()).length === 9);
    const lib = await library();
    assert.deepEqual([lib['https://old.example.invalid/unread'].status, lib['https://old.example.invalid/unread'].tags], ['inbox', ['news']]);
    assert.equal(lib['https://old.example.invalid/read'].status, 'reference');
  });

  await check('Raindrop.io HTML: its tags and its note come along, and a preview fetch keeps the note', async () => {
    const result = await importThroughField(page, join(evidence, 'raindrop.html'));
    assert.match(result.preview, /Bookmarks HTML export/);
    assert.equal(result.added, 2);
    await until('the Raindrop links previewed', async () => {
      const lib = await library();
      return lib['https://drop.example.invalid/grid']?.metadataStatus === 'enriched';
    });
    const grid = (await library())['https://drop.example.invalid/grid'];
    assert.deepEqual([grid.title, grid.tags, grid.description, grid.folderPath], ['A grid system', ['layout', 'grids'], 'My note: read the part about baselines.', ['Design']]);
    assert.equal((await library())['https://drop.example.invalid/type'].description, 'Fetched words.', 'no note: the preview fills it');
  });

  await check('a CSV from another app is not taken for one of them', async () => {
    const result = await importThroughField(page, join(evidence, 'other-app.csv'));
    assert.equal(result.refused, true);
    assert.match(result.text, /isn't a bookmark export this app can read/);
  });

  await check('no page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) { console.error(`FAILED ${failures.length} | evidence: ${evidence}`); if (serverLog.includes('Traceback')) console.error(serverLog.slice(-2000)); process.exit(1); }
console.log(`ALL PASS | evidence: ${evidence}`);
