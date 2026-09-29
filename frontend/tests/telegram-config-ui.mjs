import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// No real backend, providers, saved browser profile, traces or credential output.
// Set TELEGRAM_UI_PLAYWRIGHT_MODULE to reuse another installed Playwright runtime.
const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = join(root, '.verify/b6-installer-telegram-setup-20260925');
const run = process.argv.includes('--red') ? 'red' : 'green';
const report = { phase: run, checks: [], status: 'FAIL', cleanup: {} };
const canaries = [String(randomInt(10000000, 99999999)), randomBytes(16).toString('hex'), randomBytes(16).toString('hex')];
const [apiId, apiHash, changedHash] = canaries;
const require = createRequire(import.meta.url);
let vite, browser, context, cache, stage = 'load installed browser dependency';
let releaseRequest;
const observations = { external: 0, unexpectedApi: 0, pageErrors: 0, leakedConsole: false, protocolErrors: 0 };
let stored = { api_id: '', api_hash: '' }, env = false, mode = 'ok', posts = 0;
const configStatus = () => ({ api_id_configured: env || !!stored.api_id, api_hash_configured: env || !!stored.api_hash, config_readable: true });
const check = (condition, name) => { assert.ok(condition, name); };
const pass = name => { report.checks.push(name); console.log('PASS: ' + name); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
try {
  const { chromium } = require(process.env.TELEGRAM_UI_PLAYWRIGHT_MODULE || 'playwright');
  stage = 'start isolated Vite server';
  cache = await mkdtemp(join(tmpdir(), 'telegram-config-ui-'));
  vite = await createServer({ root: join(root, 'frontend'), configFile: false, envFile: false, cacheDir: cache,
    plugins: [react(), tailwindcss()], logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, open: false, hmr: false },
  });
  // Defense in depth: a missed browser intercept cannot reach the owner's API.
  vite.middlewares.use((req, res, next) => {
    if (req.url?.startsWith('/api/')) { res.statusCode = 503; res.end('{}'); } else next();
  });
  await vite.listen();
  const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  stage = 'launch installed Chromium in fresh context';
  browser = await chromium.launch({ headless: true, channel: process.env.TELEGRAM_UI_BROWSER_CHANNEL || 'msedge' });
  context = await browser.newContext({ viewport: { width: 1365, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });
    try {
      if (url.origin !== base) { observations.external++; return await route.abort(); }
      if (url.pathname === '/api/telegram/config') {
        if (request.method() === 'GET') {
          if (mode === 'offline') return await route.abort('connectionrefused');
          if (mode === 'unreadable') return await json({ ...configStatus(), config_readable: false });
          if (mode === 'malformed') return await json({ api_id_configured: 'yes', api_hash_configured: true, config_readable: true });
          return await json(configStatus());
        }
        posts++;
        if (request.method() !== 'POST' || !request.headers()['content-type']?.includes('application/json')) observations.protocolErrors++;
        const body = request.postDataJSON();
        if (mode === 'pending' || mode === 'timeout') {
          const held = deferred(); releaseRequest = held.resolve; await held.promise;
          if (mode === 'timeout') return await route.abort();
        }
        // Deliberately hostile error text proves the UI never reflects server values.
        if (mode === 'reject') return await json({ ok: false, error: apiHash }, 400);
        if (body.action === 'save' && typeof body.api_id === 'string' && typeof body.api_hash === 'string'
          && Object.keys(body).sort().join(',') === 'action,api_hash,api_id') {
          stored = { api_id: body.api_id || stored.api_id, api_hash: body.api_hash || stored.api_hash };
        } else if (body.action === 'clear' && body.confirm === true && Object.keys(body).sort().join(',') === 'action,confirm') {
          stored = { api_id: '', api_hash: '' };
        } else observations.protocolErrors++;
        return await json(configStatus());
      }
      // Telegram Account panel shares this page; keep it idle and not-connected so
      // it never issues writes or trips the unexpected-API guard during config tests.
      if (url.pathname === '/api/telegram/auth') {
        const idle = { ok: true, credentials_configured: false, session_exists: false, authorized: false, login_step: null, expires_in: null };
        return await json(request.method() === 'GET' ? idle : { ...idle, result: 'idle', code: '' });
      }
      if (url.pathname === '/api/library' && request.method() === 'GET') return await json({ posts: [], deletedUrls: [], legacyRows: [] });
      if (url.pathname === '/api/stats' && request.method() === 'GET') return await json({ total: 0, categories: {} });
      if (url.pathname.startsWith('/api/')) { observations.unexpectedApi++; return await route.abort(); }
      return await route.continue();
    } catch { await route.abort().catch(() => {}); }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', () => observations.pageErrors++);
  page.on('console', entry => { if (canaries.some(value => entry.text().includes(value))) observations.leakedConsole = true; });
  await page.goto(base + '/library/settings');
  stage = 'Telegram Integration heading is present';
  await page.getByRole('heading', { name: 'Telegram Integration', exact: true }).waitFor();
  const panel = page.getByRole('region', { name: 'Telegram Integration', exact: true });
  const button = name => panel.getByRole('button', { name, exact: true });
  const id = panel.getByLabel('Telegram API ID', { exact: true });
  const hash = panel.getByLabel('Telegram API hash', { exact: true });
  const result = panel.getByRole('status', { name: 'Telegram configuration result' });
  const visible = async text => { await panel.getByText(text, { exact: true }).waitFor(); };
  const status = async (idValue, hashValue) => {
    await visible('API ID configured: ' + idValue);
    await visible('API hash configured: ' + hashValue);
  };
  const storage = () => page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort()));
  const emptyFields = async () => check(await id.inputValue() === '' && await hash.inputValue() === '', 'fields are blank');
  const noCanary = async () => {
    const content = await page.content();
    const local = await storage();
    // Filled password properties are allowed only in transient component/DOM state.
    const visibleText = await page.locator('body').innerText();
    check(!canaries.some(value => local.includes(value) || visibleText.includes(value)), 'no visible or persisted credentials');
    if (!await id.count()) check(!canaries.some(value => content.includes(value)), 'cleared DOM contains no credentials');
    check(!observations.leakedConsole, 'console contains no credentials');
  };
  await status('No', 'No');
  await visible('Saved config readable: Yes');
  await visible('Use your Telegram developer API credentials. These are separate from your Telegram login/session.');
  await visible('Configure Telegram Saved Messages refresh now?');
  await page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /^Library saved to SQLite$/ }).waitFor();
  const before = await storage();
  check(await panel.evaluate(el => el.previousElementSibling?.getAttribute('aria-labelledby') === 'backup-heading'), 'panel follows BackupRestore');
  check(/environment variables override saved/i.test(await panel.innerText()), 'environment precedence explained');
  check(/saving is not login and does not start refresh/i.test(await panel.innerText()), 'login and refresh boundary explained');
  pass('initial status, guidance and ordinary Settings insertion');

  stage = 'skip and cancel never write or retain transient input';
  await button('Skip').click();
  check(posts === 0, 'skip makes no POST');
  await button('Configure').click();
  await emptyFields();
  for (const field of [id, hash]) {
    check(await field.getAttribute('type') === 'password', 'field is masked');
    check(['off', 'new-password'].includes(await field.getAttribute('autocomplete')), 'autofill disabled');
  }
  check(await id.getAttribute('inputmode') === 'numeric', 'numeric keyboard hint');
  await id.fill(apiId); await hash.fill(apiHash); await noCanary();
  await button('Cancel').click();
  await button('Configure').click(); await emptyFields();
  await id.fill(apiId); await hash.fill(apiHash); await button('Skip').click();
  await button('Configure').click(); await emptyFields();
  check(posts === 0, 'cancel and skip make no POST');
  pass(stage);

  stage = 'invalid ID and missing credentials fail without submitting';
  await button('Save').click();
  await panel.getByRole('alert').filter({ hasText: /API ID/i }).waitFor();
  for (const invalid of ['0', '-1', 'abc', '1.5']) {
    await id.fill(invalid); await hash.fill(apiHash); await button('Save').click();
    await panel.getByRole('alert').filter({ hasText: /positive/i }).waitFor();
  }
  await id.fill(apiId); await hash.fill(''); await button('Save').click();
  await panel.getByRole('alert').filter({ hasText: /API hash/i }).waitFor();
  check(posts === 0, 'invalid input not submitted');
  pass(stage);

  stage = 'explicit save, disabled pending actions and blank preserving update';
  await hash.fill(apiHash); mode = 'pending';
  await button('Save').click();
  await page.waitForFunction(() => document.querySelector('#telegram-config-heading')?.closest('section')?.getAttribute('aria-busy') === 'true');
  check(await panel.locator('button:not(:disabled), input:not(:disabled)').count() === 0, 'all panel actions disabled while pending');
  // Wait for the intercepted request, without timing-sensitive sleeps.
  if (!releaseRequest) await page.waitForRequest(r => r.url().endsWith('/api/telegram/config') && r.method() === 'POST');
  check(!!releaseRequest, 'save request reached isolated fixture');
  releaseRequest(); releaseRequest = undefined; mode = 'ok';
  await result.filter({ hasText: /saved/i }).waitFor(); await status('Yes', 'Yes');
  check(stored.api_id === apiId && stored.api_hash === apiHash && posts === 1, 'exact explicit save payload');
  await button('Update credentials').click(); await emptyFields();
  await button('Save').click(); await result.filter({ hasText: /saved/i }).waitFor();
  check(stored.api_id === apiId && stored.api_hash === apiHash, 'blank values preserve stored credentials');
  await button('Update credentials').click(); await emptyFields(); await hash.fill(changedHash);
  await button('Save').click(); await result.filter({ hasText: /saved/i }).waitFor();
  check(stored.api_id === apiId && stored.api_hash === changedHash, 'one blank field preserves existing key');
  await noCanary(); pass(stage);

  stage = 'clear confirmation cancellation and confirmed clear';
  const beforeClear = posts;
  page.once('dialog', dialog => dialog.dismiss()); await button('Clear').click();
  check(posts === beforeClear && !!stored.api_id && !!stored.api_hash, 'dismissed clear preserves credentials');
  page.once('dialog', async dialog => {
    check(/saved developer credentials/i.test(dialog.message()) && /environment/i.test(dialog.message()), 'clear dialog is explicit');
    await dialog.accept();
  });
  await button('Clear').click(); await result.filter({ hasText: /cleared/i }).waitFor(); await status('No', 'No');
  check(stored.api_id === '' && stored.api_hash === '', 'confirmed clear removes fixture keys');
  pass(stage);

  stage = 'environment override status survives clear without exposing values';
  env = true; await page.reload(); await status('Yes', 'Yes');
  page.once('dialog', dialog => dialog.accept()); await button('Clear').click();
  await result.filter({ hasText: /cleared/i }).waitFor(); await status('Yes', 'Yes');
  check(/clearing does not clear environment variables/i.test(await panel.innerText()), 'clear limitation explained');
  await button('Update credentials').click(); await emptyFields(); await button('Cancel').click();
  pass(stage);

  stage = 'unreadable and unavailable status never claim saved';
  mode = 'unreadable'; await page.reload(); await visible('Saved config readable: No');
  await panel.getByRole('alert').filter({ hasText: /unreadable/i }).waitFor();
  check(await button('Retry').isEnabled(), 'unreadable retry available');
  mode = 'offline'; await button('Retry').click();
  await panel.getByRole('alert').filter({ hasText: /unavailable/i }).waitFor();
  await status('Unknown', 'Unknown');
  mode = 'malformed'; await button('Retry').click();
  await panel.getByRole('alert').filter({ hasText: /unavailable/i }).waitFor();
  await status('Unknown', 'Unknown');
  mode = 'ok'; await button('Retry').click(); await status('Yes', 'Yes');
  pass(stage);

  stage = 'server errors are generic and retry does not repeat save';
  await button('Update credentials').click(); await hash.fill(apiHash);
  mode = 'reject'; await button('Save').click();
  await panel.getByRole('alert').filter({ hasText: /save was not confirmed/i }).waitFor();
  await status('Unknown', 'Unknown'); await noCanary();
  const failedPosts = posts;
  stage = 'skip after unconfirmed save describes only discarded inputs';
  await button('Skip').click();
  await result.filter({ hasText: /inputs discarded/i }).waitFor();
  await status('Unknown', 'Unknown');
  check(posts === failedPosts, 'skip after failure makes no write or state claim');
  mode = 'ok'; await button('Retry').click(); await status('Yes', 'Yes');
  check(posts === failedPosts, 'retry is status-only');
  await button('Update credentials').click(); await emptyFields();
  pass('server errors are generic, skip is truthful and retry does not repeat save');

  stage = 'bounded API timeout releases controls without claiming saved';
  mode = 'timeout'; await hash.fill(apiHash); await button('Save').click();
  await panel.getByRole('alert').filter({ hasText: /save was not confirmed/i }).waitFor({ timeout: 15000 });
  check(await button('Retry').isEnabled() && await button('Cancel').isEnabled(), 'timeout releases controls');
  releaseRequest?.(); releaseRequest = undefined;
  await button('Cancel').click(); mode = 'ok'; await button('Retry').click(); await status('Yes', 'Yes');
  await noCanary(); pass(stage);

  stage = 'component containment at 320px and desktop with cleared masked fields';
  await button('Update credentials').click(); await emptyFields();
  for (const width of [320, 1365]) {
    await page.setViewportSize({ width, height: 900 }); await panel.scrollIntoViewIfNeeded();
    const contained = await panel.evaluate(el => {
      const outer = el.getBoundingClientRect();
      return el.scrollWidth <= el.clientWidth + 1 && [...el.querySelectorAll('input, button, p, h2')].every(child => {
        const box = child.getBoundingClientRect(); return box.left >= outer.left - 1 && box.right <= outer.right + 1;
      });
    });
    check(contained, 'panel controls and text fit their own container');
    await emptyFields();
    await panel.screenshot({ path: join(evidence, `telegram-ui-${run}-${width}-cleared.png`), animations: 'disabled', mask: [id, hash] });
  }
  await button('Cancel').click();
  check(await storage() === before, 'library and browser storage unchanged');
  await noCanary();
  check(observations.external === 0 && observations.unexpectedApi === 0 && observations.protocolErrors === 0 && observations.pageErrors === 0, 'no external, refresh, unexpected API or browser errors');
  pass(stage);
  report.status = 'PASS';
} catch {
  // Never print Playwright errors: fill/assert diagnostics can contain secrets.
  report.failure = stage;
  console.log('FAIL: ' + stage + ' (diagnostic values intentionally suppressed)');
  process.exitCode = 1;
} finally {
  releaseRequest?.();
  if (context) { await context.close(); report.cleanup.contextClosed = true; }
  if (browser) { await browser.close(); report.cleanup.browserClosed = true; }
  if (vite) { await vite.close(); report.cleanup.viteClosed = true; }
  if (cache) { await rm(cache, { recursive: true, force: true }); report.cleanup.temporaryCacheRemoved = true; }
  report.observations = observations;
  await writeFile(join(evidence, `telegram-ui-${run}.json`), JSON.stringify(report, null, 2) + '\n');
}
