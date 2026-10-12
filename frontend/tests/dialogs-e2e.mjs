// Keyboard behaviour of every dialog, in a browser (synthetic links, no network): Escape closes,
// Tab and Shift+Tab stay inside, focus goes back to what opened it; "/" focuses the search only
// without Ctrl, Alt or Cmd. From the pre-release review: Add link, Share, Manage categories and
// Undo import ignored Escape, and none of them (nor the command palette) kept focus inside.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importThroughField } from './importField.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(join(root, '.verify'), { recursive: true });
const evidence = await mkdtemp(join(root, '.verify', 'dialogs-'));
const port = 15000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.env.C4_PYTHON || 'python3', ['-B', '-c', `
import os, sys
sys.path.insert(0, ${JSON.stringify(root)})
os.environ["SAVED_POSTS_DB_PATH"] = ${JSON.stringify(join(evidence, 'fixture.sqlite'))}
os.environ["SBM_AI_CONFIG_FILE"] = ${JSON.stringify(join(evidence, 'ai.json'))}
os.environ["SBM_ARCHIVE_DIR"] = ${JSON.stringify(join(evidence, 'archive'))}
os.environ["SBM_SAVED_COPIES"] = "off"
import storage, app, metadata_fetcher
metadata_fetcher.fetch_metadata = lambda url: {"title": "", "summary": "", "thumbnail": "", "status": "empty", "error": ""}
storage.init_db()
app.app.run(host="127.0.0.1", port=${port}, debug=False, threaded=True)
`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
let serverLog = ''; server.stderr.on('data', c => { serverLog += c; });
const browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message.split('\n').slice(0, 4).join(' | ')}`); }
}

const post = (i, shelf) => {
  const at = new Date(Date.parse('2026-10-09T12:00:00Z') - i * 3600e3).toISOString();
  return { id: `dl-${i}`, url: `https://site${i}.example.invalid/page`, source: 'browser', platform: 'web', domain: `site${i}.example.invalid`,
    status: 'reference', createdAt: at, updatedAt: at, metadataStatus: 'enriched', enrichedAt: at, categories: [shelf],
    categoryMode: 'manual', tags: [], projectIds: [], title: `Synthetic page ${i}` };
};
const posts = [post(0, 'travel'), post(1, 'travel'), post(2, 'travel'), post(3, 'other')];

try {
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { try { up = (await fetch(base + '/api/stats')).ok; } catch {} if (!up) await new Promise(r => setTimeout(r, 100)); }
  assert.ok(up, 'server did not start: ' + serverLog.slice(-400));
  const seeded = await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts, deletedUrls: [] }) });
  assert.ok(seeded.ok, await seeded.text());
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const saved = () => page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /Library saved to SQLite/ }).waitFor();
  // In-app navigation (no reload), as when the owner clicks around.
  const go = async path => { await page.evaluate(to => { history.pushState({}, '', to); dispatchEvent(new PopStateEvent('popstate')); }, path); await page.waitForTimeout(300); };
  const inside = name => page.evaluate(label => !!document.activeElement?.closest(`[role="dialog"][aria-label="${label}"]`), name);
  const focused = () => page.evaluate(() => (document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent || '').trim());
  // Tab and Shift+Tab many times round: focus never leaves the dialog.
  const staysInside = async name => {
    for (const key of [...Array(9).fill('Tab'), ...Array(9).fill('Shift+Tab')]) {
      await page.keyboard.press(key);
      assert.ok(await inside(name), `${key} left the "${name}" dialog (focus on "${await focused()}")`);
    }
  };
  await page.goto(base + '/library/category/travel');
  await saved();
  await page.locator('article[data-post-id]').first().waitFor();

  await check('Add link: focus inside, Tab stays inside, Escape closes and focus goes back to the button', async () => {
    const opener = page.getByRole('button', { name: 'Add link' }).first();
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Add link' });
    await dialog.waitFor();
    assert.ok(await inside('Add link'));
    await staysInside('Add link');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached', timeout: 3000 });
    assert.match(await focused(), /Add link/);
  });

  await check('Share this shelf: Tab stays inside, Escape closes and focus goes back', async () => {
    const opener = page.getByRole('button', { name: 'Share this shelf' });
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Share as a page' });
    await dialog.waitFor();
    await staysInside('Share as a page');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached', timeout: 3000 });
    assert.match(await focused(), /Share this shelf/);
  });

  await check('Command palette: Tab stays inside, Escape closes', async () => {
    await page.locator('body').click({ position: { x: 700, y: 900 } });
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await dialog.waitFor();
    await staysInside('Command palette');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached', timeout: 3000 });
  });

  await check('"/" focuses the search, but not with Ctrl, Alt or Cmd held', async () => {
    const search = page.locator('input[placeholder^="Search…"]');
    for (const combo of ['Control+/', 'Alt+/', 'Meta+/']) {
      await page.locator('h1').click();
      await page.keyboard.press(combo);
      assert.equal(await search.evaluate(el => el === document.activeElement), false, `${combo} took focus to the search`);
    }
    await page.locator('h1').click();
    await page.keyboard.press('/');
    assert.equal(await search.evaluate(el => el === document.activeElement), true, '"/" should focus the search');
    assert.equal(await search.inputValue(), '', 'the "/" itself is not typed');
  });

  await check('Manage shelves: Escape while renaming cancels only the rename; Escape again closes', async () => {
    await go('/shelves');
    const opener = page.getByRole('button', { name: /Rename, recolour, reorder or archive shelves/ });
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Manage categories' });
    await dialog.waitFor();
    await staysInside('Manage categories');
    await dialog.getByRole('button', { name: /^travel/ }).dblclick();
    const rename = dialog.locator('input.input:not([placeholder])');
    await rename.fill('renamed-by-mistake');
    await page.keyboard.press('Escape');
    await rename.waitFor({ state: 'detached', timeout: 3000 });
    assert.equal(await dialog.isVisible(), true, 'the first Escape cancels the rename and keeps the dialog');
    assert.equal(await dialog.getByRole('button', { name: /^travel/ }).count(), 1, 'the name is unchanged');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached', timeout: 3000 });
    assert.match(await focused(), /Rename, recolour/);
    await saved();
    const shelves = (await (await fetch(base + '/api/categories')).json()).map(c => c.name);
    assert.ok(shelves.includes('travel') && !shelves.includes('renamed-by-mistake'), shelves.join(', '));
  });

  await check('Undo import: Tab stays inside; Escape keeps everything', async () => {
    await go('/library/settings');
    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>${[1, 2].map(i =>
      `<DT><A HREF="https://imported${i}.example.invalid/" ADD_DATE="1700000000">Imported ${i}</A>`).join('')}</DL><p>`;
    const imported = await importThroughField(page, { name: 'bookmarks.html', mimeType: 'text/html', buffer: Buffer.from(html) });
    assert.equal(imported.added, 2, imported.text);
    await page.getByRole('button', { name: 'Undo' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Undo import' });
    await dialog.waitFor();
    await staysInside('Undo import');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached', timeout: 3000 });
    await saved();
    const urls = (await (await fetch(base + '/api/library')).json()).posts.map(p => p.url);
    assert.ok(urls.includes('https://imported1.example.invalid/') && urls.includes('https://imported2.example.invalid/'), 'nothing was removed');
  });

  await check('no uncaught page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) { console.error(`FAILED ${failures.length}: ${failures.join('; ')} | evidence: ${evidence}`); process.exit(1); }
console.log(`ALL PASS | evidence: ${evidence}`);
