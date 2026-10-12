// Audit phase 4: one drop zone, format detection, preview, folder→shelf, undo.
// Built SPA + real Flask app + synthetic SQLite under .verify.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = await mkdtemp(join(root, '.verify', 'import-workflow-'));
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
`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
let log = ''; server.stderr.on('data', d => { log += d; });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/stats')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
const api = async () => (await fetch(base + '/api/library')).json();

const chromiumTime = iso => String(BigInt(Date.parse(iso)) * 1000n + 11644473600000000n);
const chromiumFile = JSON.stringify({ roots: {
  bookmark_bar: { type: 'folder', name: 'Bookmarks bar', children: [
    { type: 'folder', name: 'Recipes', children: [
      { type: 'url', name: 'Soup', url: 'https://food.example.invalid/soup', date_added: chromiumTime('2026-09-30T10:00:00Z') },
      { type: 'url', name: 'Bread', url: 'https://food.example.invalid/bread', date_added: chromiumTime('2020-01-01T10:00:00Z') },
    ] },
    { type: 'folder', name: 'Work junk', children: [{ type: 'url', name: 'Old wiki', url: 'https://work.example.invalid/wiki' }] },
    { type: 'folder', name: 'Trips', children: [{ type: 'url', name: 'Lisbon', url: 'https://travel.example.invalid/lisbon' }] },
    { type: 'url', name: 'Bookmarklet', url: 'javascript:void(0)' },
    { type: 'url', name: 'Same as saved', url: 'https://www.saved.example.invalid/page/?utm_source=x' },
  ] },
} });
const firefoxJson = JSON.stringify({ guid: 'root________', title: '', typeCode: 2, children: [
  { guid: 'toolbar_____', title: 'toolbar', typeCode: 2, children: [
    { title: 'Firefox link', typeCode: 1, uri: 'https://ff.example.invalid/a', dateAdded: Date.parse('2026-09-29T00:00:00Z') * 1000 },
  ] },
] });

const browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/library/settings');
  await page.evaluate(() => fetch('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts: [{
    id: 'saved-1', url: 'https://saved.example.invalid/page', source: 'manual', platform: 'web', domain: 'saved.example.invalid', status: 'reference',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', metadataStatus: 'enriched', categories: ['other'], tags: [], projectIds: [], title: 'Saved page' }], deletedUrls: [] }) }));
  await page.reload();
  await page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /Library saved to SQLite/ }).waitFor();
  const choose = page.getByLabel('Choose a file to import');
  const preview = page.getByLabel('Import preview');

  await check('Chromium file is detected and previewed without saving anything', async () => {
    await choose.setInputFiles({ name: 'Bookmarks', mimeType: 'application/octet-stream', buffer: Buffer.from(chromiumFile) });
    await preview.waitFor();
    assert.match(await preview.innerText(), /Chrome \/ Edge \/ Brave Bookmarks file/);
    const counts = await preview.locator('.import-counts dd').allInnerTexts();
    assert.deepEqual(counts, ['4', '0', '1', '1']); // 4 new, 1 likely duplicate, 1 javascript: skipped
    assert.equal((await api()).posts.length, 1, 'preview must not write');
  });
  await check('folders can be left out, mapped to a shelf, and tagged', async () => {
    await page.getByLabel('Import folder Work junk').uncheck();
    await page.getByLabel('Shelf for folder Trips').selectOption('travel');
    await page.getByLabel('Shelf for folder Recipes').selectOption('food-drink');
    await page.getByRole('combobox').filter({ hasText: 'Folder name' }).selectOption('leaf');
    await page.getByLabel('Which imported bookmarks appear in Catch Up').first().selectOption('30');
    await preview.getByRole('button', { name: /Import 3 new links/ }).click();
    await page.getByRole('status', { name: 'Import result' }).filter({ hasText: /3 new links imported/ }).waitFor();
    await page.waitForFunction(() => { const s = JSON.parse(localStorage.getItem('library-store-v1')).state; return !Object.keys(s.pending).length; });
    const posts = (await api()).posts;
    const by = url => posts.find(p => p.url === url);
    assert.equal(posts.length, 4);
    assert.equal(by('https://work.example.invalid/wiki'), undefined);
    assert.deepEqual([by('https://travel.example.invalid/lisbon').categories, by('https://travel.example.invalid/lisbon').categoryMode], [['travel'], 'manual']);
    assert.deepEqual(by('https://food.example.invalid/soup').tags, ['recipes']);
    assert.deepEqual(by('https://food.example.invalid/soup').folderPath, ['Bookmarks bar', 'Recipes']);
    assert.equal(by('https://food.example.invalid/soup').status, 'inbox');
    assert.equal(by('https://food.example.invalid/bread').status, 'reference', '2020 bookmark stays out of Catch Up');
    assert.ok(posts.filter(p => p.importBatchId).length === 3);
    // The skipped likely duplicate lends its folder to the saved link.
    assert.deepEqual(by('https://saved.example.invalid/page').folderPath, ['Bookmarks bar']);
  });
  await check('undo removes untouched links without tombstones; worked-with links stay', async () => {
    // Work with one imported link first.
    const soupId = await page.evaluate(() => JSON.parse(localStorage.getItem('library-store-v1')).state.posts.find(p => p.url.endsWith('/soup')).id);
    await page.goto(base + `/library/item/${soupId}`);
    await page.getByPlaceholder('Your notes…').fill('keep this one');
    await page.goto(base + '/library/settings');
    await page.getByRole('button', { name: 'Undo' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Undo import' });
    assert.match(await dialog.innerText(), /2 links from this import will be removed/);
    await dialog.getByRole('button', { name: /^Remove 2$/ }).click();
    await page.getByRole('status', { name: 'Import result' }).filter({ hasText: /Removed 2 links.*kept 1/ }).waitFor();
    await page.waitForFunction(() => { const s = JSON.parse(localStorage.getItem('library-store-v1')).state; return !s.purgeUrls.length && !Object.keys(s.pending).length; });
    const data = await api();
    assert.deepEqual(data.posts.map(p => p.url).sort(), ['https://food.example.invalid/soup', 'https://saved.example.invalid/page']);
    assert.deepEqual(data.deletedUrls, [], 'undo must not leave tombstones');
    assert.match(await page.locator('main').innerText(), /undone \(2 removed\)/);
  });
  await check('the same file imports again after an undo', async () => {
    await choose.setInputFiles({ name: 'Bookmarks', mimeType: 'application/octet-stream', buffer: Buffer.from(chromiumFile) });
    await preview.waitFor();
    const counts = await preview.locator('.import-counts dd').allInnerTexts();
    assert.equal(counts[0], '3');
    await preview.getByRole('button', { name: 'Cancel', exact: true }).click();
  });
  await check('Firefox JSON backup is detected and keeps root folder names', async () => {
    await choose.setInputFiles({ name: 'bookmarks-2026-09-30.json', mimeType: 'application/json', buffer: Buffer.from(firefoxJson) });
    await preview.waitFor();
    const text = await preview.innerText();
    assert.match(text, /Firefox bookmarks backup \(JSON\)/);
    assert.match(text, /Bookmarks Toolbar/);
    await preview.getByRole('button', { name: 'Cancel', exact: true }).click();
  });
  await check('a WhatsApp chat export is detected, previewed and imported as chat links', async () => {
    const chat = ['3/4/26, 10:00 AM - Me: https://www.tiktok.com/@kitchenlab/video/7412345 chickpeas',
      '3/4/26, 10:01 AM - Me: https://www.facebook.com/lisbonwalks/posts/1', '3/4/26, 10:02 AM - Me: <Media omitted>'].join('\n');
    await choose.setInputFiles({ name: 'WhatsApp Chat with Me.txt', mimeType: 'text/plain', buffer: Buffer.from(chat) });
    await preview.waitFor();
    assert.match(await preview.innerText(), /WhatsApp chat export/);
    await preview.getByRole('button', { name: /Import 2 new links/ }).click();
    await page.getByRole('status', { name: 'Import result' }).filter({ hasText: /2 new links imported/ }).waitFor();
    await page.waitForFunction(() => { const s = JSON.parse(localStorage.getItem('library-store-v1')).state; return !Object.keys(s.pending).length; });
    const fb = (await api()).posts.find(p => p.url === 'https://www.facebook.com/lisbonwalks/posts/1');
    assert.deepEqual([fb.source, fb.platform, fb.status, fb.folderPath], ['whatsapp', 'facebook', 'inbox', ['WhatsApp', 'Me']]);
  });
  await check('an unknown file is refused with guidance', async () => {
    await choose.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('just some notes') });
    await page.getByRole('status', { name: 'Import result' }).filter({ hasText: /isn't a bookmark export/ }).waitFor();
  });
  await check('no page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) { console.error(log.split('\n').filter(l => /Error|Traceback/.test(l)).slice(-10).join('\n')); throw new Error('import workflow failures: ' + failures.join(', ')); }
console.log(`PASS import workflow e2e; evidence ${evidence}`);
