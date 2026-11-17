// The Claude Desktop extension seen from the app (v0.4.0 phase 5, mockups in Claude outputs/v040-review/phase5/):
// Settings → AI providers → Claude Desktop makes a token (shown once) and lists what Claude Desktop changed, each with
// Undo, and the shelves it suggests; the note offers Undo and Keep; a link the tab hasn't saved yet is kept from
// Claude Desktop's writes. Claude Desktop's server is played by this script (its requests, token and proof as the
// real server makes them). Synthetic data; nothing leaves the machine.
// Run from frontend/ after npm run build: node tests/claude-desktop-e2e.mjs (C4_PYTHON, C4_PLAYWRIGHT_MODULE)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(join(root, '.verify'), { recursive: true });
const evidence = await mkdtemp(join(root, '.verify', 'claude-desktop-'));
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
const link = (name, title, shelf) => ({ id: `id-${name}`, url: `https://${name}.example.invalid/page`, source: 'browser', platform: 'web',
  domain: `${name}.example.invalid`, status: 'inbox', createdAt: at, updatedAt: at, metadataStatus: 'partial',
  categories: shelf ? [shelf] : [], categoryMode: 'manual', tags: [], projectIds: [], title });
const seeded = await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deletedUrls: [], posts: [
  link('bread', 'Slow bread: a sourdough schedule', 'food-drink'), link('rye', 'Rye crackers from leftover starter'),
  link('loaf', 'Overnight loaf, 78% hydration'), link('walks', 'Ten walks within an hour of the city')] }) });
assert.ok(seeded.ok, 'library seeded');

/** Claude Desktop's server: the app proves itself first (HMAC of the nonce and its address), then the call. */
let token = '';
async function claude(path, body) {
  const key = createHash('sha256').update(token).digest('hex');
  const kid = createHash('sha256').update(key).digest('hex').slice(0, 16);
  const nonce = randomBytes(16).toString('hex');
  const hello = await (await fetch(`${base}/api/mcp/hello?nonce=${nonce}&kid=${kid}`)).json();
  assert.equal(hello.proof, createHmac('sha256', key).update(`${nonce}|${base}`).digest('hex'), 'the app proves itself');
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET',
    headers: { 'X-SBM-Claude': token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}

const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message.split('\n').slice(0, 8).join(' | ')}`); }
}
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
const errors = []; context.on('weberror', e => errors.push(e.error().message));
const page = await context.newPage();
const shelvesOf = () => page.evaluate(() => {
  const state = JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.endsWith('library-store-v1')))).state;
  return Object.fromEntries(state.posts.map(p => [p.id, p.categories]));
});
// The tab asks the app every 15 seconds; being shown again asks at once.
const askNow = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
const row = page.getByRole('listitem', { name: 'Claude Desktop' });
const note = page.getByRole('status', { name: 'Changes from Claude Desktop' });
const waitFor = async (test, what, timeout = 10000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise(r => setTimeout(r, 200));
  }
};

try {
  await check('Settings: a token made once, shown once; connected', async () => {
    await page.goto(`${base}/library/settings#ai`);
    await row.waitFor();
    await row.getByText('Not connected yet').waitFor();
    await row.getByRole('button', { name: /Claude Desktop/ }).click();
    await row.getByText('What Claude reads from your library becomes part of your chat with Claude.', { exact: false }).waitFor();
    await row.getByRole('link', { name: /release page/ }).waitFor();
    await row.getByRole('button', { name: 'Make a token' }).click();
    token = (await row.getByLabel('New token').textContent()).trim();
    assert.match(token, /^sbm_cd_[A-Za-z0-9_-]{40,}$/);
    await row.getByText('Connected · not used yet').waitFor();
    await page.screenshot({ path: join(evidence, 'settings-token.png') });
    assert.equal((await claude('/api/mcp/shelves')).status, 200, 'the token works');
    await page.reload();
    await row.waitFor();
    await row.getByRole('button', { name: /Claude Desktop/ }).click();
    await row.getByText(/Connected · last used/).waitFor();
    assert.equal(await row.getByLabel('New token').count(), 0, 'shown only once');
    await row.getByRole('button', { name: 'Disconnect' }).waitFor();
  });

  await check('Claude Desktop files links: the tab reads them, the note offers Undo, Undo puts them back', async () => {
    const filed = await claude('/api/mcp/file', { ids: ['id-rye', 'id-loaf'], shelf: 'food-drink', tags: ['sourdough'] });
    assert.equal(filed.status, 200, JSON.stringify(filed.data));
    await askNow();
    await note.getByText('Claude Desktop filed 2 links on food-drink').waitFor();
    await waitFor(async () => (await shelvesOf())['id-rye']?.includes('food-drink'), 'the tab shows the change');
    await row.getByRole('list', { name: 'Changes from Claude Desktop' }).getByText(/Filed 2 links on food-drink/).waitFor();
    await page.screenshot({ path: join(evidence, 'note.png') });
    await note.getByRole('button', { name: 'Undo' }).click();
    await waitFor(async () => !(await shelvesOf())['id-rye']?.includes('food-drink'), 'the tab shows them unfiled again');
    assert.deepEqual((await shelvesOf())['id-loaf'], []);
    await waitFor(async () => !(await note.textContent()).includes('filed'), 'the note goes');
    await row.getByRole('list', { name: 'Changes from Claude Desktop' }).getByText(/Filed 2 links on food-drink.*undone/).waitFor();
  });

  await check('Keep: the note goes, and Settings can still undo the change', async () => {
    assert.equal((await claude('/api/mcp/file', { ids: ['id-walks'], shelf: 'travel' })).status, 200);
    await askNow();
    await note.getByText('Claude Desktop filed 1 link on travel').waitFor();
    await note.getByRole('button', { name: 'Keep' }).click();
    await waitFor(async () => !(await note.textContent()).includes('travel'), 'the note goes');
    assert.deepEqual((await shelvesOf())['id-walks'], ['travel'], 'kept');
    await row.getByRole('button', { name: 'Undo: Filed 1 link on travel' }).click();
    await waitFor(async () => (await shelvesOf())['id-walks']?.length === 0, 'undone from Settings');
  });

  await check('a suggested shelf: made only with the owner\'s click, its links filed on it', async () => {
    const suggested = await claude('/api/mcp/suggest', { name: 'Sourdough', description: 'Starters and loaves', ids: ['id-rye', 'id-loaf'] });
    assert.equal(suggested.status, 200, JSON.stringify(suggested.data));
    await askNow();
    const list = row.getByRole('list', { name: 'Shelves Claude Desktop suggests' });
    await page.reload();
    await row.getByText('1 suggestion').waitFor();
    await list.getByText('sourdough').waitFor();
    await page.screenshot({ path: join(evidence, 'suggestion.png') });
    await list.getByRole('button', { name: 'Create it' }).click();
    await row.getByText('Shelf made and 2 links filed on it.').waitFor();
    await waitFor(async () => (await shelvesOf())['id-loaf']?.includes('sourdough'), 'the tab shows the new shelf');
    assert.equal(await note.getByText('sourdough').count(), 0, 'the owner\'s own click needs no note');
  });

  await check('a link this tab hasn\'t saved yet: Claude Desktop is told to wait', async () => {
    let hold;
    const held = new Promise(resolve => { hold = resolve; });
    // The tab's saves wait (a slow moment), so the edit stays unsaved for a while.
    const saves = url => url.pathname === '/api/library';
    await page.route(saves, async route => {
      if (route.request().method() === 'POST') await held;
      await route.continue();
    });
    await page.goto(`${base}/library/item/id-bread`);
    const reported = page.waitForRequest(r => r.url().endsWith('/api/library/pending') && (r.postDataJSON()?.urls ?? []).includes('https://bread.example.invalid/page'));
    await page.getByRole('button', { name: 'Favorite', exact: true }).first().click();
    await reported;
    const busy = await claude('/api/mcp/file', { ids: ['id-bread'], shelf: 'travel' });
    assert.equal(busy.status, 409, JSON.stringify(busy.data));
    assert.match(busy.data.error, /hasn't saved its changes to 1 of these links/);
    hold();
    await page.unroute(saves);
    await waitFor(async () => (await claude('/api/mcp/file', { ids: ['id-bread'], shelf: 'travel' })).status === 200, 'allowed once saved', 20000);
    const bread = (await (await fetch(base + '/api/library')).json()).posts.find(p => p.id === 'id-bread');
    assert.equal(bread.favorite, true, 'the owner\'s change is kept');
    assert.deepEqual(bread.categories, ['food-drink', 'travel']);
  });

  await check('no page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await context.close();
  await browser.close();
  server.kill();
}
if (failures.length) { console.error(`FAILED ${failures.length} | evidence: ${evidence}`); if (serverLog.includes('Traceback')) console.error(serverLog.slice(-2000)); process.exit(1); }
console.log(`ALL PASS | evidence: ${evidence}`);
