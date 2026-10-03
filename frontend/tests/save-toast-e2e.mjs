// Save status toast: floats bottom-left of the content, invisible when idle, shows while a slow
// save runs, says "Saved" and fades, stays (with Retry) when SQLite fails, and
// never changes the sidebar's layout. Synthetic data only.
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
const evidence = await mkdtemp(join(root, '.verify', 'toast-'));
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
`], { cwd: root, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/api/stats')).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }

const browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
try {
  const page = await (await browser.newContext({ viewport: { width: 1365, height: 900 } })).newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let mode = 'normal';
  await page.route('**/api/library', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    if (mode === 'slow') { await new Promise(r => setTimeout(r, 1500)); return route.fallback(); }
    if (mode === 'fail') return route.fulfill({ status: 503, json: { error: 'synthetic write failure' } });
    return route.fallback();
  });
  await page.goto(base + '/');
  const toast = page.getByRole('status', { name: 'SQLite save status' });
  await toast.filter({ hasText: /Library saved to SQLite/ }).waitFor();
  const opacity = () => toast.evaluate(el => Number(getComputedStyle(el).opacity));
  const footerTop = () => page.evaluate(() => Math.round(document.querySelector('.sidebar-footer').getBoundingClientRect().top));

  await check('idle: nothing shown, and the sidebar holds no save status', async () => {
    await page.waitForTimeout(500);
    assert.equal(await opacity(), 0);
    assert.equal(await page.locator('aside [aria-label="SQLite save status"]').count(), 0);
    const box = await toast.boundingBox();
    const side = await page.locator('aside').boundingBox();
    assert.ok(box.x >= side.x + side.width && box.y > 900 / 2, 'floats bottom-left of the content, clear of the sidebar');
  });

  await check('a slow save shows the toast, the sidebar never moves, then it fades', async () => {
    const top = await footerTop(); const tops = new Set([top]);
    mode = 'slow';
    await page.getByRole('button', { name: 'Add link', exact: true }).first().click();
    await page.getByRole('dialog', { name: 'Add link' }).getByRole('textbox').fill('https://example.invalid/slow');
    await page.getByRole('button', { name: 'Save link', exact: true }).click();
    let sawVisible = false;
    for (let i = 0; i < 60; i++) {
      tops.add(await footerTop());
      if (await opacity() === 1) sawVisible = true;
      if (sawVisible && await opacity() === 0) break;
      await page.waitForTimeout(100);
    }
    assert.ok(sawVisible, 'toast appeared during the save');
    assert.equal(await opacity(), 0, 'toast faded after the save');
    assert.deepEqual([...tops], [top], 'sidebar footer moved');
    mode = 'normal';
  });

  await check('a failed save keeps the toast up with Retry', async () => {
    await page.keyboard.press('Escape');
    mode = 'fail';
    await page.getByRole('button', { name: 'Add link', exact: true }).first().click();
    await page.getByRole('dialog', { name: 'Add link' }).getByRole('textbox').fill('https://example.invalid/fails');
    await page.getByRole('button', { name: 'Save link', exact: true }).click();
    const retry = page.getByRole('button', { name: 'Retry SQLite save', exact: true });
    await retry.waitFor();
    await page.waitForTimeout(2500);
    assert.equal(await opacity(), 1, 'stays while there is a problem');
    await page.screenshot({ path: join(evidence, 'toast-error.png') });
    mode = 'normal';
    await page.keyboard.press('Escape');
    await retry.click();
    await toast.filter({ hasText: /^Library saved to SQLite$/ }).waitFor();
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('[aria-label="SQLite save status"]')).opacity) === 0, null, { timeout: 5000 });
  });

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) { console.error(`FAILED: ${failures.join('; ')}`); process.exit(1); }
console.log(`PASS save toast e2e; evidence ${evidence}`);
