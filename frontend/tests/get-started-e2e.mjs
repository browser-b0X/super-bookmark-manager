// Get started on Home (owner, 2026-11-02; mockups in Claude outputs/v040-review/phase9): three steps that tick
// themselves in place of "Your library is empty", then a strip above the deck until done or dismissed, and never for a
// library that already had links. Synthetic data only, on an owned loopback server; each browser is a fresh profile.
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
const evidence = await mkdtemp(join(root, '.verify', 'get-started-'));
const port = 15000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.env.C4_PYTHON || 'python3', ['-B', '-c', `
import os, sys
sys.path.insert(0, ${JSON.stringify(root)})
os.environ["SAVED_POSTS_DB_PATH"] = ${JSON.stringify(join(evidence, 'fixture.sqlite'))}
os.environ["SBM_AI_CONFIG_FILE"] = ${JSON.stringify(join(evidence, 'ai.json'))}
os.environ["SBM_ARCHIVE_DIR"] = ${JSON.stringify(join(evidence, 'archive'))}
os.environ["SUPER_BOOKMARK_MANAGER_DATA_DIR"] = ${JSON.stringify(join(evidence, 'data'))}
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
const errors = [];
async function fresh(width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 860 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  return { context, page };
}
const card = page => page.getByRole('region', { name: 'Get started' });
const saved = page => page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /Library saved to SQLite/ }).waitFor();
const home = async page => { await page.goto(base + '/'); await saved(page); };
const steps = async page => (await card(page).locator('.get-started__step').evaluateAll(rows => rows.map(r => ({
  done: r.classList.contains('is-done'), text: r.innerText.replace(/\s+/g, ' ').trim() }))));
const sideways = page => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
const paired = page => page.route('**/api/extension', route => route.fulfill({ contentType: 'application/json',
  body: JSON.stringify({ connections: [{ id: 'c1', browser: 'Edge', pairedAt: new Date().toISOString(), lastUsedAt: new Date().toISOString() }], code: null }) }));

try {
  let up = false;
  for (let i = 0; i < 150 && !up; i++) { try { up = (await fetch(base + '/api/stats')).ok; } catch {} if (!up) await new Promise(r => setTimeout(r, 100)); }
  assert.ok(up, 'server did not start: ' + serverLog.slice(-400));

  await check('a new library gets Get started in place of "Your library is empty"', async () => {
    const { context, page } = await fresh();
    await home(page);
    await card(page).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Your library is empty' }).count(), 0);
    assert.match(await card(page).innerText(), /0 of 3/);
    assert.deepEqual((await steps(page)).map(s => s.done), [false, false, false]);
    for (const name of ['Import links', 'Add link', 'Set it up']) await card(page).getByRole('button', { name, exact: true }).waitFor();
    assert.equal(await card(page).getByRole('link', { name: 'Connect it' }).getAttribute('href'), '/library/settings#telegram-config-heading');
    assert.match(await card(page).innerText(), /Use Telegram\? Connect it to bring in your Saved Messages\./);
    assert.ok(await card(page).evaluate(el => el.classList.contains('get-started--first')));
    await page.screenshot({ path: join(evidence, 'new-library.png') });
    await context.close();
  });

  await check('Dismiss closes it for good in that browser; the empty library says so as before', async () => {
    const { context, page } = await fresh();
    await home(page);
    await card(page).getByRole('button', { name: 'Dismiss Get started' }).click();
    await page.getByRole('heading', { name: 'Your library is empty' }).waitFor();
    assert.equal(await card(page).count(), 0);
    await home(page);
    await page.getByRole('heading', { name: 'Your library is empty' }).waitFor();
    assert.equal(await card(page).count(), 0, 'not back after a reload');
    await context.close();
  });

  const { context, page } = await fresh();
  await check('Set it up opens the extension panel in Settings', async () => {
    await home(page);
    await card(page).getByRole('button', { name: 'Set it up', exact: true }).click();
    await page.waitForURL(/\/library\/settings#save-from-browser-heading$/);
    const heading = page.getByRole('heading', { name: 'Save from your browser' });
    await heading.waitFor();
    await page.waitForFunction(() => { const r = document.getElementById('save-from-browser-heading')?.getBoundingClientRect(); return r && r.top >= 0 && r.top < innerHeight; });
  });

  await check('a link added from the card ticks the first step; the card stays, as a strip above the deck', async () => {
    await home(page);
    await card(page).getByRole('button', { name: 'Add link', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add link' });
    await dialog.getByPlaceholder('https://…').fill('https://example.org/first-link');
    await dialog.getByRole('button', { name: 'Save link' }).click();
    await page.waitForURL(/\/library\/item\//);
    await home(page);
    await card(page).waitFor();
    assert.ok(await card(page).evaluate(el => el.classList.contains('get-started--strip')));
    assert.match(await card(page).innerText(), /1 of 3/);
    const [first, , third] = await steps(page);
    assert.deepEqual([first.done, first.text], [true, 'Done: Bring your links in 1 link in your library.']);
    assert.match(third.text, /Press Keep, Later or Archive on the link below\./);
    await page.getByRole('region', { name: 'New to sort' }).waitFor();
    assert.ok(await page.evaluate(() => {
      const strip = document.querySelector('.get-started'), deck = document.querySelector('.deck');
      return !!strip && !!deck && strip.getBoundingClientRect().bottom <= deck.getBoundingClientRect().top;
    }), 'the strip sits above the deck');
  });

  await check('a paired browser ticks the second step', async () => {
    await paired(page);
    await home(page);
    await card(page).getByText('Edge is connected.').waitFor();
    assert.match(await card(page).innerText(), /2 of 3/);
    assert.equal(await card(page).getByRole('button', { name: 'Set it up' }).count(), 0);
  });

  await check('a narrow window keeps the card inside the page', async () => {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 800 }); await page.waitForTimeout(200);
      assert.equal(await sideways(page), false, `width ${width}`);
      const box = await card(page).boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width, `card inside at ${width}: ${JSON.stringify(box)}`);
    }
    await page.screenshot({ path: join(evidence, 'narrow-320.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 860 });
  });

  await check('Keep ticks the third step; done, the card stays until Home is left, then is gone for good', async () => {
    await page.getByRole('region', { name: 'New to sort' }).getByRole('button', { name: /^Keep:/ }).click();
    await card(page).getByText('You sorted your first link.').waitFor();
    assert.match(await card(page).innerText(), /3 of 3/);
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Later' }).click();
    await page.waitForURL(/status=to-review/);
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Home' }).click();
    await page.waitForURL(base + '/');
    await page.waitForTimeout(300);
    assert.equal(await card(page).count(), 0, 'gone after leaving Home');
    await home(page);
    assert.equal(await card(page).count(), 0, 'gone after a reload');
  });
  await context.close();

  await check('a library that already has links when a browser first opens it never gets the card', async () => {
    const { context, page } = await fresh();
    await home(page);
    await page.getByRole('region', { name: 'New to sort' }).or(page.locator('.shelf-row')).first().waitFor();
    assert.equal(await card(page).count(), 0);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('prefs-store-v1')).state.getStarted), 'closed');
    await context.close();
  });

  await check('no page errors', async () => { assert.deepEqual(errors, []); });
} catch (error) {
  failures.push('setup'); console.error('FAIL setup:', error.message);
} finally {
  await browser.close();
  server.kill();
}
console.log(failures.length ? `FAILED ${failures.length} | evidence: ${evidence}` : `ALL PASS | evidence: ${evidence}`);
process.exit(failures.length ? 1 : 0);
