// Quitting the installed app: a power button in the sidebar footer (and the
// Settings control) open one confirmation; pending SQLite changes block the quit
// until saved; a confirmed quit ends on a "stopped" screen. The packaged runtime
// is simulated: its instance meta tag and /api/runtime endpoints are mocked.
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
const evidence = await mkdtemp(join(root, '.verify', 'quit-'));
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
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const quits = []; let serverUp = true; let failWrites = false;
  // Pretend to be the installed app: its pages carry an instance token.
  await page.route(url => url.origin === base && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/assets/'), async route => {
    const response = await route.fetch();
    const html = (await response.text()).replace('<head>', '<head><meta name="sbm-instance" content="synthetic-instance">');
    await route.fulfill({ response, body: html, headers: { ...response.headers(), 'content-type': 'text/html' } });
  });
  await page.route('**/api/runtime/quit', route => { quits.push(route.request().postDataJSON()); serverUp = false; return route.fulfill({ json: { ok: true } }); });
  await page.route('**/api/runtime', route => serverUp ? route.fulfill({ json: { app: 'SuperBookmarkManager' } }) : route.abort());
  await page.route('**/api/library', route => failWrites && route.request().method() === 'POST'
    ? route.fulfill({ status: 503, json: { error: 'synthetic write failure' } }) : route.fallback());

  await page.goto(base + '/');
  await page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /Library saved to SQLite/ }).waitFor();
  const power = page.locator('aside').getByRole('button', { name: 'Quit app' });
  const dialog = page.getByRole('dialog', { name: 'Quit Super Bookmark Manager?' });

  await check('a power button sits in the sidebar footer, in both sidebar widths', async () => {
    await power.waitFor();
    const footer = await page.locator('.sidebar-footer').boundingBox();
    const box = await power.boundingBox();
    assert.ok(box.y >= footer.y && box.y + box.height <= footer.y + footer.height + 1, 'inside the footer');
    assert.equal(await power.getAttribute('title'), 'Quit Super Bookmark Manager');
    await page.locator('.sidebar-footer').getByTitle('Collapse').click();
    await power.waitFor();
    const narrow = await page.locator('aside').boundingBox(), b = await power.boundingBox();
    assert.ok(b.x >= narrow.x && b.x + b.width <= narrow.x + narrow.width, 'fits the collapsed rail');
    await page.locator('.sidebar-footer').getByTitle('Expand').click();
  });

  await check('it asks first; Cancel and Escape quit nothing', async () => {
    await power.click();
    await dialog.waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Quit now');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await power.click(); await dialog.waitFor(); await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(quits, []);
  });

  await check('unsaved changes block the quit until they reach SQLite', async () => {
    failWrites = true;
    await page.getByRole('button', { name: 'Add link', exact: true }).first().click();
    await page.getByRole('dialog', { name: 'Add link' }).getByRole('textbox').fill('https://example.invalid/owned');
    await page.getByRole('button', { name: 'Save link', exact: true }).click();
    await page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /pending SQLite save/ }).waitFor();
    await page.keyboard.press('Escape'); // the new link opens in the drawer
    await page.locator('.fixed.inset-0.z-\\[90\\]').waitFor({ state: 'detached' }).catch(() => {});
    await power.click();
    await dialog.getByText(/haven't reached SQLite yet|hasn't reached SQLite yet/).waitFor();
    await dialog.getByRole('button', { name: /Save and quit/ }).click();
    await dialog.getByText('Changes are still pending. Retry SQLite save before quitting.', { exact: true }).waitFor();
    assert.deepEqual(quits, []);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  await check('the Settings control opens the same confirmation, and quitting ends on a stopped screen', async () => {
    failWrites = false;
    await page.goto(base + '/library/settings');
    await page.getByRole('button', { name: 'Quit Super Bookmark Manager', exact: true }).click();
    await dialog.waitFor();
    await dialog.getByRole('button', { name: /Save and quit|Quit now/ }).click();
    await page.getByRole('alertdialog').getByText('Super Bookmark Manager has stopped').waitFor({ timeout: 15000 });
    assert.deepEqual(quits, [{ confirm: true }]);
    const saved = await (await fetch(base + '/api/library')).json();
    assert.ok(saved.posts.some(p => p.url === 'https://example.invalid/owned'), 'pending link was saved before quitting');
    await page.screenshot({ path: join(evidence, 'stopped.png') });
  });

  await check('a plain source run shows no Quit button', async () => {
    const plain = await context.browser().newPage();
    await plain.goto(base + '/');
    await plain.locator('.sidebar-footer').waitFor();
    assert.equal(await plain.getByRole('button', { name: 'Quit app' }).count(), 0);
    await plain.close();
  });

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) { console.error(`FAILED: ${failures.join('; ')}`); process.exit(1); }
console.log(`PASS quit e2e; evidence ${evidence}`);
