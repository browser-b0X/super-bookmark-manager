// Follow up by <day> and "use often" (phase 5 step 4): the Home card and quick row,
// tile badges, the link panel, the Follow up list in All shelves and search.
// Synthetic data only, on an owned loopback server.
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
const evidence = await mkdtemp(join(root, '.verify', 'follow-up-'));
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
const pad = n => String(n).padStart(2, '0');
const day = offset => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const post = (n, changes = {}) => ({ id: `nav-${n}`, url: `https://example.org/${n}`, source: 'manual', platform: 'web', domain: 'example.org',
  status: n <= 3 ? 'inbox' : 'reference', title: `Synthetic link ${n}`, categories: [n % 2 ? 'travel' : 'technology'], tags: [], projectIds: [],
  favorite: n === 5, createdAt: `2026-10-0${n}T10:00:00Z`, updatedAt: `2026-10-0${n}T10:00:00Z`, metadataStatus: 'enriched', ...changes });
try {
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { try { up = (await fetch(base + '/api/stats')).ok; } catch {} if (!up) await new Promise(r => setTimeout(r, 100)); }
  assert.ok(up, 'server did not start: ' + serverLog.slice(-400));
  const posts = [post(1), post(2), post(3), post(4, { title: 'Overdue reply', followUpAt: day(-6) }), post(5, { title: 'Due today item', followUpAt: day(0) }),
    post(6, { title: 'Next week item', followUpAt: day(7) }), post(7, { title: 'Daily dashboard', useOften: true, openCount: 4 }),
    post(8, { title: 'Archived but dated', status: 'archived', followUpAt: day(-1) })];
  assert.deepEqual((await (await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts, deletedUrls: [] }) })).json()).rejected, []);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/');
  await page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /Library saved to SQLite/ }).waitFor();
  const bar = page.locator('header.topnav');
  const sections = page.getByRole('navigation', { name: 'Sections' });

  const stored = async id => (await (await fetch(base + '/api/library')).json()).posts.find(p => p.id === id);
  const waitStored = async (id, test, what) => {
    for (let i = 0; i < 60; i++) { const p = await stored(id); if (test(p)) return p; await page.waitForTimeout(100); }
    throw new Error(`not saved to SQLite: ${what}: ${JSON.stringify(await stored(id))}`);
  };

  await check('Home: Follow up card lists what is due, overdue first; Done moves it to Kept', async () => {
    const card = page.getByRole('region', { name: 'Follow up' });
    assert.deepEqual(await card.locator('.up-next__item b').allTextContents(), ['Overdue reply', 'Due today item']);
    assert.match(await card.innerText(), /Overdue 6 days[\s\S]*Due today/);
    assert.match(await card.getByRole('link', { name: /See all follow-ups/ }).getAttribute('href'), /status=followup/);
    await page.screenshot({ path: join(evidence, 'home.png') });
    await card.getByRole('button', { name: 'Done: Overdue reply' }).click();
    const saved = await waitStored('nav-4', p => p.status === 'reference' && !('followUpAt' in p), 'done');
    assert.equal(saved.status, 'reference');
    assert.deepEqual(await card.locator('.up-next__item b').allTextContents(), ['Due today item']);
  });

  await check('Use often: the quick row opens the link and counts the open', async () => {
    const row = page.getByRole('navigation', { name: 'Use often' });
    const link = row.getByRole('link', { name: /Daily dashboard/ });
    assert.equal(await link.getAttribute('href'), 'https://example.org/7');
    assert.equal(await link.getAttribute('target'), '_blank');
    await context.route('https://example.org/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: 'ok' }));
    const popup = context.waitForEvent('page'); await link.click(); await (await popup).close();
    await waitStored('nav-7', p => p.openCount === 5 && p.lastOpenedAt, 'open count');
  });

  await check('link panel: presets, a picked date, the tile badge, No follow-up and Use often', async () => {
    await page.goto(base + '/library/item/nav-1');
    const panel = page.getByRole('dialog', { name: 'Saved post detail' });
    const group = panel.getByRole('group', { name: 'Follow up' });
    await group.getByRole('button', { name: 'In a week' }).click();
    await waitStored('nav-1', p => p.followUpAt === day(7), 'in a week');
    assert.equal(await group.getByRole('button', { name: /In a week/ }).getAttribute('aria-pressed'), 'true');
    await group.getByLabel('Pick a follow-up date').fill(day(10));
    await waitStored('nav-1', p => p.followUpAt === day(10), 'picked date');
    await panel.screenshot({ path: join(evidence, 'panel.png') });
    await panel.getByRole('switch', { name: 'Use often' }).click();
    await waitStored('nav-1', p => p.useOften === true, 'use often');
    await page.keyboard.press('Escape'); await page.waitForURL(u => !u.pathname.includes('/item/'));   // the panel closes before the next page
    await page.goto(base + '/library');
    const tile = page.locator('article[data-post-id="nav-1"]');
    await tile.locator('.tile__due').waitFor();
    assert.match(await tile.locator('.tile__due').innerText(), /\w{3} \d{1,2} \w{3}/);
    assert.equal(await tile.getByRole('img', { name: 'Use often' }).count(), 1);
    assert.equal(await page.locator('article[data-post-id="nav-8"] .tile__due').count(), 0, 'archived links get no badge');
    await page.screenshot({ path: join(evidence, 'library.png') });
    await page.goto(base + '/library/item/nav-1');
    await page.getByRole('group', { name: 'Follow up' }).getByRole('button', { name: 'No follow-up' }).click();
    await waitStored('nav-1', p => !('followUpAt' in p), 'cleared');
    await page.keyboard.press('Escape'); await page.waitForURL(u => !u.pathname.includes('/item/'));   // the panel closes before the next page
  });

  await check('All shelves: Follow up shows what is due; the list is in day order without archived links', async () => {
    await page.goto(base + '/shelves');
    const item = page.getByRole('link', { name: 'Follow up 1 due' });
    await item.click();
    await page.waitForURL(/status=followup/);
    assert.equal((await page.locator('main h1').first().innerText()).trim(), 'Follow up');
    await page.locator('main article[data-post-id]').first().waitFor();
    assert.deepEqual(await page.locator('main article[data-post-id]').evaluateAll(a => a.map(e => e.dataset.postId)), ['nav-5', 'nav-6']);
  });

  await check('search: is:due and is:often', async () => {
    await page.goto(base + '/library?q=' + encodeURIComponent('is:due'));
    await page.locator('main article[data-post-id]').first().waitFor();
    assert.deepEqual(await page.locator('main article[data-post-id]').evaluateAll(a => a.map(e => e.dataset.postId)), ['nav-5']);
    await page.goto(base + '/library?q=' + encodeURIComponent('is:often'));
    await page.locator('main article[data-post-id]').first().waitFor();
    assert.deepEqual(await page.locator('main article[data-post-id]').evaluateAll(a => a.map(e => e.dataset.postId).sort()), ['nav-1', 'nav-7'], 'nav-1 was marked in the panel check');
  });

  await check('no page errors', async () => { assert.deepEqual(errors, []); });
  await context.close();
} catch (error) {
  failures.push('setup'); console.error('FAIL setup:', error.message);
} finally {
  await browser.close();
  server.kill();
}
console.log(failures.length ? `FAILED ${failures.length} | evidence: ${evidence}` : `ALL PASS | evidence: ${evidence}`);
process.exit(failures.length ? 1 : 0);
