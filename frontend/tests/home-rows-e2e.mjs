// Home and Settings refinements (v0.3.0, owner 2026-10-09): the layout switch only on Home,
// shelf rows that drift on hover and slide by hand, one import field, Telegram refresh first,
// and the per-site table of what social posts keep. Synthetic data only, on an owned loopback server.
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
const evidence = await mkdtemp(join(root, '.verify', 'home-rows-'));
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
const post = (n, changes = {}) => ({ id: `nav-${n}`, url: `https://example.org/${n}`, source: 'manual', platform: 'web', domain: 'example.org',
  status: n <= 3 ? 'inbox' : 'reference', title: `Synthetic link ${n}`, categories: [n % 2 ? 'travel' : 'technology'], tags: [], projectIds: [],
  favorite: n === 5, createdAt: `2026-10-0${n}T10:00:00Z`, updatedAt: `2026-10-0${n}T10:00:00Z`, metadataStatus: 'enriched', ...changes });
try {
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { try { up = (await fetch(base + '/api/stats')).ok; } catch {} if (!up) await new Promise(r => setTimeout(r, 100)); }
  assert.ok(up, 'server did not start: ' + serverLog.slice(-400));
  const foods = ['Ten cheap weeknight dinners', 'A field guide to wild garlic', 'Sourdough, explained slowly', 'The best knife for small kitchens',
    'Why your rice is gummy', 'One-pan lemon chicken', 'Coffee ratios that work', 'Pickling anything in a day', 'The case for cast iron',
    'Soup stock from scraps', 'Tomato season notes', 'Bread flour vs plain flour'];
  const posts = [post(1), ...foods.map((title, i) => post(10 + i, { id: `food-${i}`, url: `https://example.org/food/${i}`, title, status: 'reference',
    categories: ['food-drink'], createdAt: new Date(Date.now() - (i + 1) * 86400000).toISOString() }))];
  assert.deepEqual((await (await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts, deletedUrls: [] }) })).json()).rejected, []);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/');
  await page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /Library saved to SQLite/ }).waitFor();
  const bar = page.locator('header.topnav');
  const sections = page.getByRole('navigation', { name: 'Sections' });

  await check('the Portrait/Wide switch is only on Home: elsewhere it slides away and leaves the keyboard path', async () => {
    const seg = bar.locator('.topnav__seg');
    const visible = () => seg.evaluate(el => ({ away: el.classList.contains('is-away'), visibility: getComputedStyle(el).visibility,
      width: el.getBoundingClientRect().width, hidden: el.getAttribute('aria-hidden'), tab: [...el.querySelectorAll('button')].map(b => b.tabIndex) }));
    let now = await visible();
    assert.deepEqual([now.away, now.visibility, now.hidden], [false, 'visible', null]); assert.ok(now.width > 100);
    await sections.getByRole('link', { name: 'All shelves' }).click(); await page.waitForURL(/\/shelves$/);
    await seg.evaluate(el => Promise.all(el.getAnimations().map(a => a.finished.catch(() => {}))));
    await page.waitForTimeout(450);
    now = await visible();
    assert.deepEqual([now.away, now.visibility, now.hidden, now.width, now.tab.join()], [true, 'hidden', 'true', 0, '-1,-1']);
    assert.equal(await page.getByRole('radiogroup', { name: 'Home layout' }).count(), 0, 'gone for screen readers');
    await bar.screenshot({ path: join(evidence, 'bar-away.png') });
    await sections.getByRole('link', { name: 'Home' }).click(); await page.waitForURL(u => u.pathname === '/');
    await page.waitForTimeout(450);
    now = await visible();
    assert.deepEqual([now.away, now.visibility], [false, 'visible']);
  });

  await check('shelf rows: no scrollbar, a slow drift on hover, click-and-hold slides without opening a card, a click still opens', async () => {
    await page.goto(base + '/');
    const track = page.getByRole('list', { name: 'food-drink: newest links' });
    await track.waitFor();
    const info = () => track.evaluate(el => ({ left: el.scrollLeft, max: el.scrollWidth - el.clientWidth, bar: el.offsetHeight - el.clientHeight,
      width: getComputedStyle(el).scrollbarWidth, cls: el.className }));
    let now = await info();
    assert.ok(now.max > 200, 'the row overflows: ' + JSON.stringify(now));
    assert.equal(now.width, 'none'); assert.equal(now.bar, 0, 'no scrollbar');
    assert.match(now.cls, /has-more-right/); assert.doesNotMatch(now.cls, /has-more-left/);
    const box = await track.boundingBox();
    await track.scrollIntoViewIfNeeded();
    const b2 = await track.boundingBox();
    await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
    await page.waitForTimeout(2600);
    const drifted = (await info()).left;
    assert.ok(drifted > 20, 'drifts on hover: ' + drifted);
    await page.mouse.move(b2.x + b2.width / 2, b2.y - 60); await page.waitForTimeout(600);
    const stopped = (await info()).left; await page.waitForTimeout(600);
    assert.equal((await info()).left, stopped, 'stops when the pointer leaves');
    // press and hold, then slide left by 300 px: the row moves, no card opens
    await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(b2.x + b2.width / 2 - i * 30, b2.y + b2.height / 2);
    await page.mouse.up();
    await page.waitForTimeout(200);
    assert.equal(new URL(page.url()).pathname, '/', 'a drag does not open the card');
    assert.ok((await info()).left > stopped + 200, 'slid by hand');
    assert.match((await info()).cls, /has-more-left/);
    await page.screenshot({ path: join(evidence, 'rows-slid.png') });
    // an ordinary click opens the card
    await page.mouse.move(b2.x + b2.width / 2, b2.y - 60);
    await track.getByRole('listitem').nth(6).click();
    await page.waitForURL(/\/library\/item\//);
    await page.keyboard.press('Escape');
  });

  await check('the drift stays off with reduced motion', async () => {
    const quiet = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const p = await quiet.newPage(); await p.goto(base + '/');
    const track = p.getByRole('list', { name: 'food-drink: newest links' }); await track.scrollIntoViewIfNeeded();
    const b = await track.boundingBox(); await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await p.waitForTimeout(2000);
    assert.equal(await track.evaluate(el => el.scrollLeft), 0);
    await quiet.close();
  });

  await check('Settings: one import field, Telegram refresh before the manual export', async () => {
    await page.goto(base + '/library/settings');
    const sources = page.locator('#sources');
    assert.equal(await sources.getByLabel('Choose a file to import').count(), 1);
    assert.equal(await sources.getByText('Other import formats').count(), 0);
    for (const gone of ['Import bookmarks HTML', 'Select copied Firefox places.sqlite', 'Select copied Chromium Bookmarks file'])
      assert.equal(await page.getByLabel(gone).count(), 0, gone);
    const telegram = page.getByRole('region', { name: 'Telegram Saved Messages' });
    const order = await telegram.evaluate(el => {
      const refresh = [...el.querySelectorAll('button')].find(b => /Refresh Telegram Saved Messages/.test(b.textContent));
      const manual = el.querySelector('input[aria-label="Import Telegram JSON"]');
      return refresh && manual ? refresh.compareDocumentPosition(manual) & Node.DOCUMENT_POSITION_FOLLOWING : 0;
    });
    assert.ok(order, 'Refresh comes first, the result.json import after it');
    // The per-site table sits in Saved copies, which this fixture turns off: social-posts-e2e checks it.
    await telegram.screenshot({ path: join(evidence, 'telegram.png') });
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
