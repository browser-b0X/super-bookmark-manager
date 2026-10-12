// Screen fixes from the v0.3.0 review: a link opened in a new tab can be closed, Enter on a
// Home deck button acts instead of opening the link, and a day-only date shows the day as
// written in the Americas. Synthetic data only, on an owned loopback server.
// Run from frontend/: node tests/review-fixes-e2e.mjs (C4_PLAYWRIGHT_MODULE, C4_PYTHON optional)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(join(root, '.verify'), { recursive: true });
const evidence = await mkdtemp(join(root, '.verify', 'review-fixes-'));
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
app.app.run(host="127.0.0.1", port=${port}, debug=False)
`], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
let serverLog = ''; server.stderr.on('data', c => { serverLog += c; });
const browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message.split('\n').slice(0, 6).join(' | ')}`); }
}
const post = (n, changes = {}) => ({ id: `rv-${n}`, url: `https://example.org/review/${n}`, source: 'manual', platform: 'web', domain: 'example.org',
  status: 'inbox', title: `Synthetic link ${n}`, categories: ['technology'], tags: [], projectIds: [], favorite: false,
  createdAt: `2026-10-0${n}T10:00:00Z`, updatedAt: `2026-10-0${n}T10:00:00Z`, metadataStatus: 'enriched', ...changes });
const saved = page => page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /Library saved to SQLite/ }).waitFor();
const stored = page => page.evaluate(() => JSON.parse(localStorage.getItem('library-store-v1') || '{}').state?.posts ?? []);
try {
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { try { up = (await fetch(base + '/api/stats')).ok; } catch {} if (!up) await new Promise(r => setTimeout(r, 100)); }
  assert.ok(up, 'server did not start: ' + serverLog.slice(-400));
  const posts = [post(1), post(2), post(3),
    post(4, { status: 'reference', title: 'A page that gives only a day', siteName: 'Example Daily', publishedAt: '2026-03-04T00:00:00Z' })];
  const answer = await (await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts, deletedUrls: [] }) })).json();
  assert.deepEqual(answer.rejected, []);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US', timezoneId: 'America/New_York', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/');
  await saved(page);

  await check('a link opened in a new tab (nothing to go back to) closes to the library', async () => {
    // As the Save window's "Open in the app" does: a new tab whose history holds only this link.
    const [tab] = await Promise.all([context.waitForEvent('page'),
      page.evaluate(url => { window.open(url, '_blank', 'noopener'); }, base + '/library/item/rv-2')]);
    tab.on('pageerror', e => errors.push(e.message));
    await tab.waitForLoadState();
    assert.equal(await tab.evaluate(() => window.history.length), 1, 'precondition: a fresh tab');
    const dialog = tab.getByRole('dialog', { name: 'Saved post detail' });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await tab.waitForURL(u => u.pathname === '/library', { timeout: 5000 });
    assert.equal(await dialog.count(), 0);
    await tab.screenshot({ path: join(evidence, 'closed-to-library.png') });
    await tab.close();
  });

  await check('Enter on a focused Home deck button acts on the card instead of opening the link', async () => {
    await page.goto(base + '/');
    const archive = page.getByRole('button', { name: 'Archive: Synthetic link 3', exact: true });
    await archive.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('library-store-v1') || '{}').state?.posts
      .find(p => p.id === 'rv-3')?.status === 'archived', null, { timeout: 5000 });
    assert.equal(new URL(page.url()).pathname, '/', 'still on Home');
    assert.equal(await page.getByRole('dialog', { name: 'Saved post detail' }).count(), 0, 'the link did not open');
    assert.equal((await stored(page)).find(p => p.id === 'rv-2').status, 'inbox', 'only the current card moved');
  });

  await check('a day-only published date shows the day as written, not the evening before (New York)', async () => {
    await page.goto(base + '/library/item/rv-4');
    const dialog = page.getByRole('dialog', { name: 'Saved post detail' });
    await dialog.waitFor();
    const line = await dialog.locator('.site-line').first().innerText();
    assert.match(line, /Example Daily · Mar 4\b/);
    assert.doesNotMatch(line, /Mar 3\b/);
  });

  await check('no uncaught page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) { console.error(`FAILED ${failures.length}: ${failures.join('; ')} | evidence: ${evidence}`); process.exit(1); }
console.log(`ALL PASS | evidence: ${evidence}`);
