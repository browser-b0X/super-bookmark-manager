import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, appendFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = await mkdtemp(join(root, '.verify/g4-c7-expand-20260918/phase3/e2e-'));
const python = process.env.C7_PYTHON;
assert.ok(python, 'Set C7_PYTHON to the existing bundled runtime');
const { chromium } = createRequire(import.meta.url)(process.env.C7_PLAYWRIGHT_MODULE || 'playwright');
const fixture = name => join(root, 'frontend/tests/fixtures', name);
const seed = JSON.parse(await readFile(fixture('retrieval-library.json'), 'utf8'));
for (const post of seed) {
  const path = new URL(post.url).pathname;
  if (['/art', '/travel'].includes(path)) post.thumbnailUrl = '/__fixture/preview.svg';
  if (path === '/exercise') post.thumbnailUrl = '/__fixture/tiny.svg';
  if (path === '/budgeting') post.thumbnailUrl = '/__fixture/broken.svg';
}
const previewImage = await readFile(fixture('landing-preview.svg'), 'utf8');
const tinyImage = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#6c8cff"/></svg>';
const ordered = posts => [...posts].filter(p => p.status === 'inbox').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
const queue = ordered(seed);
const sorted = posts => [...posts].sort((a, b) => a.url.localeCompare(b.url));
const results = [], screenshots = [], events = [], errors = [], denied = [], consoleMessages = [], requests = [];
let browser, page, server, db, base, port = 0, scenario, expectedExternal, apiOffline = false;
const main = () => page.locator('main');
const card = post => main().locator(`[data-post-id="${post.id}"]`);
const posts = () => page.evaluate(() => JSON.parse(localStorage.getItem('library-store-v1')).state.posts);
const status = () => page.getByRole('status', { name: 'SQLite save status' });
// Local rejection is distinct from an accepted edit whose SQLite write fails.
// Inject a switchable early return only into the served test copy of updatePost;
// the disk build and every other scenario remain byte-for-byte unchanged.
const rejectionNeedle = /updatePost\(([\w$]+),([\w$]+)\)\{/g;
const builtHtml = await readFile(join(root, 'frontend/dist/index.html'), 'utf8');
const bundlePath = builtHtml.match(/src="([^"]+\.js)"/)[1];
const diskBundle = await readFile(join(root, 'frontend/dist', bundlePath.replace(/^\//, '')), 'utf8');
assert.equal([...diskBundle.matchAll(rejectionNeedle)].length, 1, 'Exactly one store updatePost method is required for fault injection');
const rejectionBundle = diskBundle.replace(rejectionNeedle, (match, id) => match + `if(globalThis.__rejectTriage===${id}){globalThis.__rejectionCalls=(globalThis.__rejectionCalls||0)+1;return;}`);

async function start() {
  const child = spawn(python, ['-B', join(root, 'frontend/tests/library_fixture.py'), db, String(port)], {
    cwd: root, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', TELEGRAM_API_ID: '0', TELEGRAM_API_HASH: '', LLM_API_KEY: 'fixture', LITELLM_PROXY_KEY: 'fixture' },
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  server = { child, pending };
  const data = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error('Fixture exited before ready: ' + code)));
    createInterface({ input: child.stdout }).on('line', line => {
      void appendFile(join(evidence, 'server.jsonl'), line + '\n');
      const data = JSON.parse(line);
      if (data.ready) resolve(data);
      else if (data.command) { pending.get(data.command)?.(data); pending.delete(data.command); }
      else events.push(data);
    });
  });
  child.stderr.on('data', data => { void appendFile(join(evidence, 'server.txt'), data); });
  port = data.port; base = `http://127.0.0.1:${port}`; events.push(data);
  console.log('Fixture ready', JSON.stringify(data));
}
async function control(command) {
  const response = new Promise(resolve => server.pending.set(command, resolve));
  server.child.stdin.write(JSON.stringify({ command }) + '\n');
  return response;
}
async function stop() {
  if (!server) return;
  const child = server.child;
  if (child.exitCode === null) {
    const exited = once(child, 'exit');
    child.stdin.end(JSON.stringify({ command: 'stop' }) + '\n');
    const [code] = await exited;
    events.push({ pid: child.pid, exitCode: code });
    assert.equal(code, 0);
  } else assert.equal(child.exitCode, 0);
  server = undefined;
}
async function newPage() {
  const context = await browser.newContext({ reducedMotion: scenario === 'reduced-motion' ? 'reduce' : 'no-preference', viewport: { width: 1365, height: 900 }, serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (scenario === 'local-rejection' && url.origin === base && url.pathname === bundlePath) {
      return route.fulfill({ contentType: 'text/javascript', body: rejectionBundle });
    }
    if (url.origin === base && url.pathname.startsWith('/__fixture/')) {
      if (url.pathname.endsWith('broken.svg')) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Synthetic missing image' });
      return route.fulfill({ contentType: 'image/svg+xml', body: url.pathname.endsWith('tiny.svg') ? tinyImage : previewImage });
    }
    if (url.origin !== base) {
      if (url.href === expectedExternal?.split('#')[0] && route.request().isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: '<title>Intercepted synthetic source</title>' });
      denied.push(url.href); return route.abort();
    }
    if (url.pathname.startsWith('/api/')) {
      requests.push({ path: url.pathname, method: route.request().method() });
      if (apiOffline) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Fixture backend unavailable"}' });
    }
    return route.continue();
  });
  if (process.env.C7_TRACE_FOCUS) await context.addInitScript(() => {
    window.__focusTrace = [];
    const describe = el => ({ tag: el?.tagName, id: el?.closest('[data-post-id]')?.dataset.postId, action: el?.getAttribute('data-triage'), inert: !!el?.closest('[inert]'), visibility: el ? getComputedStyle(el).visibility : null, expanded: el?.closest('[data-post-id]')?.className, chain: el?.closest('[data-post-id]') ? [el, el.parentElement, el.closest('.catchup-content')].filter(Boolean).map(node => { const s = getComputedStyle(node); return { class: node.className, visibility: s.visibility, property: s.transitionProperty, duration: s.transitionDuration, delay: s.transitionDelay }; }) : [] });
    const record = (event, target) => window.__focusTrace.push({ at: performance.now(), event, target: describe(target), active: describe(document.activeElement) });
    const focus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (...args) {
      record('focus-call', this); focus.apply(this, args); record('focus-result', this);
      queueMicrotask(() => record('focus-microtask', this));
      requestAnimationFrame(() => record('focus-frame', this));
    };
    for (const type of ['focusin', 'focusout', 'keydown', 'pointerenter']) document.addEventListener(type, e => { if (e.target instanceof Element) record(type, e.target); }, true);
  });
  const next = await context.newPage(); next.setDefaultTimeout(5000); next.setDefaultNavigationTimeout(15000);
  next.on('pageerror', error => errors.push(error.message));
  next.on('console', message => { if (message.type() === 'error') consoleMessages.push(message.text()); });
  return next;
}
async function snapshot() {
  const result = (await control('snapshot')).result;
  assert.deepEqual(result.blocked, []); assert.equal(result.legacyCount, 0); assert.deepEqual(result.deletedUrls, []);
  return result;
}
async function saved(count = 8) {
  await page.waitForFunction(count => {
    const state = JSON.parse(localStorage.getItem('library-store-v1') || '{}').state;
    return state?.posts.length === count && Object.keys(state.pending).length === 0;
  }, count, { timeout: 5000 });
  await status().filter({ hasText: /^Library saved to SQLite$/ }).waitFor();
  const result = await snapshot();
  assert.equal(result.posts.length, count); assert.deepEqual(sorted(result.posts), sorted(await posts()));
  return result;
}
async function check(name, run) {
  try {
    const detail = await run(); results.push({ scenario, name, status: 'PASS', detail }); console.log('PASS', scenario, name);
  } catch (error) {
    results.push({ scenario, name, status: 'FAIL', error: error.stack }); console.error('FAIL', scenario, name, error.message);
    await snap('failure-' + scenario).catch(() => {});
  }
  await writeFile(join(evidence, 'results.json'), JSON.stringify(results, null, 2));
}
async function snap(name) {
  await page.waitForLoadState('networkidle');
  const path = join(evidence, name + '.png');
  await page.screenshot({ path, animations: 'disabled' });
  screenshots.push({ scenario, name, path });
}
async function settled() {
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await Promise.all(document.getAnimations().map(a => a.finished.catch(() => {})));
  });
}
async function expanded(post) {
  await page.waitForFunction(id => document.querySelector('.catchup-card.is-expanded')?.dataset.postId === id, post.id, { timeout: 5000 });
  await settled();
  assert.equal(await main().locator('.is-expanded').count(), 1);
}
async function focusCard(post) {
  await card(post).locator('[data-expand]').focus(); await expanded(post);
  await card(post).evaluate(el => el.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
}
async function removed(post) {
  await card(post).waitFor({ state: 'detached' });
}
function unchangedExcept(actual, before, fields) {
  const strip = p => Object.fromEntries(Object.entries(p).filter(([k]) => !fields.includes(k)));
  assert.deepEqual(strip(actual), strip(before));
}
async function assertStatus(post, value) {
  const result = await saved();
  const actual = result.posts.find(p => p.id === post.id);
  assert.equal(actual.status, value); unchangedExcept(actual, post, ['status', 'updatedAt']);
  return actual;
}
async function noObstruction() {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Horizontal page overflow');
  const covered = await page.locator('main a, main button, main select, aside[aria-label="Navigation"] > div.border-t a, aside[aria-label="Navigation"] > div.border-t button').evaluateAll(elements => elements.flatMap(el => {
    if (el.closest('[inert]') || getComputedStyle(el).visibility !== 'visible') return [];
    let r = el.getBoundingClientRect();
    let left = Math.max(0, r.left), right = Math.min(innerWidth, r.right), top = Math.max(60, r.top), bottom = Math.min(innerHeight - 10, r.bottom);
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
    }
    if (right <= left || bottom <= top) return [];
    const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    return hit && el.contains(hit) ? [] : [el.textContent?.trim() || el.getAttribute('aria-label')];
  }));
  assert.deepEqual(covered, [], 'Visible core controls must not be obscured');
}

async function runScenario(name, run) {
  if (process.env.C7_SCENARIOS && !process.env.C7_SCENARIOS.split(',').includes(name)) return;
  scenario = name; db = join(evidence, name + '.sqlite'); port = 0; apiOffline = false;
  try {
    await start(); page = await newPage(); await page.goto(base + '/'); await saved(0);
    if (name !== 'empty-library') {
      await page.evaluate(async posts => {
        const response = await fetch('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts, deletedUrls: [] }) });
        if (!response.ok) throw new Error('Fixture seed failed');
      }, seed);
      await page.reload(); await saved(); await expanded(queue[0]);
    }
    await run(); await snapshot();
  } finally {
    if (page && process.env.C7_TRACE_FOCUS) await writeFile(join(evidence, name + '-focus-trace.json'), JSON.stringify(await page.evaluate(() => window.__focusTrace), null, 2));
    if (page) await page.context().close(); await stop();
  }
}

try {
  browser = await chromium.launch({ headless: true, channel: process.env.C7_BROWSER_CHANNEL || undefined });
  await runScenario('empty-library', async () => {
    await check('21 genuine empty library, honest copy and reachable import navigation', async () => {
      assert.deepEqual(await posts(), []);
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('library-store-v1')).state.demo), false);
      assert.equal(await main().getByRole('heading', { name: 'Your library is empty', exact: true }).count(), 1);
      assert.doesNotMatch(await main().innerText(), /All caught up|saved links are still|sample library|demo only/i);
      assert.equal(await main().locator('[data-post-id]').count(), 0);
      await noObstruction(); await snap('empty-library');
      const importLink = main().getByRole('link', { name: 'Import saved links', exact: true });
      await importLink.focus(); await page.keyboard.press('Enter');
      assert.equal(new URL(page.url()).pathname, '/library/settings');
      assert.equal(await page.getByLabel('Import bookmarks HTML').count(), 1);
      assert.equal(await page.getByLabel('Import Telegram JSON').count(), 1);
      await saved(0);
      await page.goto(base + '/'); await main().getByRole('link', { name: 'Browse the library' }).click();
      assert.equal(await main().locator('article').count(), 0); await saved(0);
      return '0 SQLite/browser records; explicit empty state, both import controls and empty Library reachable; no sample/personal confusion';
    });
  });
  await runScenario('degraded', async () => {
    await check('22 unavailable backend retains library; all triage pending until retry', async () => {
      const before = sorted((await saved()).posts);
      apiOffline = true; await page.reload();
      await status().filter({ hasText: 'SQLite unavailable' }).waitFor();
      assert.match(await status().innerText(), /browser cache/);
      assert.deepEqual(sorted(await posts()), before);
      await noObstruction(); await snap('degraded-cached-library');
      const actions = ['reference', 'archived', 'to-review'];
      for (let i = 0; i < actions.length; i++) {
        const post = queue[i]; await focusCard(post);
        await card(post).locator(`[data-triage="${actions[i]}"]`).focus(); await page.keyboard.press('Enter');
        await removed(post);
        assert.equal((await posts()).find(p => p.id === post.id).status, actions[i]);
      }
      await status().filter({ hasText: '3 changes pending SQLite save' }).waitFor();
      await status().filter({ hasText: 'Fixture backend unavailable' }).waitFor();
      assert.doesNotMatch(await status().innerText(), /Library saved to SQLite/);
      assert.deepEqual(sorted((await snapshot()).posts), before);
      const expected = sorted(await posts()); assert.equal(expected.length, 8);
      for (const post of expected) unchangedExcept(post, before.find(p => p.id === post.id), ['status', 'updatedAt']);
      await snap('degraded-triage-pending');
      await main().getByRole('link', { name: 'Library', exact: true }).click();
      assert.equal(await main().locator('article').count(), 8);
      await page.getByPlaceholder('Search… ( / )').fill('TypeScript notes');
      assert.equal(await main().locator('article').count(), 1);
      await page.goto(base + '/'); await status().filter({ hasText: 'Fixture backend unavailable' }).waitFor();
      assert.deepEqual(sorted(await posts()), expected);
      await status().getByRole('button', { name: 'Retry SQLite save' }).click();
      await status().filter({ hasText: 'Fixture backend unavailable' }).waitFor();
      assert.deepEqual(sorted((await snapshot()).posts), before);
      apiOffline = false;
      await status().getByRole('button', { name: 'Retry SQLite save' }).click(); await saved();
      assert.deepEqual(sorted((await snapshot()).posts), expected);
      await snap('degraded-retry-saved');
      return 'All 8 retained; Keep/reference, Archive/archived, Later/to-review remain pending through offline reload/retry; reconnect saves exact documents';
    });
  });
  await runScenario('reduced-motion', async () => {
    await check('24 reduced motion: instant expansion, triage/focus/Undo remain usable', async () => {
      assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
      await card(queue[1]).hover(); await expanded(queue[1]);
      const motion = await card(queue[1]).evaluate(el => {
        const style = getComputedStyle(el), image = el.querySelector('img');
        return { duration: style.transitionDuration, animation: style.animationDuration, imageTransform: image ? getComputedStyle(image).transform : null };
      });
      assert.ok(motion.duration.split(',').every(v => parseFloat(v) <= .001), JSON.stringify(motion));
      assert.ok(motion.imageTransform === null || motion.imageTransform === 'none');
      await focusCard(queue[1]); await snap('reduced-motion-expanded');
      const actions = ['reference', 'archived', 'to-review'];
      for (let i = 0; i < actions.length; i++) {
        const post = queue[i]; await focusCard(post);
        await card(post).locator(`[data-triage="${actions[i]}"]`).focus();
        await page.keyboard.press('Enter'); await removed(post); await expanded(queue[i + 1]);
        assert.deepEqual(await page.evaluate(() => ({ id: document.activeElement?.closest('[data-post-id]')?.dataset.postId, action: document.activeElement?.getAttribute('data-triage'), inert: !!document.activeElement?.closest('[inert]') })), { id: queue[i + 1].id, action: actions[i], inert: false });
        await assertStatus(post, actions[i]);
      }
      await noObstruction(); await snap('reduced-motion-after-triage');
      await main().getByRole('button', { name: 'Undo', exact: true }).click();
      await expanded(queue[2]); await assertStatus(queue[2], 'inbox');
      assert.equal(await card(queue[2]).count(), 1);
      assert.equal(await card(queue[2]).locator('[data-expand]').evaluate(el => el === document.activeElement), true);
      return { ...motion, result: 'all three actions transfer equivalent focus; no long flex/image motion; Undo restores exactly one card with expand-button focus' };
    });
  });
  await runScenario('local-rejection', async () => {
    await check('local rejection leaves exact state/card/focus; retry succeeds once', async () => {
      await writeFile(join(evidence, 'local-rejection-served.js'), rejectionBundle);
      const before = sorted((await saved()).posts), target = queue[0];
      await page.evaluate(id => { window.__rejectTriage = id; }, target.id);
      await focusCard(target); const keep = card(target).getByRole('button', { name: 'Keep', exact: true });
      await keep.focus(); await page.keyboard.press('Enter');
      await main().getByRole('alert').filter({ hasText: 'That change was not accepted' }).waitFor();
      await settled();
      assert.equal(await page.evaluate(() => window.__rejectionCalls), 1);
      assert.equal(await card(target).count(), 1); assert.equal(await main().locator('.is-leaving').count(), 0);
      assert.equal(await main().getByRole('button', { name: 'Undo', exact: true }).count(), 0);
      assert.equal(await keep.evaluate(el => el === document.activeElement && !el.closest('[inert]')), true);
      assert.deepEqual(sorted(await posts()), before); assert.deepEqual(sorted((await saved()).posts), before);
      await snap('local-rejection-retained');
      await page.evaluate(() => { delete window.__rejectTriage; });
      await page.keyboard.press('Enter'); await removed(target); await expanded(queue[1]);
      await assertStatus(target, 'reference');
      assert.equal(await main().getByRole('alert').count(), 0);
      assert.equal(new Set((await posts()).map(p => p.id)).size, 8);
      for (const post of await posts()) if (post.id !== target.id) assert.deepEqual(post, before.find(p => p.id === post.id));
      assert.equal(await card(queue[1]).locator('[data-triage="reference"]').evaluate(el => el === document.activeElement), true);
      await snap('local-rejection-retry-accepted');
      return 'Test-only early return before updatePost mutation: card, all fields, pending state and keyboard focus retained; retry updates only target once';
    });
  });
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
} finally {
  if (browser) await browser.close(); await stop();
  await writeFile(join(evidence, 'runtime.json'), JSON.stringify({ events, errors, denied, consoleMessages, requests, results, screenshots, stopped: !server }, null, 2));
  console.log('CLEANUP owned fixture servers and browser closed; evidence', evidence);
}
assert.deepEqual(results.filter(r => r.status === 'FAIL').map(r => r.scenario + '/' + r.name), [], 'Phase 3 checks failed');
