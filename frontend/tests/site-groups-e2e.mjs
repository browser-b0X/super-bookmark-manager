// Links grouped by website, in a browser (synthetic links, no network): the offer on "other",
// site rows biggest first, moving a whole site onto a shelf with Undo, and the choice
// remembered; on any shelf too (owner, mockup p17): an offer on big shelves, and moving a site
// takes its links off that shelf.
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
const evidence = await mkdtemp(join(root, '.verify', 'site-groups-'));
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

let n = 0;
const post = (domain, extra = {}) => {
  const i = n++;
  const at = new Date(Date.parse('2026-10-09T12:00:00Z') - i * 3600e3).toISOString();
  return { id: `sg-${i}`, url: `https://${domain}/page/${i}`, source: 'browser', platform: 'web', domain, status: 'reference', createdAt: at, updatedAt: at,
    metadataStatus: 'enriched', enrichedAt: at, categories: ['other'], categoryMode: 'automatic', categoryReview: true, tags: [], projectIds: [],
    title: `${domain} page ${i}`, ...extra };
};
const posts = [
  ...Array.from({ length: 5 }, () => post('docs.example.com')),
  ...Array.from({ length: 3 }, () => post('recipes.example.org')),
  post('www.video.example'), post('m.video.example'),                       // one site, however it was written
  ...['a', 'b', 'c', 'd', 'e', 'f'].map(x => post(`${x}-single.example`)),
  post('kept.example', { categories: ['travel'], categoryMode: 'manual', categoryReview: false }),
];
// A big shelf: 42 links on technology, one of them also on travel.
const onTech = { categories: ['technology'], categoryMode: 'manual', categoryReview: false };
const tech = [
  ...Array.from({ length: 20 }, (_, i) => post('code.example.com', i === 0 ? { ...onTech, categories: ['technology', 'travel'] } : onTech)),
  ...Array.from({ length: 12 }, () => post('talks.example.net', onTech)),
  ...Array.from({ length: 10 }, (_, i) => post(`t${i}-single.example`, onTech)),
];
posts.push(...tech);
const codeIds = tech.slice(0, 20).map(p => p.id);

try {
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { try { up = (await fetch(base + '/api/stats')).ok; } catch {} if (!up) await new Promise(r => setTimeout(r, 100)); }
  assert.ok(up, 'server did not start: ' + serverLog.slice(-400));
  const seeded = await fetch(base + '/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts, deletedUrls: [] }) });
  assert.ok(seeded.ok, await seeded.text());
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1200 } })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const saved = () => page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /Library saved to SQLite/ }).waitFor();
  const open = async () => {
    if (page.url().startsWith(base)) await page.reload(); else await page.goto(base + '/library/category/other');
    await saved();
  };
  const count = async () => Number((await page.locator('h1 + .chip').innerText()).trim());
  const groups = () => page.locator('.site-groups section.site-group');
  const library = async () => Object.fromEntries((await (await fetch(base + '/api/library')).json()).posts.map(p => [p.id, p]));
  await open();

  await check('"other" offers to group its links by website, naming the biggest sites', async () => {
    const offer = page.getByRole('note').filter({ hasText: /aren't on a shelf yet/ });
    await offer.waitFor();
    const text = (await offer.innerText()).replace(/\s+/g, ' ');
    assert.match(text, /16 links here aren't on a shelf yet/);
    assert.match(text, /docs\.example\.com \(5\), recipes\.example\.org \(3\), video\.example \(2\)/);
    assert.equal(await count(), 16);
  });

  await check('grouped: one row per site, biggest first, single links together at the end', async () => {
    await page.getByRole('button', { name: 'Group by website' }).click();
    await groups().first().waitFor();
    const heads = await groups().locator('h2').allInnerTexts();
    assert.deepEqual(heads, ['docs.example.com', 'recipes.example.org', 'video.example', 'Sites with one link']);
    const sizes = await groups().locator('.site-group__head > span:not(.flex-1)').allInnerTexts();
    assert.deepEqual(sizes, ['5 links', '3 links', '2 links', '6 links']);
    assert.equal(await page.getByRole('button', { name: 'By website', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('note').filter({ hasText: /aren't on a shelf yet/ }).count(), 0, 'no offer once grouped');
  });

  await check('a whole site moves onto a shelf at once, out of "other"', async () => {
    await page.getByRole('combobox', { name: 'Move all 5 links from docs.example.com to a shelf' }).selectOption('technology');
    await page.getByRole('status').filter({ hasText: 'Moved 5 links from docs.example.com to technology.' }).waitFor();
    assert.equal(await count(), 11);
    assert.deepEqual(await groups().locator('h2').allInnerTexts(), ['recipes.example.org', 'video.example', 'Sites with one link']);
    await saved();
    const now = await library();
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(now[`sg-${i}`].categories, ['technology']);
      assert.equal(now[`sg-${i}`].categoryMode, 'manual');
    }
  });

  await check('Undo puts them back in "other" as they were', async () => {
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.waitForFunction(() => document.querySelector('h1 + .chip')?.textContent?.trim() === '16');
    assert.equal(await page.getByRole('status').filter({ hasText: /Moved 5 links/ }).count(), 0);
    await page.waitForTimeout(300);
    await saved();
    const now = await library();
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(now[`sg-${i}`].categories, ['other']);
      assert.equal(now[`sg-${i}`].categoryMode, 'automatic');
      assert.equal(now[`sg-${i}`].categoryReview, true);
    }
  });

  await check('the grouping is remembered; a search shows plain results; it can be turned off', async () => {
    await open();
    await groups().first().waitFor();
    await page.locator('input[placeholder^="Search…"]').fill('recipes');
    await page.waitForTimeout(500);
    assert.equal(await groups().count(), 0, 'a search lists matches, not groups');
    assert.equal(await page.locator('article[data-post-id]').count(), 3);
    await page.locator('input[placeholder^="Search…"]').fill('');
    await groups().first().waitFor();
    await page.getByRole('button', { name: 'By website', exact: true }).click();
    await page.locator('article[data-post-id]').first().waitFor();
    assert.equal(await groups().count(), 0);
  });

  await check('"Not now" hides the offer for good; the By website button stays', async () => {
    await page.getByRole('button', { name: 'Not now' }).click();
    await open();
    await page.locator('article[data-post-id]').first().waitFor();
    assert.equal(await page.getByRole('note').filter({ hasText: /aren't on a shelf yet/ }).count(), 0);
    await page.getByRole('button', { name: 'By website', exact: true }).waitFor();
  });

  await check('every shelf has the By website button; a small shelf gets no offer', async () => {
    await page.goto(base + '/library/category/travel');
    await page.locator('article[data-post-id]').first().waitFor();
    await page.getByRole('button', { name: 'By website', exact: true }).waitFor();
    assert.equal(await page.getByRole('note').count(), 0);
  });

  // A fresh browser: the offer hasn't been put away there.
  const shelf = await (await browser.newContext({ viewport: { width: 1440, height: 1200 } })).newPage();
  shelf.on('pageerror', e => errors.push(e.message));
  const shelfCount = async () => Number((await shelf.locator('h1 + .chip').innerText()).trim());
  const shelfGroups = () => shelf.locator('.site-groups section.site-group');

  await check('a big shelf (40+ links) offers to group them by website, naming its biggest sites', async () => {
    await shelf.goto(base + '/library/category/technology');
    const offer = shelf.getByRole('note').filter({ hasText: /links on technology/ });
    await offer.waitFor();
    const text = (await offer.innerText()).replace(/\s+/g, ' ');
    assert.match(text, /42 links on technology, from 12 websites/);
    assert.match(text, /move a whole site to another shelf — code\.example\.com \(20\), talks\.example\.net \(12\)/);
  });

  await check('on a shelf, a whole site moves to another shelf and off this one (its other shelves stay), with Undo', async () => {
    await shelf.getByRole('button', { name: 'Group by website' }).click();
    await shelfGroups().first().waitFor();
    assert.deepEqual(await shelfGroups().locator('h2').allInnerTexts(), ['code.example.com', 'talks.example.net', 'Sites with one link']);
    const picker = shelf.getByRole('combobox', { name: 'Move all 20 links from code.example.com to another shelf' });
    const options = await picker.locator('option').allInnerTexts();
    assert.ok(!options.includes('technology') && options.includes('arts-culture'), options.join(', '));
    await picker.selectOption('arts-culture');
    await shelf.getByRole('status').filter({ hasText: 'Moved 20 links from code.example.com off technology to arts-culture.' }).waitFor();
    assert.equal(await shelfCount(), 22);
    await shelf.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /Library saved to SQLite/ }).waitFor();
    let now = await library();
    assert.deepEqual(now[codeIds[0]].categories, ['travel', 'arts-culture']);
    assert.ok(codeIds.slice(1).every(id => now[id].categories.length === 1 && now[id].categories[0] === 'arts-culture'));
    await shelf.getByRole('button', { name: 'Undo' }).click();
    await shelf.waitForFunction(() => document.querySelector('h1 + .chip')?.textContent?.trim() === '42');
    await shelf.waitForTimeout(300);
    await shelf.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /Library saved to SQLite/ }).waitFor();
    now = await library();
    assert.deepEqual(now[codeIds[0]].categories, ['technology', 'travel']);
    assert.ok(codeIds.slice(1).every(id => now[id].categories.length === 1 && now[id].categories[0] === 'technology'));
    await shelf.context().close();
  });

  await check('phone width: the offer and the rows fit without sideways scrolling', async () => {
    const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await phone.goto(base + '/library/category/other');
    await phone.getByRole('note').filter({ hasText: /aren't on a shelf yet/ }).waitFor();
    let [scroll, client] = await phone.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert.ok(scroll <= client, `offer: ${scroll} > ${client}`);
    await phone.getByRole('button', { name: 'Group by website' }).click();
    await phone.locator('.site-groups section.site-group').first().waitFor();
    [scroll, client] = await phone.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert.ok(scroll <= client, `rows: ${scroll} > ${client}`);
    await phone.screenshot({ path: join(evidence, 'phone-grouped.png') });
    await phone.context().close();
  });

  await check('no uncaught page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) { console.error(`FAILED ${failures.length}: ${failures.join('; ')} | evidence: ${evidence}`); process.exit(1); }
console.log(`ALL PASS | evidence: ${evidence}`);
