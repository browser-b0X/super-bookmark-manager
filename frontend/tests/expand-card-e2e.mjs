import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, appendFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = await mkdtemp(join(root, '.verify/g4-c7-expand-20260918/e2e-'));
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
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
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
  const fixturePosts = name === 'overflow' ? seed.map(p => ({ ...p, status: 'inbox' })) : seed;
  try {
    await start(); page = await newPage(); await page.goto(base + '/'); await saved(0);
    await page.evaluate(async posts => {
      const response = await fetch('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts, deletedUrls: [] }) });
      if (!response.ok) throw new Error('Fixture seed failed');
    }, fixturePosts);
    await page.reload(); await saved(); await expanded(queue[0]);
    await run(); await snapshot();
  } finally { if (page) await page.context().close(); await stop(); }
}

try {
  browser = await chromium.launch({ headless: true, channel: process.env.C7_BROWSER_CHANNEL || undefined });
  await runScenario('keyboard', async () => {
    await check('17 keyboard triage transfers equivalent focus', async () => {
      await focusCard(queue[0]);
      for (let i = 0; i < 10; i++) {
        if (await page.evaluate(() => document.activeElement?.getAttribute('data-triage') === 'reference')) break;
        await page.keyboard.press('Tab');
      }
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-triage')), 'reference');
      await snap('keyboard-before-triage');
      await page.keyboard.press('Enter');
      await removed(queue[0]); await expanded(queue[1]);
      const focused = await page.evaluate(() => ({ id: document.activeElement?.closest('[data-post-id]')?.dataset.postId, action: document.activeElement?.getAttribute('data-triage'), inert: !!document.activeElement?.closest('[inert]') }));
      assert.deepEqual(focused, { id: queue[1].id, action: 'reference', inert: false });
      await assertStatus(queue[0], 'reference'); await noObstruction(); await snap('after-triage-next');
      return focused;
    });
  });
  await runScenario('rapid', async () => {
    await check('16 rapid distinct triage, inert exits and no duplicate actions', async () => {
      const actions = ['reference', 'archived', 'to-review'];
      const timing = await page.evaluate(async actions => {
        const observations = [], start = performance.now();
        for (const action of actions) {
          const el = document.querySelector('.catchup-card.is-expanded');
          const button = el.querySelector(`[data-triage="${action}"]`);
          button.click(); button.click();
          await new Promise(requestAnimationFrame);
          observations.push({ id: el.dataset.postId, leaving: el.classList.contains('is-leaving'), inert: el.inert, time: performance.now() - start });
        }
        return observations;
      }, actions);
      assert.ok(timing.every(t => t.leaving && t.inert), JSON.stringify(timing));
      assert.ok(timing.at(-1).time < 220, 'Rapid actions must overlap exit timers: ' + JSON.stringify(timing));
      for (let i = 0; i < 3; i++) { await removed(queue[i]); await assertStatus(queue[i], actions[i]); }
      const result = await saved();
      for (const post of seed.filter(p => !queue.slice(0, 3).some(q => q.id === p.id))) assert.deepEqual(result.posts.find(p => p.id === post.id), post);
      const ids = await main().locator('[data-post-id]').evaluateAll(els => els.map(e => e.dataset.postId));
      assert.equal(ids.length, 3); assert.equal(new Set(ids).size, 3); await expanded(queue[3]);
      return timing;
    });
  });
  await runScenario('triage', async () => {
    for (const [i, value, label] of [[0, 'reference', 'Keep'], [1, 'archived', 'Archive'], [2, 'to-review', 'Later']]) {
      await check(`${12 + i} ${label} is a retained Library state`, async () => {
        await focusCard(queue[i]); await card(queue[i]).getByRole('button', { name: label, exact: true }).click();
        await removed(queue[i]); await assertStatus(queue[i], value);
        if (value === 'to-review') await main().getByRole('link', { name: /saved for later/ }).click();
        else await main().getByRole('link', { name: 'Library', exact: true }).click();
        await main().getByRole('link', { name: queue[i].title, exact: true }).waitFor();
        await page.goto(base + '/'); await saved();
      });
    }
    await check('15 last card promotes preceding; 18 Undo preserves all curation', async () => {
      const last = queue.at(-1), preceding = queue.at(-2);
      await focusCard(last); await card(last).getByRole('button', { name: 'Archive', exact: true }).click();
      await removed(last); await expanded(preceding); await assertStatus(last, 'archived');
      assert.equal(await page.evaluate(() => document.activeElement?.closest('[data-post-id]')?.dataset.postId), preceding.id);
      await page.getByRole('button', { name: 'Undo', exact: true }).click(); await expanded(last);
      await assertStatus(last, 'inbox'); assert.equal(await card(last).count(), 1);
      assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-expand')), true);
    });
    await check('19 reload, owned restart and fresh context recover exact triage', async () => {
      const before = await posts();
      await page.reload(); await saved(); assert.deepEqual(sorted(await posts()), sorted(before));
      await stop(); await start(); await page.reload(); await saved(); assert.deepEqual(sorted(await posts()), sorted(before));
      await page.context().close(); page = await newPage(); await page.goto(base + '/'); await saved();
      assert.deepEqual(sorted(await posts()), sorted(before));
      for (const post of queue.slice(0, 3)) assert.equal(await card(post).count(), 0);
    });
    await check('20 final triage shows retained-library state and preserves focus', async () => {
      for (const post of ordered(await posts())) {
        await focusCard(post); await card(post).getByRole('button', { name: 'Keep', exact: true }).press('Enter'); await removed(post);
      }
      await saved(); await main().getByRole('heading', { name: 'All caught up' }).waitFor();
      assert.match(await main().innerText(), /8 saved links are still in your library/);
      assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Browse the library');
      await noObstruction(); await snap('zero-inbox');
      await main().getByRole('link', { name: 'Browse the library' }).press('Enter');
      assert.equal(await main().locator('article').count(), 8);
    });
  });
  await runScenario('failed-save', async () => {
    await check('25 SQLite failure preserves pending triage and retry saves it', async () => {
      const before = (await saved()).posts;
      await control('fail-on');
      await focusCard(queue[0]); await card(queue[0]).getByRole('button', { name: 'Keep', exact: true }).click(); await removed(queue[0]);
      await status().getByRole('button', { name: 'Retry SQLite save', exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector('[aria-label="SQLite save status"]')?.textContent.includes('Changes were not saved; retry when storage is available.'), null, { timeout: 5000 });
      assert.match(await status().innerText(), /1 change pending SQLite save/);
      assert.doesNotMatch(await status().innerText(), /Library saved to SQLite/);
      assert.deepEqual(sorted((await snapshot()).posts), sorted(before));
      assert.equal((await posts()).find(p => p.id === queue[0].id).status, 'reference');
      await snap('failed-save-pending');
      await page.reload();
      await page.waitForFunction(() => document.querySelector('[aria-label="SQLite save status"]')?.textContent.includes('Changes were not saved; retry when storage is available.'), null, { timeout: 5000 });
      assert.match(await status().innerText(), /1 change pending SQLite save/);
      assert.equal(await card(queue[0]).count(), 0);
      assert.deepEqual(sorted((await snapshot()).posts), sorted(before));
      assert.equal((await posts()).find(p => p.id === queue[0].id).status, 'reference');
      await snap('failed-save-reloaded-pending');
      await control('fail-off'); await status().getByRole('button', { name: 'Retry SQLite save', exact: true }).click();
      await assertStatus(queue[0], 'reference');
      await snap('failed-save-retry-saved');
      await page.getByRole('link', { name: 'Library', exact: true }).last().click();
      await main().getByRole('link', { name: queue[0].title, exact: true }).waitFor();
    });
  });
  await runScenario('layout', async () => {
    await check('1/2/11 horizontal rail retains all ordered inbox records', async () => {
      await snap('default-expanded');
      const geometry = await main().locator('.catchup-rail').evaluate(el => ({ display: getComputedStyle(el).display, overflow: el.scrollWidth > el.clientWidth, cards: [...el.children].map(c => ({ id: c.dataset.postId, width: c.getBoundingClientRect().width, height: c.getBoundingClientRect().height, expanded: c.classList.contains('is-expanded') })) }));
      assert.equal(geometry.display, 'flex'); assert.equal(geometry.overflow, false);
      assert.deepEqual(geometry.cards.map(c => c.id), queue.map(p => p.id));
      assert.ok(geometry.cards.every(c => Math.abs(c.height - 490) < 1 && (c.expanded ? c.width >= 400 : Math.abs(c.width - 88) < 1)));
      await noObstruction(); return geometry;
    });
    await check('3/4 hover expands and restores without state mutation', async () => {
      const before = (await snapshot()).posts;
      await card(queue[1]).locator('[data-expand]').hover(); await expanded(queue[1]); await snap('hover-expanded');
      await page.mouse.move(1300, 50); await expanded(queue[0]);
      assert.deepEqual(sorted((await snapshot()).posts), sorted(before));
    });
    await check('5 keyboard expansion exposes content with visible focus', async () => {
      await focusCard(queue[1]); await snap('keyboard-expanded');
      assert.equal(await card(queue[1]).locator('.catchup-content').evaluate(el => el.inert), false);
      assert.equal(await card(queue[1]).locator('[data-expand]').evaluate(el => el.matches(':focus-visible')), true);
    });
    await check('6/8/9/10/23 readable sources, previews, fallbacks and reachable controls', async () => {
      const before = (await snapshot()).posts;
      for (const post of queue) {
        await focusCard(post); const text = await card(post).innerText();
        assert.ok(text.includes(post.title) && text.includes(post.domain) && text.includes(post.categories[0]) && text.includes('Inbox') && text.includes('Saved'));
        assert.ok(text.includes(post.source === 'browser' ? 'Browser bookmark' : 'Telegram'));
        if (post.excerpt) assert.ok(text.includes(post.excerpt));
        assert.equal(await card(post).getByRole('link', { name: 'Open original' }).isVisible(), true);
        assert.equal(await card(post).getByRole('button', { name: 'Keep', exact: true }).isVisible(), true);
        const path = new URL(post.url).pathname;
        if (['/art', '/travel'].includes(path)) {
          const size = await card(post).locator('img').evaluate(el => ({ natural: el.naturalWidth, width: el.clientWidth, height: el.clientHeight, fit: getComputedStyle(el).objectFit }));
          assert.equal(size.natural, 640); assert.ok(size.width >= 390 && size.height >= 480); assert.equal(size.fit, 'cover');
        } else {
          await card(post).getByLabel('No content preview available').waitFor(); assert.equal(await card(post).locator('img').count(), 0);
          if (path === '/budgeting') await snap('broken-image-fallback');
          if (path === '/no-metadata') await snap('missing-image-fallback');
        }
        await noObstruction();
      }
      assert.deepEqual(sorted((await snapshot()).posts), sorted(before));
      assert.equal(await page.getByRole('button', { name: /Search or jump to/ }).isVisible(), true);
    });
    await check('7 original URLs and local Details remain exact', async () => {
      for (const post of queue) {
        await focusCard(post);
        for (const link of [card(post).getByRole('link', { name: post.title, exact: true }), card(post).getByRole('link', { name: 'Open original' })]) {
          assert.equal(await link.getAttribute('href'), post.url); assert.equal(await link.getAttribute('target'), '_blank');
          assert.match(await link.getAttribute('rel'), /noopener/); assert.match(await link.getAttribute('rel'), /noreferrer/);
        }
        assert.equal(await card(post).getByRole('link', { name: 'Details', exact: true }).getAttribute('href'), '/library/item/' + post.id);
      }
      const post = queue.at(-1); expectedExternal = post.url;
      const popupPromise = page.context().waitForEvent('page');
      await card(post).getByRole('link', { name: 'Open original' }).click();
      const popup = await popupPromise; await popup.waitForLoadState(); assert.equal(popup.url(), post.url); await popup.close(); expectedExternal = undefined;
      await saved();
      await card(post).getByRole('link', { name: 'Details', exact: true }).click();
      await page.getByRole('dialog', { name: 'Saved post detail' }).waitFor();
      assert.equal(new URL(page.url()).pathname, '/library/item/' + post.id);
    });
    await check('Phase 2 degraded screenshot only; full check 22 deferred', async () => {
      apiOffline = true; await page.goto(base + '/');
      await status().filter({ hasText: /SQLite unavailable/ }).waitFor(); await snap('degraded-cache'); apiOffline = false;
    });
  });
  await runScenario('overflow', async () => {
    await check('11 overflow preserves all eight records and permits last-card access', async () => {
      const before = (await saved()).posts;
      const rail = main().locator('.catchup-rail');
      const geometry = await rail.evaluate(el => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, ids: [...el.children].map(c => c.dataset.postId) }));
      assert.ok(geometry.scrollWidth > geometry.clientWidth, JSON.stringify(geometry));
      assert.deepEqual(geometry.ids, ordered(before).map(p => p.id));
      await focusCard(ordered(before).at(-1));
      assert.ok(await rail.evaluate(el => el.scrollLeft > 0));
      await noObstruction(); await snap('overflow-last-card');
      assert.deepEqual(sorted((await saved()).posts), sorted(before));
      return geometry;
    });
  });
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
} finally {
  if (browser) await browser.close(); await stop();
  await writeFile(join(evidence, 'runtime.json'), JSON.stringify({ events, errors, denied, consoleMessages, requests, results, screenshots, stopped: !server }, null, 2));
  console.log('CLEANUP owned fixture servers and browser closed; evidence', evidence);
}
assert.deepEqual(results.filter(r => r.status === 'FAIL').map(r => r.scenario + '/' + r.name), [], 'Expand-card checks failed');
