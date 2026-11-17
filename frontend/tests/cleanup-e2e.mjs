// Clean up and undo (v0.4.0 phase 6c, mockups in Claude outputs/v040-review/phase6c/): the same post saved twice
// merged into one, removed links remembered with Bring back, a new link of a removed post taking back what it had,
// and History, where an older batch can be undone while later ones stand. Synthetic data; nothing leaves the machine.
// Run from frontend/ after npm run build: node tests/cleanup-e2e.mjs (C4_PYTHON, C4_PLAYWRIGHT_MODULE)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(join(root, '.verify'), { recursive: true });
const evidence = await mkdtemp(join(root, '.verify', 'cleanup-'));
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

const day = n => new Date(Date.now() - n * 86400000).toISOString();
const link = (id, url, title, age, extra = {}) => ({ id, url, source: 'browser', platform: url.includes('example') ? 'web' : 'x', domain: new URL(url).hostname,
  status: 'inbox', createdAt: day(age), updatedAt: day(age), metadataStatus: 'partial', categories: ['food-drink'], categoryMode: 'manual', tags: [], projectIds: [], title, ...extra });
const seeded = await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deletedUrls: [], posts: [
  link('id-x', 'https://x.com/bakehouse_kit/status/1001', 'Shaping a batard', 2, { tags: ['bread'], userNotes: 'try at 75%' }),
  link('id-tw', 'https://twitter.com/bakehouse_kit/status/1001?s=20', 'Bakehouse Kit on X', 3, { tags: ['sourdough'] }),
  link('id-walks', 'https://walks.example.invalid/page', 'Ten walks near the city', 4, { categories: ['travel'], tags: ['walks'], userNotes: 'autumn' }),
  link('id-rye', 'https://x.com/ryetoast/status/3003', 'Rye ratios', 5, { tags: ['rye'], userNotes: 'the 80% one' })] }) });
assert.ok(seeded.ok, 'library seeded');
const library = async () => (await fetch(base + '/api/library')).json();
const stored = async () => Object.fromEntries((await library()).posts.map(p => [p.id, p]));
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
const panel = name => page.getByRole('region', { name });
const settings = async () => { await page.goto(`${base}/library/settings`); await page.locator('#cleanup').scrollIntoViewIfNeeded(); };

try {
  await check('the same post saved twice: listed, merged into the link chosen, the other remembered; Undo', async () => {
    await settings();
    const dupes = panel('The same post, saved twice');
    const group = dupes.getByRole('listitem', { name: 'X post 1001' });
    await group.waitFor();
    await group.getByRole('button', { name: 'Merge…' }).click();
    await group.getByRole('radio', { name: /^Shaping a batard/ }).check();
    await page.screenshot({ path: join(evidence, 'duplicates.png') });
    await group.getByRole('button', { name: 'Merge', exact: true }).click();
    await dupes.getByRole('status').getByText('Merged 2 links into “Shaping a batard”.').waitFor();
    await until(async () => { const s = await library(); return !s.posts.some(p => p.id === 'id-tw') && s.docs.removed?.length === 1; }, 'merged in SQLite');
    const s = await library();
    const kept = s.posts.find(p => p.id === 'id-x');
    assert.deepEqual([kept.tags, kept.createdAt.slice(0, 10)], [['bread', 'sourdough'], day(3).slice(0, 10)]);
    assert.deepEqual([s.docs.removed[0].how, s.docs.removed[0].into], ['merged', 'https://x.com/bakehouse_kit/status/1001']);
    await dupes.getByText('No post is saved twice.').waitFor();
    await dupes.getByRole('button', { name: 'Undo' }).click();
    await until(async () => { const t = await stored(); return t['id-tw'] && t['id-x'].tags.join() === 'bread'; }, 'undone in SQLite');
    await dupes.getByRole('listitem', { name: 'X post 1001' }).waitFor();
  });

  await check('removing links: Undo in the note, remembered in Removed links, and Bring back', async () => {
    await page.goto(`${base}/library`);
    await page.locator('article.tile', { hasText: 'Ten walks near the city' }).getByRole('checkbox', { name: 'Select post' }).check();
    const bar = page.getByRole('toolbar', { name: 'Bulk actions' });
    await bar.getByRole('button', { name: 'Delete' }).click();
    await bar.getByRole('button', { name: 'Confirm' }).click();
    await page.getByRole('status').filter({ hasText: 'Removed 1 item' }).waitFor();
    await until(async () => { const s = await library(); return !s.posts.some(p => p.id === 'id-walks') && s.docs.removed?.some(r => r.post.id === 'id-walks'); }, 'removed in SQLite, remembered');
    await settings();
    const removed = panel('Removed links');
    const row = removed.getByRole('listitem', { name: 'Ten walks near the city' });
    await row.getByText(/removed .* · a note, #walks, the shelf travel/).waitFor();
    await page.screenshot({ path: join(evidence, 'removed-links.png') });
    await row.getByRole('button', { name: 'Bring back' }).click();
    await removed.getByRole('status').getByText('“Ten walks near the city” is back, as it was.').waitFor();
    await until(async () => { const s = await stored(); return s['id-walks']?.userNotes === 'autumn'; }, 'back in SQLite with its note');
    const s = await library();
    assert.equal(s.docs.removed.some(r => r.post.id === 'id-walks'), false, 'the record is gone');
  });

  await check('a new link of a removed post takes back what the old one had', async () => {
    await page.goto(`${base}/library/item/id-rye`);
    await page.getByRole('button', { name: 'Delete' }).first().click();
    await page.getByRole('button', { name: 'Confirm delete' }).click();
    await until(async () => !(await stored())['id-rye'], 'removed in SQLite');
    await page.goto(`${base}/library`);
    await page.getByRole('button', { name: 'Add link' }).first().click();
    await page.getByRole('dialog', { name: 'Add link' }).getByPlaceholder('https://…').fill('https://twitter.com/ryetoast/status/3003');
    await page.getByRole('button', { name: 'Save link', exact: true }).click();
    const note = page.getByRole('note', { name: 'Removed before' });
    await note.getByText('Bring back what it had: a note, #rye, the shelf food-drink?').waitFor();
    await page.screenshot({ path: join(evidence, 'reattach.png') });
    await note.getByRole('button', { name: 'Bring them back' }).click();
    await note.waitFor({ state: 'detached' });
    await until(async () => Object.values(await stored()).some(p => p.url === 'https://twitter.com/ryetoast/status/3003' && p.userNotes === 'the 80% one' && p.tags.includes('rye')),
      'the new link holds the note and tag in SQLite');
  });

  await check('History: an older batch is undone while a later one stands; it survives a reload', async () => {
    await settings();
    const history = panel('History');
    await history.getByRole('listitem', { name: 'Removed 1 link' }).first().waitFor();
    // Newest first: the removal of "Rye ratios", the removal of "Ten walks" (brought back), the merge (undone in the first check).
    const rows = await history.getByRole('listitem').evaluateAll(items => items.map(li => li.getAttribute('aria-label')));
    assert.deepEqual(rows.slice(0, 3), ['Removed 1 link', 'Removed 1 link', 'Merged 2 links of one post into “Shaping a batard”']);
    await page.reload();
    await page.locator('#cleanup').scrollIntoViewIfNeeded();
    const merged = history.getByRole('listitem', { name: 'Merged 2 links of one post into “Shaping a batard”' });
    await merged.getByText(/undone; 2 put back/).waitFor();
    // The removal of "Rye ratios": its record went into the new link (Bring them back), so nothing comes back.
    await history.getByRole('listitem', { name: 'Removed 1 link' }).first().getByRole('button', { name: 'Undo' }).click();
    await history.getByRole('status').getByText('Undid “Removed 1 link”: 0 links put back; 1 already in the library again or no longer remembered.').waitFor();
    // Merge again, then remove "Ten walks" again; undo the merge (the older batch) while the removal stands.
    const dupes = panel('The same post, saved twice');
    await dupes.getByRole('listitem', { name: 'X post 1001' }).getByRole('button', { name: 'Merge…' }).click();
    await dupes.getByRole('button', { name: 'Merge', exact: true }).click();
    await until(async () => { const s = await stored(); return !s['id-x'] || !s['id-tw']; }, 'merged again');
    await page.goto(`${base}/library`);
    await page.locator('article.tile', { hasText: 'Ten walks near the city' }).getByRole('checkbox', { name: 'Select post' }).check();
    await page.getByRole('toolbar', { name: 'Bulk actions' }).getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('toolbar', { name: 'Bulk actions' }).getByRole('button', { name: 'Confirm' }).click();
    await until(async () => !(await stored())['id-walks'], 'removed again');
    await settings();
    await page.screenshot({ path: join(evidence, 'history.png') });
    const merge = history.getByRole('listitem', { name: /^Merged 2 links of one post/ }).first();
    await merge.getByRole('button', { name: 'Undo' }).click();
    await history.getByRole('status').getByText(/^Undid “Merged 2 links of one post into .*”: 2 links put back\.$/).waitFor();
    await until(async () => { const s = await stored(); return s['id-x'] && s['id-tw']; }, 'the merge undone in SQLite');
    assert.equal((await stored())['id-walks'], undefined, 'the later removal stands');
  });

  await check('no page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await context.close();
  await browser.close();
  server.kill();
}
if (failures.length) { console.error(`FAILED ${failures.length} | evidence: ${evidence}`); if (serverLog.includes('Traceback')) console.error(serverLog.slice(-2000)); process.exit(1); }
console.log(`ALL PASS | evidence: ${evidence}`);
