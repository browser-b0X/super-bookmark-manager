import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Synthetic Telegram login/session UI verification. No real backend, no Telegram,
// no saved browser profile, no credential output. Set TELEGRAM_UI_PLAYWRIGHT_MODULE
// to reuse another installed Playwright runtime.
const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = join(root, '.verify/telegram-login-session-20260927');
const run = process.argv.includes('--red') ? 'red' : 'green';
const report = { phase: run, checks: [], status: 'FAIL', cleanup: {} };
const canaries = [String(randomInt(10000000, 99999999)), randomBytes(12).toString('hex'), randomBytes(10).toString('hex')];
const [apiId, apiHash] = canaries;
const phone = '+1555' + String(randomInt(1000000, 9999999));
const phone2fa = phone.slice(0, -1) + '2';
const phoneNet = phone.slice(0, -1) + '9';
const goodCode = '111111';
const expiredCode = '000000';
const goodPassword = 'fake-2fa-password';
const secretCanaries = [...canaries, phone, phone2fa, phoneNet, goodCode, expiredCode, goodPassword];
const require = createRequire(import.meta.url);
let vite, browser, context, cache, stage = 'load installed browser dependency';
const observations = { external: 0, unexpectedApi: 0, pageErrors: 0, leakedConsole: false, protocolErrors: 0 };

// Minimal JS mirror of the backend auth state machine (status only, never secrets).
let creds = false;            // developer credentials configured
let session = { exists: false, authorized: false };
let login = null;             // { step, phone, created }
let fault = '';               // '', 'logout-network'
const statusBody = (extra = {}) => ({
  ok: true, credentials_configured: creds, session_exists: session.exists,
  authorized: session.exists ? session.authorized : false,
  login_step: login ? login.step : null, expires_in: login ? 300 : null, ...extra,
});
const err = (code, status) => ({ __status: status, ok: false, code, error: 'HOSTILE ' + goodPassword + ' ' + apiHash });

const check = (condition, name) => { assert.ok(condition, name); };
const pass = name => { report.checks.push(name); console.log('PASS: ' + name); };

try {
  await mkdir(evidence, { recursive: true });
  const { chromium } = require(process.env.TELEGRAM_UI_PLAYWRIGHT_MODULE || 'playwright');
  stage = 'start isolated Vite server';
  cache = await mkdtemp(join(tmpdir(), 'telegram-account-ui-'));
  vite = await createServer({ root: join(root, 'frontend'), configFile: false, envFile: false, cacheDir: cache,
    plugins: [react(), tailwindcss()], logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, open: false, hmr: false } });
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
    const send = (payload) => {
      const status = payload?.__status || 200;
      const body = { ...payload }; delete body.__status;
      return route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });
    };
    try {
      if (url.origin !== base) { observations.external++; return await route.abort(); }
      if (url.pathname === '/api/telegram/config') {
        return await send(request.method() === 'GET'
          ? { ok: true, api_id_configured: creds, api_hash_configured: creds, config_readable: true }
          : { ok: true, api_id_configured: creds, api_hash_configured: creds, config_readable: true });
      }
      if (url.pathname === '/api/telegram/auth') {
        if (request.method() === 'GET') return await send(statusBody());
        if (request.method() !== 'POST' || !request.headers()['content-type']?.includes('application/json')) observations.protocolErrors++;
        const body = request.postDataJSON();
        const keys = Object.keys(body).sort().join(',');
        // start
        if (body.action === 'start' && (keys === 'action,phone' || keys === 'action,phone,restart')) {
          if (!creds) return await send(err('configuration', 409));
          const digits = String(body.phone).replace(/[\s\-.()]/g, '');
          if (!/^\+?[0-9]{7,15}$/.test(digits)) return await send(err('invalid_phone', 400));
          if (String(body.phone).endsWith('9')) return await send(err('network', 503));
          const created = !session.exists;
          session = { exists: true, authorized: false };
          login = { step: 'awaiting_code', phone: String(body.phone), created };
          return await send(statusBody());
        }
        // code
        if (body.action === 'code' && keys === 'action,code') {
          if (!login || login.step !== 'awaiting_code') return await send(err('login_step', 409));
          if (!/^[0-9]{4,8}$/.test(String(body.code))) return await send(err('code_invalid', 400));
          if (body.code === expiredCode) { if (login.created) session = { exists: false, authorized: false }; login = null; return await send(err('code_expired', 400)); }
          if (login.phone.endsWith('2')) { login.step = 'awaiting_password'; return await send(statusBody({ result: 'password_required' })); }
          if (body.code !== goodCode) return await send(err('code_invalid', 400));
          session.authorized = true; login = null; return await send(statusBody({ result: 'connected' }));
        }
        // password
        if (body.action === 'password' && keys === 'action,password') {
          if (!login || login.step !== 'awaiting_password') return await send(err('login_step', 409));
          if (body.password !== goodPassword) return await send(err('password_invalid', 400));
          session.authorized = true; login = null; return await send(statusBody({ result: 'connected' }));
        }
        // check
        if (body.action === 'check' && keys === 'action') {
          if (!session.exists) return await send(statusBody({ result: 'not_connected', code: '' }));
          return await send(statusBody({ result: session.authorized ? 'connected' : 'not_authorized', code: session.authorized ? '' : 'unauthorized' }));
        }
        // cancel
        if (body.action === 'cancel' && keys === 'action') {
          const was = !!login; if (login?.created) session = { exists: false, authorized: false }; login = null;
          return await send(statusBody({ result: was ? 'cancelled' : 'idle' }));
        }
        // disconnect
        if (body.action === 'disconnect' && keys === 'action,mode') {
          if (!session.exists) return await send(statusBody({ result: 'already_disconnected' }));
          if (body.mode === 'logout' && fault === 'logout-network') return await send(err('network', 503));
          session = { exists: false, authorized: false }; login = null;
          return await send(statusBody({ result: body.mode === 'logout' ? 'logged_out' : 'removed_local' }));
        }
        observations.protocolErrors++;
        return await send(err('invalid', 400));
      }
      if (url.pathname === '/api/library' && request.method() === 'GET') return await send({ posts: [], deletedUrls: [], legacyRows: [] });
      if (url.pathname === '/api/stats' && request.method() === 'GET') return await send({ total: 0, categories: {} });
      if (url.pathname.startsWith('/api/')) { observations.unexpectedApi++; return await route.abort(); }
      return await route.continue();
    } catch { await route.abort().catch(() => {}); }
  });

  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', () => observations.pageErrors++);
  page.on('console', entry => { if (secretCanaries.some(v => entry.text().includes(v))) observations.leakedConsole = true; });
  await page.goto(base + '/library/settings');

  stage = 'account panel present with not-connected status';
  await page.getByRole('heading', { name: 'Telegram Account', exact: true }).waitFor();
  const panel = page.getByRole('region', { name: 'Telegram Account', exact: true });
  const button = name => panel.getByRole('button', { name, exact: true });
  const resultText = panel.getByRole('status', { name: 'Telegram account result' });
  const alert = panel.getByRole('alert');
  const visible = async text => { await panel.getByText(text, { exact: true }).waitFor(); };
  const storage = () => page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort()));
  const noSecret = async (label) => {
    const local = await storage();
    const text = await panel.innerText();
    check(!secretCanaries.some(v => local.includes(v) || text.includes(v)), label + ': no secret in storage or panel text');
    check(!observations.leakedConsole, label + ': no secret in console');
  };

  check(/Status:/.test(await panel.innerText()), 'status line present');
  check(/Not connected/.test(await panel.innerText()), 'initial status is Not connected');
  check(/Telegram session protected by Windows user-local filesystem permissions; not an encrypted credential vault\./.test(await panel.innerText()), 'session security wording present');
  check(await panel.evaluate(el => el.previousElementSibling?.getAttribute('aria-labelledby') === 'telegram-config-heading'), 'account panel follows Telegram Integration');
  await noSecret('initial');
  pass(stage);

  stage = 'connect blocked without credentials';
  check(await button('Connect Telegram').isDisabled(), 'connect disabled when credentials unconfigured');
  check(/Add your Telegram API ID and API hash/i.test(await panel.innerText()), 'guidance points to credentials first');
  check(/Developer credentials configured:\s*No/i.test(await panel.innerText()), 'credentials-not-configured reflected');
  pass(stage);

  stage = 'credentials configured enable connect and start phone step';
  creds = true;
  await page.reload();
  await page.getByRole('heading', { name: 'Telegram Account', exact: true }).waitFor();
  await button('Connect Telegram').click();
  await panel.getByLabel('Telegram phone number', { exact: true }).waitFor();
  check(await panel.getByRole('button', { name: 'Continue', exact: true }).isEnabled(), 'phone step shows Continue');
  // invalid phone blocked client-side, no POST issued
  const beforeStart = observations.protocolErrors;
  await panel.getByLabel('Telegram phone number', { exact: true }).fill('123');
  await button('Continue').click();
  await alert.filter({ hasText: /international form/i }).waitFor();
  check(observations.protocolErrors === beforeStart, 'invalid phone never submitted');
  await noSecret('phone');
  pass(stage);

  stage = 'valid phone starts login and requests code';
  await panel.getByLabel('Telegram phone number', { exact: true }).fill(phone);
  await button('Continue').click();
  await panel.getByLabel('Verification code', { exact: true }).waitFor();
  check(await panel.getByLabel('Verification code', { exact: true }).getAttribute('type') === 'password', 'code field masked');
  check(/sent a verification code/i.test(await panel.innerText()), 'code guidance shown');
  await noSecret('code-prompt');
  pass(stage);

  stage = 'wrong code surfaces client message and keeps step';
  await panel.getByLabel('Verification code', { exact: true }).fill('999999');
  await button('Sign in').click();
  await alert.filter({ hasText: /incorrect/i }).waitFor();
  check(!(await panel.innerText()).includes(goodPassword), 'hostile server text never reflected');
  check(await panel.getByLabel('Verification code', { exact: true }).isVisible(), 'still on code step after wrong code');
  pass(stage);

  stage = 'valid code connects';
  await panel.getByLabel('Verification code', { exact: true }).fill(goodCode);
  await button('Sign in').click();
  await resultText.filter({ hasText: /Connected/i }).waitFor();
  check(/Connected/.test(await panel.innerText()), 'status shows Connected');
  check(await button('Test connection').isVisible() && await button('Disconnect Telegram').isVisible(), 'connected actions present');
  await noSecret('connected');
  pass(stage);

  stage = 'test connection confirms authorization';
  await button('Test connection').click();
  await resultText.filter({ hasText: /confirmed/i }).waitFor();
  pass(stage);

  stage = 'disconnect logout with honest confirm';
  let dialogMsg = '';
  page.once('dialog', async d => { dialogMsg = d.message(); await d.accept(); });
  await button('Disconnect Telegram').click();
  await resultText.filter({ hasText: /logged out/i }).waitFor();
  check(/end the authorization/i.test(dialogMsg) && /removes the local session file/i.test(dialogMsg), 'logout dialog is explicit');
  check(/Not connected/.test(await panel.innerText()), 'status returns to Not connected');
  check(session.exists === false, 'fake session removed on logout');
  pass(stage);

  stage = 'two-factor path: code then password';
  await button('Connect Telegram').click();
  await panel.getByLabel('Telegram phone number', { exact: true }).waitFor();
  await panel.getByLabel('Telegram phone number', { exact: true }).fill(phone2fa);
  await button('Continue').click();
  await panel.getByLabel('Verification code', { exact: true }).waitFor();
  await panel.getByLabel('Verification code', { exact: true }).fill(goodCode);
  await button('Sign in').click();
  await panel.getByLabel('Two-step verification password', { exact: true }).waitFor();
  check(await panel.getByLabel('Two-step verification password', { exact: true }).getAttribute('type') === 'password', '2FA field masked');
  await panel.getByLabel('Two-step verification password', { exact: true }).fill('wrong-' + apiHash);
  await button('Sign in').click();
  await alert.filter({ hasText: /password is incorrect/i }).waitFor();
  await panel.getByLabel('Two-step verification password', { exact: true }).fill(goodPassword);
  await button('Sign in').click();
  await resultText.filter({ hasText: /Connected/i }).waitFor();
  await noSecret('2fa');
  pass(stage);

  stage = 'remove-local-only disconnect is honest about Telegram';
  page.once('dialog', async d => { dialogMsg = d.message(); await d.accept(); });
  await button('Remove local session only').click();
  await resultText.filter({ hasText: /Local session file removed/i }).waitFor();
  check(/does NOT log out on Telegram/i.test(dialogMsg), 'remove-local dialog states no remote logout');
  check(/Telegram was not contacted/i.test(await panel.innerText()), 'remove-local result is honest');
  pass(stage);

  stage = 'cancel clears transient input and returns to idle';
  await button('Connect Telegram').click();
  await panel.getByLabel('Telegram phone number', { exact: true }).waitFor();
  await panel.getByLabel('Telegram phone number', { exact: true }).fill(phone);
  await button('Continue').click();
  await panel.getByLabel('Verification code', { exact: true }).waitFor();
  await panel.getByLabel('Verification code', { exact: true }).fill(goodCode);
  await button('Cancel').click();
  await button('Connect Telegram').waitFor();
  check(/Not connected/.test(await panel.innerText()), 'cancel returns to idle not-connected');
  check(login === null && session.exists === false, 'cancel cleared login and created session');
  await noSecret('cancel');
  pass(stage);

  stage = 'network failure on start keeps user safe';
  await button('Connect Telegram').click();
  await panel.getByLabel('Telegram phone number', { exact: true }).waitFor();
  await panel.getByLabel('Telegram phone number', { exact: true }).fill(phoneNet);
  await button('Continue').click();
  await alert.filter({ hasText: /Could not reach Telegram/i }).waitFor();
  check(session.exists === false, 'failed start left no session');
  await button('Cancel').click();
  await button('Connect Telegram').waitFor();
  pass(stage);

  stage = 'logout network failure keeps file and explains';
  // reconnect then force a logout network fault
  await button('Connect Telegram').click();
  await panel.getByLabel('Telegram phone number', { exact: true }).fill(phone);
  await button('Continue').click();
  await panel.getByLabel('Verification code', { exact: true }).waitFor();
  await panel.getByLabel('Verification code', { exact: true }).fill(goodCode);
  await button('Sign in').click();
  await resultText.filter({ hasText: /Connected/i }).waitFor();
  fault = 'logout-network';
  page.once('dialog', async d => { await d.accept(); });
  await button('Disconnect Telegram').click();
  await panel.getByText(/Remote log-out could not be confirmed/i).waitFor();
  check(session.exists === true, 'network-failed logout kept the local file');
  fault = '';
  pass(stage);

  stage = 'containment at 320px and desktop with cleared fields';
  const before = await storage();
  for (const width of [320, 1365]) {
    await page.setViewportSize({ width, height: 900 });
    await panel.scrollIntoViewIfNeeded();
    const contained = await panel.evaluate(el => {
      const outer = el.getBoundingClientRect();
      return el.scrollWidth <= el.clientWidth + 1 && [...el.querySelectorAll('input, button, p, h2, ol, li')].every(child => {
        const box = child.getBoundingClientRect(); return box.left >= outer.left - 1 && box.right <= outer.right + 1;
      });
    });
    check(contained, 'account panel fits its container at ' + width + 'px');
    await panel.screenshot({ path: join(evidence, `telegram-account-${run}-${width}.png`), animations: 'disabled' });
  }
  check(await storage() === before, 'browser storage unchanged across the flow');
  await noSecret('final');
  check(observations.external === 0 && observations.unexpectedApi === 0 && observations.protocolErrors === 0 && observations.pageErrors === 0,
    'no external, unexpected API, protocol or page errors');
  pass(stage);
  report.status = 'PASS';
} catch (error) {
  // Never print Playwright errors verbatim: fill/assert diagnostics can contain
  // secrets. Redact every synthetic canary before emitting the failure reason.
  report.failure = stage;
  if (process.env.TELEGRAM_UI_DEBUG) {
    let reason = String(error?.message || error);
    for (const value of secretCanaries) reason = reason.split(value).join('[redacted]');
    console.log('DEBUG stage=' + stage + ' :: ' + reason.split('\n').slice(0, 6).join(' | '));
  }
  console.log('FAIL: ' + stage + ' (diagnostic values intentionally suppressed)');
  process.exitCode = 1;
} finally {
  if (context) { await context.close(); report.cleanup.contextClosed = true; }
  if (browser) { await browser.close(); report.cleanup.browserClosed = true; }
  if (vite) { await vite.close(); report.cleanup.viteClosed = true; }
  if (cache) { await rm(cache, { recursive: true, force: true }); report.cleanup.temporaryCacheRemoved = true; }
  report.observations = observations;
  await writeFile(join(evidence, `telegram-account-ui-${run}.json`), JSON.stringify(report, null, 2) + '\n');
}
