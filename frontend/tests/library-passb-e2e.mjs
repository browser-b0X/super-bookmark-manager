import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdtemp, appendFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../../', import.meta.url));
const stage = process.argv[2] || 'built';
assert.ok(['red', 'built', 'favorites', 'favorites-source', 'shell-source', 'shell', 'sidebar-repair', 'b3-baseline', 'b3-diagnose', 'b3-matrix'].includes(stage));
const selectedCheck = process.env.PASSB_CHECK;
assert.ok(!selectedCheck || (stage === 'sidebar-repair' && selectedCheck === 'sidebar-write'), 'PASSB_CHECK only supports sidebar-write in the sidebar-repair stage');
assert.ok(process.env.PASSB_RUN, 'PASSB_RUN must point to the preserved run directory');
const output = await mkdtemp(join(process.env.PASSB_RUN, stage + '-'));
const b3 = stage === 'b3-baseline' || stage === 'b3-diagnose';
const b3LedgerPath = join(process.env.PASSB_RUN, 'captures.json');
const b3Cases = stage === 'b3-baseline'
  ? [390, 320].flatMap(width => ['dark', 'light'].map(mode => ({ name: `${width}-${mode}`, width, mode, animations: 'disabled' })))
  : ['disabled', 'disabled-replay', 'allow', 'disabled-clip'].map(name => ({ name, width: 390, mode: 'light', animations: name === 'allow' ? 'allow' : 'disabled', clip: name === 'disabled-clip' }));
let b3Capture;
const matrix = stage === 'b3-matrix';
let matrixCase;
const matrixLedger = [];
const { chromium } = createRequire(import.meta.url)(process.env.C6_PLAYWRIGHT_MODULE);
const seed = JSON.parse(await readFile(join(root, 'frontend/tests/fixtures/retrieval-library.json'), 'utf8'));
const image = await readFile(join(root, 'frontend/tests/fixtures/landing-preview.svg'), 'utf8');
for (const post of seed) {
  const path = new URL(post.url).pathname;
  if (['/art', '/travel'].includes(path)) post.thumbnailUrl = '/__fixture/preview.svg';
  if (path === '/exercise') post.thumbnailUrl = '/__fixture/tiny.svg';
  if (path === '/budgeting') post.thumbnailUrl = '/__fixture/broken.svg';
}
const byPath = path => seed.find(p => new URL(p.url).pathname === path);
const programming = byPath('/programming'), travel = byPath('/travel');
const sorted = posts => [...posts].sort((a, b) => a.id.localeCompare(b.id));
const queue = seed.filter(p => p.status === 'inbox').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
const report = { stage, selectedCheck, results: [], events: [], errors: [], denied: [], requests: [], consoleErrors: [], responses: [], expected503: [], controlledWrites: [], measurements: [], screenshots: [], snapshots: [], browserClosed: false, devServerClosed: false };
if (b3) report.captureSettings = {
  ledgerPath: b3LedgerPath, limits: { global: 20, nonfailurePerStage: 4, globalFailure: 2 },
  method: 'page.screenshot', defaultOptions: { animations: 'disabled' }, cases: b3Cases,
  coordinateSpace: 'viewport CSS pixels (including clipped captures)', paintAssertion: false,
};
let child, exit, browser, page, vite, base, controlledWrite;
const expected503Text = /^Failed to load resource: the server responded with a status of 503 \((?:SERVICE UNAVAILABLE|Service Unavailable)\)$/;
function measured(name, detail) {
  report.measurements.push({ name, detail }); console.log('MEASURED', name, JSON.stringify(detail));
  return detail;
}
const pending = new Map();
const control = command => new Promise(resolve => { pending.set(command, resolve); child.stdin.write(JSON.stringify({ command }) + '\n'); });
const cards = () => page.locator('main article');
const card = post => cards().filter({ has: page.locator(`a[href="/library/item/${post.id}"]`) });
const title = post => card(post).getByRole('link', { name: post.title, exact: true });
const search = () => page.getByPlaceholder('Search… ( / )');
const settled = () => page.evaluate(async () => { await new Promise(requestAnimationFrame); await Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))); });
async function check(number, name, run) {
  try {
    const detail = await run();
    report.results.push({ number, name, status: 'PASS', detail }); console.log('PASS', number, name);
  } catch (error) {
    report.results.push({ number, name, status: 'FAIL', error: error.stack }); console.error('FAIL', number, name, error.message);
    if (matrix) await matrixSnap(`failure-${number}-${report.results.length}.png`).catch(e => measured('b3/failure-capture', { error: e.stack }));
    else if (b3) await b3Snap(`failure-${number}-${report.results.length}.png`, true).catch(e => measured('b3/failure-capture', { error: e.stack }));
    else await page.screenshot({ path: join(output, `failure-${number}-${report.results.length}.png`), animations: 'disabled' }).catch(() => {});
  }
}
async function saved() {
  const status = page.getByRole('status', { name: 'SQLite save status' });
  if (stage === 'sidebar-repair') {
    // The compact rail also has a short visual label. Its accessible message
    // must retain the same complete statement as the expanded status.
    await status.filter({ hasText: 'Library saved to SQLite' }).waitFor();
    assert.match(await status.ariaSnapshot(), /Library saved to SQLite/);
  } else await status.filter({ hasText: /^Library saved to SQLite$/ }).waitFor();
  await page.waitForFunction(() => {
    const state = JSON.parse(localStorage.getItem('library-store-v1') || '{}').state;
    return state?.posts.length === 8 && Object.keys(state.pending).length === 0;
  });
}
async function snapshot(name) {
  await saved();
  const sqlite = (await control('snapshot')).result;
  const browserPosts = await page.evaluate(() => JSON.parse(localStorage.getItem('library-store-v1')).state.posts);
  const api = await page.evaluate(async () => (await (await fetch('/api/library')).json()));
  assert.deepEqual(sqlite.blocked, []); assert.equal(sqlite.legacyCount, 0); assert.deepEqual(sqlite.deletedUrls, []);
  const value = { browser: sorted(browserPosts), sqlite: sorted(sqlite.posts), api: sorted(api.posts) };
  assert.deepEqual(value.browser, value.sqlite); assert.deepEqual(value.api, value.sqlite);
  report.snapshots.push({ name, value });
  return value;
}
async function newPage(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, serviceWorkers: 'block', ...options });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) { report.denied.push(url.href); return route.abort(); }
    if (url.pathname === '/__fixture/broken.svg') return route.fulfill({ status: 404, body: 'Synthetic missing image' });
    if (url.pathname === '/__fixture/tiny.svg') return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#6c8cff"/></svg>' });
    if (url.pathname === '/__fixture/preview.svg') return route.fulfill({ contentType: 'image/svg+xml', body: image });
    return route.continue();
  });
  const next = await context.newPage(); next.setDefaultTimeout(10000);
  next.on('pageerror', e => report.errors.push(e.message));
  const requestIds = new WeakMap();
  next.on('console', m => {
    if (m.type() !== 'error') return;
    const entry = { text: m.text(), url: m.location().url };
    if (controlledWrite?.page === next && entry.url === base + '/api/library' && expected503Text.test(entry.text)) {
      report.expected503.push({ ...entry, group: controlledWrite.record.name });
    } else report.consoleErrors.push(entry);
  });
  next.on('request', r => {
    const id = report.requests.length; requestIds.set(r, id);
    report.requests.push({ url: r.url(), method: r.method() });
    if (controlledWrite?.page === next && r.url() === base + '/api/library' && r.method() === 'POST') controlledWrite.record.attempts.push(id);
  });
  next.on('response', r => {
    if (r.status() >= 400) report.responses.push({ request: requestIds.get(r.request()), url: r.url(), method: r.request().method(), status: r.status() });
  });
  return next;
}
async function library() { await page.goto(base + '/library'); await saved(); await search().waitFor(); await settled(); }
const menu = () => page.locator('header').getByRole('button', { name: 'Menu', exact: true, includeHidden: true });
const navigation = () => page.getByRole('dialog', { name: 'Mobile navigation', exact: true });
async function theme(value) {
  // isVisible is immediate: pre-repair source must reach the original obstruction,
  // not spend a timeout waiting for a Menu that has not been implemented yet.
  const hasMenu = await menu().isVisible();
  if (await page.locator('html').getAttribute('data-theme') !== value) {
    if (hasMenu && !(await navigation().isVisible())) {
      await tabTo(menu()); await page.keyboard.press('Enter'); await navigation().waitFor();
    }
    const toggle = page.getByTitle('Toggle theme', { exact: true });
    assert.equal(await toggle.isVisible(), true, 'Use the real visible theme button, including pre-Menu source');
    await tabTo(toggle); await page.keyboard.press('Enter');
  }
  assert.equal(await page.locator('html').getAttribute('data-theme'), value);
  if (await navigation().isVisible()) {
    await tabTo(navigation().getByRole('button', { name: 'Close navigation', exact: true }));
    await page.keyboard.press('Enter'); await navigation().waitFor({ state: 'hidden' });
  }
  await settled();
}
async function tabTo(target, direction = 'Tab', limit = 120) {
  assert.equal(await target.count(), 1);
  for (let step = 0; step < limit; step++) {
    if (await target.evaluate(el => el === document.activeElement)) return;
    await page.keyboard.press(direction);
  }
  throw new Error('Unreachable keyboard control');
}
async function panelState(post) {
  return card(post).locator('.cell-overlay').evaluate(el => {
    const s = getComputedStyle(el);
    return { opacity: s.opacity, visibility: s.visibility, transform: s.transform, transition: s.transition, text: el.textContent, position: s.position };
  });
}
async function focusCheck() {
  await library(); await page.mouse.move(0, 0); await search().focus();
  await tabTo(title(programming)); await settled();
  assert.equal(await title(programming).evaluate(el => el === document.activeElement && el.matches(':focus-visible')), true);
  const state = await panelState(programming);
  assert.equal(state.opacity, '1', 'Keyboard focus must reveal the supplementary panel');
  assert.equal(state.visibility, 'visible');
  assert.ok(state.text.includes(programming.excerpt));
  return state;
}
async function b3Metadata() {
  return { browserVersion: browser.version(), contextViewport: page.viewportSize(), ...await page.evaluate(programmingId => {
    const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const identity = el => el ? { tag: el.tagName, id: el.id, className: el.getAttribute('class'), postId: el.dataset?.postId } : null;
    const styles = (el, pseudo) => {
      const s = getComputedStyle(el, pseudo);
      return Object.fromEntries(['backgroundColor', 'backgroundImage', 'opacity', 'visibility', 'position', 'transform', 'transition', 'animation', 'animationFillMode', 'overflow', 'overflowX', 'overflowY', 'borderRadius', 'clipPath', 'contain', 'contentVisibility', 'willChange', 'filter', 'backdropFilter', 'maskImage', 'zIndex', 'display', 'content', 'color', 'fontSize', 'lineHeight'].map(key => [key, s[key]]));
    };
    const animations = el => el.getAnimations({ subtree: true }).map(a => ({
      id: a.id, name: a.animationName, transitionProperty: a.transitionProperty, playState: a.playState,
      pending: a.pending, currentTime: a.currentTime, startTime: a.startTime, playbackRate: a.playbackRate,
      target: identity(a.effect?.target), timing: a.effect?.getTiming(), computedTiming: a.effect?.getComputedTiming(),
    }));
    const s = getComputedStyle(document.documentElement), backgroundColor = getComputedStyle(document.body).backgroundColor;
    const focus = document.activeElement, vv = window.visualViewport;
    return {
      timestamp: new Date().toISOString(), viewport: { width: innerWidth, height: innerHeight }, dpr: devicePixelRatio,
      background: backgroundColor.match(/[\d.]+/g)?.slice(0, 3).map(Number), backgroundColor,
      backgroundVariables: Object.fromEntries(['--bg', '--surface', '--surface2', '--elev'].map(key => [key, s.getPropertyValue(key).trim()])),
      backgrounds: [...document.querySelectorAll('html, body, main, .cell-grid')].map(el => ({ ...identity(el), styles: styles(el) })),
      theme: document.documentElement.dataset.theme, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      media: Object.fromEntries(['(hover: none)', '(hover: hover)', '(pointer: coarse)', '(pointer: fine)', '(any-hover: hover)', '(prefers-reduced-motion: reduce)'].map(query => [query, matchMedia(query).matches])),
      pointerState: { active: [...document.querySelectorAll(':active')].map(identity), hover: [...document.querySelectorAll(':hover')].map(identity) },
      scroll: { x: scrollX, y: scrollY }, visualViewport: vv && { width: vv.width, height: vv.height, offsetLeft: vv.offsetLeft, offsetTop: vv.offsetTop, pageLeft: vv.pageLeft, pageTop: vv.pageTop, scale: vv.scale },
      scrolls: [...document.querySelectorAll('*')].filter(el => el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth || el.scrollTop || el.scrollLeft)
        .map(el => ({ ...identity(el), rect: rect(el), x: el.scrollLeft, y: el.scrollTop, scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight, clientWidth: el.clientWidth, clientHeight: el.clientHeight })),
      focus: focus && { ...identity(focus), rect: rect(focus), focusVisible: focus.matches(':focus-visible') },
      cards: [...document.querySelectorAll('main article')].map(el => ({
        id: el.dataset.postId, rect: rect(el), styles: styles(el), animations: animations(el),
        pseudo: { before: styles(el, '::before'), after: styles(el, '::after') },
        children: el.dataset.postId === programmingId ? [...el.querySelectorAll('*')].map(child => ({ ...identity(child), rect: rect(child), styles: styles(child), pseudo: { before: styles(child, '::before'), after: styles(child, '::after') } })) : [],
      })),
    };
  }, programming.id) };
}
async function b3Snap(name, failure = false) {
  name = `${stage}-${b3Capture?.name || 'check'}-${name}`;
  const path = join(output, name);
  let ledger;
  try { ledger = JSON.parse(await readFile(b3LedgerPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; ledger = []; }
  assert.ok(Array.isArray(ledger), 'B3 capture ledger must be an array');
  assert.ok(ledger.every(e => e && typeof e.stage === 'string' && typeof e.name === 'string' && typeof e.path === 'string' && typeof e.failure === 'boolean' && typeof e.success === 'boolean'), 'Invalid B3 capture ledger entry');
  assert.ok(ledger.length < 20, 'B3 global capture cap (including unsuccessful reservations)');
  if (failure) assert.ok(ledger.filter(e => e.failure).length < 2, 'B3 shared failure capture cap');
  else assert.ok(ledger.filter(e => e.stage === stage && !e.failure).length < 4, 'B3 stage capture cap');
  const entry = { stage, name, path, failure, success: false }; ledger.push(entry);
  // Serialized B3 invocations share this ledger; reservations are never refunded.
  await writeFile(b3LedgerPath, JSON.stringify(ledger, null, 2));
  const options = { path, animations: failure ? 'disabled' : b3Capture.animations };
  const metadata = { before: await b3Metadata(), after: null, options, coordinateSpace: 'viewport CSS pixels' };
  if (!failure && b3Capture.clip) {
    const r = metadata.before.cards.find(c => c.id === programming.id).rect, v = metadata.before.viewport;
    const x = Math.max(0, r.x), y = Math.max(0, r.y);
    options.clip = { x, y, width: Math.min(v.width, r.x + r.width) - x, height: Math.min(v.height, r.y + r.height) - y };
    assert.ok(options.clip.width > 0 && options.clip.height > 0, 'Programming has a visible clip');
    metadata.clip = { ...options.clip }; // Original viewport coordinates in before/after remain untouched.
  }
  await writeFile(path + '.json', JSON.stringify(metadata, null, 2));
  try {
    await page.screenshot(options); entry.success = true; report.screenshots.push(name);
  } catch (error) { entry.error = error.stack; throw error; }
  finally {
    try { metadata.after = await b3Metadata(); }
    catch (error) { metadata.afterError = error.stack; throw error; }
    finally {
      await writeFile(path + '.json', JSON.stringify(metadata, null, 2));
      await writeFile(b3LedgerPath, JSON.stringify(ledger, null, 2));
    }
  }
}
async function matrixSnap(name, method = 'page', animations = 'allow') {
  assert.ok(matrixLedger.length < 32, 'B3 finite matrix capture cap includes failures');
  const path = join(output, name), options = { path, animations };
  const entry = { name, method, options, case: matrixCase, success: false };
  matrixLedger.push(entry);
  const ledgerPath = join(output, 'captures.json');
  await writeFile(ledgerPath, JSON.stringify(matrixLedger, null, 2));
  const metadata = { ...entry, before: await b3Metadata(), after: null };
  try {
    if (method === 'locator') await card(programming).screenshot(options);
    else await page.screenshot(options);
    entry.success = true; report.screenshots.push(name);
  } finally {
    metadata.after = await b3Metadata(); metadata.success = entry.success;
    await writeFile(path + '.json', JSON.stringify(metadata, null, 2));
    await writeFile(ledgerPath, JSON.stringify(matrixLedger, null, 2));
  }
}
async function snap(name) {
  if (matrix) return matrixSnap(`b3-${matrixCase.width}-${matrixCase.mode}.png`, 'page', 'disabled');
  if (b3) return b3Snap(name);
  await page.screenshot({ path: join(output, name), animations: 'disabled' }); report.screenshots.push(name);
}
async function geometry() {
  await settled();
  return page.locator('.cell-grid').evaluate(grid => {
    const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    return { viewport: innerWidth, available: grid.clientWidth, columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length, overflow: document.documentElement.scrollWidth > innerWidth, cards: [...grid.querySelectorAll('article')].map(el => ({ id: el.dataset.postId, ...rect(el), title: rect(el.querySelector('.cell-caption a')), titleLines: el.querySelector('.cell-caption a').getBoundingClientRect().height / parseFloat(getComputedStyle(el.querySelector('.cell-caption a')).lineHeight) })) };
  });
}
async function hitTargets() {
  for (const post of seed) {
    await card(post).scrollIntoViewIfNeeded();
    for (const control of [card(post).getByRole('checkbox'), card(post).getByRole('button'), title(post)]) {
      await control.focus(); await settled();
      const detail = await control.evaluate(el => {
        const r = el.getBoundingClientRect(), a = el.closest('article').getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2), s = getComputedStyle(el);
        const identity = node => node ? {
          tag: node.tagName, id: node.id, className: node.getAttribute('class'),
          role: node.getAttribute('role') || (node.matches('input[type="checkbox"]') ? 'checkbox' : node.matches('a[href]') ? 'link' : node.matches('button') ? 'button' : null),
          name: node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent?.trim().slice(0, 240),
          outerHTML: node.outerHTML.slice(0, 1200),
          styles: Object.fromEntries(['display', 'visibility', 'opacity', 'pointerEvents', 'position', 'zIndex', 'overflow'].map(key => [key, getComputedStyle(node)[key]])),
        } : null;
        return {
          ok: r.width > 0 && r.height > 0 && r.x >= a.x && r.right <= a.right + 1 && r.y >= a.y && r.bottom <= a.bottom + 1 && s.visibility === 'visible' && s.opacity === '1' && !!hit && el.contains(hit),
          innerWidth, innerHeight, clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight,
          theme: document.documentElement.dataset.theme, postId: el.closest('article').dataset.postId,
          control: identity(el), rect: r.toJSON(), articleRect: a.toJSON(),
          center: { x: r.x + r.width / 2, y: r.y + r.height / 2 }, hit: identity(hit),
        };
      });
      measured('hitTargets/' + post.id, detail);
      assert.equal(detail.ok, true, 'Visible unobscured contained control: ' + post.title);
    }
  }
}
async function freshLibrary(options = {}) {
  await page.context().close(); page = await newPage(options); await library();
}
const touchViewport = width => ({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
async function check27(width, mode) {
  assert.equal(await page.evaluate(() => matchMedia('(hover: none)').matches), true);
  await theme(mode); await search().focus();
  const detail = measured(`check27/${width}/${mode}`, { mode, ...await geometry() });
  assert.equal(detail.columns, 1); assert.equal(detail.overflow, false);
  const state = measured(`check27/${width}/${mode}/panel`, await panelState(programming));
  assert.equal(state.position, 'static'); assert.equal(state.visibility, 'visible'); assert.equal(state.opacity, '1');
  const controlsVisible = measured(`check27/${width}/${mode}/controls`, await page.locator('.cell-grid .hover-tool').evaluateAll(els => els.every(el => getComputedStyle(el).opacity === '1')));
  assert.equal(controlsVisible, true);
  await hitTargets(); await card(programming).scrollIntoViewIfNeeded(); await search().focus(); await card(programming).scrollIntoViewIfNeeded();
  assert.equal(await navigation().isVisible(), false);
  await snap(width === 390 && mode === 'dark' ? 'library-pass-b-mobile.png' : `library-pass-b-touch-${width}-${mode}.png`);
  return detail;
}
function favoriteDocument(before, after, post, favorite) {
  const expected = structuredClone(before.browser), edited = expected.find(p => p.id === post.id);
  edited.favorite = favorite; edited.updatedAt = after.browser.find(p => p.id === post.id).updatedAt;
  assert.equal(typeof edited.updatedAt, 'string'); assert.ok(Number.isFinite(Date.parse(edited.updatedAt)));
  assert.deepEqual(after.browser, expected);
}
async function mobileTaps(name) {
  const before = await snapshot(name + '/before'), url = page.url(), count = page.context().pages().length;
  const post = programming, selected = card(post).getByRole('checkbox');
  await selected.tap(); assert.equal(await selected.isChecked(), true); assert.equal(page.url(), url);
  await selected.tap(); assert.equal(await selected.isChecked(), false);
  assert.deepEqual(await snapshot(name + '/selection'), before);
  const fav = card(post).getByRole('button'), pressed = !before.browser.find(p => p.id === post.id).favorite;
  await fav.tap(); await saved(); assert.equal(await fav.getAttribute('aria-pressed'), String(pressed));
  assert.equal(page.url(), url); assert.equal(page.context().pages().length, count);
  const changed = await snapshot(name + '/favorite'); favoriteDocument(before, changed, post, pressed);
  await title(post).tap();
  const detail = page.getByRole('dialog', { name: 'Saved post detail', exact: true }); await detail.waitFor();
  assert.equal(new URL(page.url()).pathname, '/library/item/' + post.id);
  assert.deepEqual(await snapshot(name + '/detail'), changed);
  await detail.getByRole('button', { name: 'Close', exact: true }).tap(); await detail.waitFor({ state: 'hidden' });
  assert.equal(page.url(), url); assert.equal(page.context().pages().length, count);
  assert.deepEqual(await snapshot(name + '/closed'), changed);
  return 'Real checkbox/favorite/title taps; exact full-document API/browser/SQLite comparisons';
}
async function closedNavigation(expectFocus = true) {
  assert.equal(await menu().isVisible(), true);
  assert.equal(await menu().getAttribute('aria-controls'), 'mobile-navigation');
  assert.equal(await menu().getAttribute('aria-haspopup'), 'dialog');
  assert.equal(await menu().getAttribute('aria-expanded'), 'false');
  assert.equal(await navigation().count(), 0, 'Closed navigation is absent from accessible dialogs');
  assert.equal(await page.getByRole('complementary', { name: 'Navigation', exact: true }).count(), 0);
  const hidden = page.locator('#mobile-navigation');
  assert.equal(await hidden.getByRole('link').count(), 0);
  assert.equal(await hidden.getByRole('button').count(), 0);
  assert.equal(await hidden.evaluateAll(els => els.every(el => !el.open && !el.matches(':modal') && el.getClientRects().length === 0)), true);
  if (expectFocus) assert.equal(await menu().evaluate(el => el === document.activeElement), true, 'Dismissal returns focus to Menu');
}
async function touchControl(target, name) {
  await target.scrollIntoViewIfNeeded();
  const detail = measured(name, await target.evaluate(el => {
    const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { rect: r.toJSON(), hit: hit?.outerHTML.slice(0, 600), unobscured: !!hit && el.contains(hit) };
  }));
  assert.ok(detail.rect.width >= 44 && detail.rect.height >= 44, name + ' has a 44px touch area');
  assert.equal(detail.unobscured, true, name + ' is reachable');
}
async function openNavigation() {
  await closedNavigation(false); await touchControl(menu(), 'Menu');
  await tabTo(menu()); await page.keyboard.press('Enter'); await navigation().waitFor(); await settled();
  assert.equal(await menu().getAttribute('aria-expanded'), 'true');
  const detail = measured('drawer/open', await navigation().evaluate(el => ({
    tag: el.tagName, id: el.id, label: el.getAttribute('aria-label'), open: el.open, modal: el.matches(':modal'),
    rect: el.getBoundingClientRect().toJSON(), height: innerHeight,
    focus: document.activeElement?.outerHTML.slice(0, 600),
  })));
  assert.equal(detail.tag, 'DIALOG'); assert.equal(detail.id, 'mobile-navigation'); assert.equal(detail.label, 'Mobile navigation');
  assert.equal(detail.open, true); assert.equal(detail.modal, true); assert.equal(detail.rect.width, 236);
  assert.equal(detail.rect.x, 0); assert.equal(detail.rect.y, 0); assert.equal(detail.rect.height, detail.height);
  const close = navigation().getByRole('button', { name: 'Close navigation', exact: true });
  assert.equal(await close.evaluate(el => el === document.activeElement), true, 'Close receives initial focus');
  await touchControl(close, 'Close navigation');
}
async function dismissNavigation(method) {
  if (method === 'close') {
    await tabTo(navigation().getByRole('button', { name: 'Close navigation', exact: true })); await page.keyboard.press('Enter');
  } else if (method === 'escape') await page.keyboard.press('Escape');
  else {
    const box = await navigation().boundingBox();
    await page.touchscreen.tap(box.x + box.width + (page.viewportSize().width - box.x - box.width) / 2, 400);
  }
  await navigation().waitFor({ state: 'hidden' }); await settled(); await closedNavigation();
}
async function mobileStatus(name) {
  await closedNavigation(false);
  const status = page.getByRole('status', { name: 'SQLite save status', exact: true });
  assert.equal(await page.locator('[role="status"][aria-label="SQLite save status"]').count(), 1);
  await status.scrollIntoViewIfNeeded();
  const detail = measured(name, await status.evaluate(el => {
    const r = el.getBoundingClientRect(), main = document.querySelector('main'), header = document.querySelector('header');
    const overlays = []; for (let node = el; node && node !== main && node !== document.body; node = node.parentElement) {
      if (['absolute', 'fixed', 'sticky'].includes(getComputedStyle(node).position)) overlays.push(node.outerHTML.slice(0, 300));
    }
    const center = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    const grid = document.querySelector('.cell-grid');
    return { rect: r.toJSON(), main: main.getBoundingClientRect().toJSON(), header: header.getBoundingClientRect().toJSON(), width: innerWidth,
      inMain: main.contains(el), overlays, hit: !!center && el.contains(center),
      gridTop: grid?.getBoundingClientRect().top, visible: getComputedStyle(el).visibility, text: el.textContent };
  }));
  assert.equal(detail.visible, 'visible'); assert.equal(detail.inMain, true); assert.deepEqual(detail.overlays, []);
  assert.equal(detail.hit, true); assert.equal(detail.main.x, 0); assert.equal(detail.main.width, detail.width);
  assert.equal(detail.header.x, 0); assert.equal(detail.header.width, detail.width);
  assert.ok(detail.rect.bottom <= detail.gridTop, 'Status is in flow above the grid, not over cards');
  assert.ok(detail.rect.x >= 0 && detail.rect.right <= detail.width);
  return detail;
}
async function drawerKeyboard(motion) {
  await freshLibrary({ ...touchViewport(390), reducedMotion: motion }); await theme('dark');
  const before = await snapshot('drawer-keyboard/' + motion + '/before'), url = page.url();
  await search().scrollIntoViewIfNeeded(); await search().focus();
  await tabTo(menu(), 'Shift+Tab'); await openNavigation();
  const focusSteps = [];
  const count = await navigation().locator('a[href], button, input, select, textarea, [tabindex="0"]').count();
  for (const direction of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < count + 3; i++) {
      await page.keyboard.press(direction);
      const focus = await page.evaluate(() => {
        const el = document.activeElement, dialog = document.querySelector('#mobile-navigation');
        return { body: el === document.body, inDialog: dialog.contains(el), element: el?.outerHTML.slice(0, 400) };
      });
      focusSteps.push({ direction, ...focus });
      assert.ok(focus.body || focus.inDialog, JSON.stringify(focus));
    }
  }
  measured('drawer/focus/' + motion, focusSteps);
  const background = measured('drawer/inert/' + motion, await search().evaluate(el => {
    const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    el.focus();
    return { focused: document.activeElement === el, backgroundHit: !!hit && el.contains(hit), hit: hit?.outerHTML.slice(0, 600) };
  }));
  assert.equal(background.focused, false); assert.equal(background.backgroundHit, false);
  const scroll = () => page.evaluate(() => [window.scrollX, window.scrollY, ...[...document.querySelectorAll('main, main *')].filter(el => el.scrollHeight > el.clientHeight).flatMap(el => [el.scrollLeft, el.scrollTop])]);
  const beforeScroll = await scroll();
  await page.mouse.move(380, 500); await page.mouse.wheel(0, 650);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await scroll(), beforeScroll, 'Modal prevents background scrolling');
  const motionStyle = measured('drawer/motion/' + motion, await navigation().evaluate(el => ({
    transition: getComputedStyle(el).transitionDuration, animation: getComputedStyle(el).animationDuration,
  })));
  for (const value of Object.values(motionStyle)) assert.ok(value.split(',').every(part => parseFloat(part) <= 0.01), 'Drawer introduces no sliding animation');
  await dismissNavigation('close');
  const closedSteps = await page.locator('a:visible, button:visible, input:visible, select:visible, textarea:visible').count();
  for (let i = 0; i < closedSteps + 3; i++) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('#mobile-navigation, aside[aria-label="Navigation"]')), false);
  }
  for (const method of ['escape', 'backdrop']) { await openNavigation(); await dismissNavigation(method); }
  assert.equal(page.url(), url); assert.equal(await card(programming).getByRole('checkbox').isChecked(), false);
  assert.deepEqual(await snapshot('drawer-keyboard/' + motion + '/after'), before);
  return { motion, focusSteps, beforeScroll, background };
}
async function drawerNavigation(width) {
  await freshLibrary(touchViewport(width)); await theme('dark');
  const before = await snapshot(`drawer-navigation/${width}/before`), pages = page.context().pages().length;
  await openNavigation(); if (width === 390) await snap('shell-drawer-open.png');
  const controls = navigation().locator('a[href]:visible, button:visible');
  for (let i = 0; i < await controls.count(); i++) await touchControl(controls.nth(i), `drawer/${width}/control-${i}`);
  assert.equal(await navigation().getByTitle('Collapse', { exact: true }).isVisible(), false);
  assert.equal(await navigation().getByTitle('Expand', { exact: true }).isVisible(), false);
  const toggle = navigation().getByTitle('Toggle theme', { exact: true });
  await tabTo(toggle); await page.keyboard.press('Enter'); await settled();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  assert.equal(await navigation().evaluate(el => el.open && el.matches(':modal')), true, 'Theme keeps navigation open');
  await dismissNavigation('escape');
  const destinations = [];
  async function select(name, target, expected, expectedPosts) {
    await openNavigation(); await target.tap(); await navigation().waitFor({ state: 'hidden' }); await settled();
    await page.waitForURL(base + expected); await closedNavigation();
    if (expectedPosts) assert.deepEqual((await cards().evaluateAll(els => els.map(el => el.dataset.postId))).sort(), expectedPosts.map(p => p.id).sort());
    assert.deepEqual(await snapshot(`drawer-navigation/${width}/${name}`), before);
    destinations.push({ name, url: page.url() });
  }
  const libraryLink = () => navigation().getByTitle('Saved Posts Library', { exact: true });
  await select('same-Library', libraryLink(), '/library', before.browser);
  await select('Catchup', navigation().getByTitle('Catch up on new links', { exact: true }), '/');
  assert.deepEqual((await page.locator('.catchup-card').evaluateAll(els => els.map(el => el.dataset.postId))).sort(), queue.map(p => p.id).sort());
  await select('Library', libraryLink(), '/library', before.browser);
  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('library-store-v1')).state);
  const category = state.categories.find(c => !c.archived && before.browser.some(p => p.categories.includes(c.name)));
  assert.ok(category, 'Existing populated category');
  await select('category', navigation().locator(`a[href="/library/category/${category.id}"]`), '/library/category/' + category.id, before.browser.filter(p => p.categories.includes(category.name)));
  await select('Later', navigation().getByTitle('Saved for later', { exact: true }), '/library?status=to-review', before.browser.filter(p => p.status === 'to-review'));
  await select('Settings', navigation().getByTitle('Settings', { exact: true }), '/library/settings');
  await select('Library-return', libraryLink(), '/library', before.browser);
  if (state.views.length) {
    for (const view of state.views) await select('saved-view-' + view.id, navigation().locator(`a[href="/library?view=${view.id}"]`), '/library?view=' + view.id);
    await select('after-saved-views', libraryLink(), '/library', before.browser);
  } else measured(`drawer-navigation/${width}/saved-views`, 'ABSENT: existing fixture has no saved views; no fixture or view added');
  for (const trigger of ['Search (Ctrl+K)', 'Control+k']) {
    await openNavigation();
    if (trigger === 'Control+k') await page.keyboard.press('Control+k');
    else { await tabTo(navigation().getByTitle('Search (Ctrl+K)', { exact: true })); await page.keyboard.press('Enter'); }
    const palette = page.getByRole('dialog', { name: 'Command palette', exact: true }); await palette.waitFor();
    await navigation().waitFor({ state: 'hidden' }); await closedNavigation(false);
    const input = palette.getByPlaceholder('Search posts, categories, commands…');
    await page.waitForLoadState('networkidle'); await settled();
    assert.equal(await input.evaluate(el => el === document.activeElement), true, 'Palette input retains handed-off focus');
    await page.keyboard.type('TypeScript'); assert.equal(await input.inputValue(), 'TypeScript');
    await page.keyboard.press('Escape'); await palette.waitFor({ state: 'hidden' });
    assert.deepEqual(await snapshot(`drawer-navigation/${width}/palette-${trigger}`), before);
  }
  assert.equal(page.context().pages().length, pages); assert.equal(page.url(), base + '/library');
  return destinations;
}
async function drawerResize(collapsed) {
  await freshLibrary(); await theme('dark');
  // Establish both states through the existing controls, never a storage write.
  await page.getByTitle('Collapse', { exact: true }).click(); await settled();
  if (!collapsed) { await page.getByTitle('Expand', { exact: true }).click(); await settled(); }
  const prefs = () => page.evaluate(() => JSON.parse(localStorage.getItem('prefs-store-v1')).state);
  const preference = await prefs(); assert.equal(preference.sidebarCollapsed, collapsed);
  const before = await snapshot(`drawer-resize/${collapsed}/before`), measurements = [];
  for (const width of [719, 720]) {
    await page.setViewportSize({ width, height: 844 }); await settled(); await closedNavigation(false);
    await openNavigation();
    if (stage === 'sidebar-repair') await snap(`sidebar-boundary-${width}-${collapsed}-drawer.png`);
    assert.equal(await navigation().getByText('Super Bookmark Manager', { exact: true }).isVisible(), true);
    assert.equal(await navigation().getByTitle('Saved Posts Library', { exact: true }).innerText().then(text => text.includes('Library')), true);
    assert.deepEqual(await prefs(), preference);
    await page.setViewportSize({ width: 721, height: 844 }); await settled();
    assert.equal(await menu().isVisible(), false); assert.equal(await navigation().count(), 0);
    assert.equal(await page.locator('dialog:modal').count(), 0);
    const focus = measured(`drawer-resize/${collapsed}/${width}/desktop`, await page.evaluate(() => {
      const el = document.activeElement, sidebar = document.querySelector('aside[aria-label="Navigation"]');
      const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { element: el.outerHTML.slice(0, 600), inSidebar: sidebar.contains(el), visible: r.width > 0 && r.height > 0 && !!hit && el.contains(hit), sidebarWidth: sidebar.getBoundingClientRect().width };
    }));
    assert.equal(focus.inSidebar, true); assert.equal(focus.visible, true); assert.equal(focus.sidebarWidth, collapsed ? 56 : 236);
    assert.deepEqual(await prefs(), preference);
    await page.getByTitle(collapsed ? 'Expand' : 'Collapse', { exact: true }).waitFor();
    if (stage === 'sidebar-repair') await snap(`sidebar-boundary-721-from-${width}-${collapsed}.png`);
    await page.setViewportSize({ width, height: 844 }); await settled(); await closedNavigation(false);
    await search().focus(); assert.equal(await search().evaluate(el => el === document.activeElement), true);
    assert.deepEqual(await prefs(), preference); measurements.push({ width, preference, focus });
  }
  assert.deepEqual(await snapshot(`drawer-resize/${collapsed}/after`), before);
  return measurements;
}
async function failedMobileFavorite() {
  await freshLibrary(touchViewport(390)); await theme('dark'); await mobileStatus('save-status/before');
  const before = await snapshot('failed-mobile-favorite/before');
  const sqliteBefore = (await control('snapshot')).result;
  const post = programming, pressed = !before.browser.find(p => p.id === post.id).favorite;
  const record = { name: 'failed-mobile-favorite', expectedAttempts: 1, attempts: [] }; report.controlledWrites.push(record);
  let failureEnabled = false;
  try {
    assert.equal((await control('fail-on')).ok, true); failureEnabled = true;
    controlledWrite = { page, record };
    await card(post).getByRole('button').tap();
    const status = page.getByRole('status', { name: 'SQLite save status', exact: true });
    const retry = status.getByRole('button', { name: 'Retry SQLite save', exact: true }); await retry.waitFor();
    await status.locator('p').waitFor(); assert.match(await status.innerText(), /pending SQLite save/);
    assert.ok((await status.locator('p').innerText()).trim(), 'Persistence error is visible');
    await page.waitForLoadState('networkidle'); await mobileStatus('save-status/failed');
    await retry.scrollIntoViewIfNeeded(); assert.equal(await retry.isEnabled(), true);
    // Do not call saved()/snapshot() while writes are intentionally failing.
    const sqliteFailed = (await control('snapshot')).result;
    const local = await page.evaluate(() => JSON.parse(localStorage.getItem('library-store-v1')).state);
    const api = await page.evaluate(async () => { const r = await fetch('/api/library'); if (!r.ok) throw new Error('Failure snapshot GET failed'); return r.json(); });
    measured('failed-mobile-favorite/pending', { sqlite: sqliteFailed, browser: sorted(local.posts), api: sorted(api.posts), pending: local.pending });
    assert.deepEqual(sqliteFailed, sqliteBefore); assert.deepEqual(sorted(api.posts), before.api);
    favoriteDocument(before, { browser: sorted(local.posts) }, post, pressed);
    assert.equal(Object.keys(local.pending).length, 1); assert.equal(Object.values(local.pending)[0].id, post.id);
    assert.equal(record.attempts.length, 1, 'Exactly one intentionally triggered failed write');
    assert.equal(report.responses.filter(r => record.attempts.includes(r.request) && r.status === 503 && r.url === base + '/api/library' && r.method === 'POST').length, 1);
    assert.equal(report.expected503.filter(e => e.group === record.name).length, 1);
    assert.equal((await control('fail-off')).ok, true); failureEnabled = false; controlledWrite = undefined;
    const retryStart = report.requests.length;
    await retry.tap(); await saved();
    assert.equal(report.requests.slice(retryStart).filter(r => r.url === base + '/api/library' && r.method === 'POST').length, 1, 'Real Retry sends the pending write');
    const after = await snapshot('failed-mobile-favorite/recovered'); favoriteDocument(before, after, post, pressed);
    assert.deepEqual(after.browser, sorted(local.posts), 'Retry preserves the exact pending timestamp/document');
    assert.equal(await retry.count(), 0); await mobileStatus('save-status/recovered');
    return record;
  } finally {
    try { if (failureEnabled) assert.equal((await control('fail-off')).ok, true); }
    finally { controlledWrite = undefined; }
  }
}
async function sidebarGeometry(name, collapsed = true) {
  const status = page.getByRole('status', { name: 'SQLite save status', exact: true });
  assert.equal(await page.locator('[role="status"][aria-label="SQLite save status"]').count(), 1);
  assert.equal(await status.count(), 1);
  const detail = measured(name, await page.getByRole('complementary', { name: 'Navigation', exact: true }).evaluate(sidebar => {
    const rect = el => el.getBoundingClientRect().toJSON();
    const status = sidebar.querySelector('[role="status"]');
    const footer = sidebar.querySelector('.sidebar-footer');
    const overlays = [];
    for (let node = status; node && node !== sidebar; node = node.parentElement) {
      if (['absolute', 'fixed', 'sticky'].includes(getComputedStyle(node).position)) overlays.push(node.outerHTML.slice(0, 300));
    }
    const controls = [...footer.querySelectorAll('a, button')].map(el => {
      const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      const s = getComputedStyle(el);
      return { title: el.title, rect: r.toJSON(), hit: !!hit && el.contains(hit), visibility: s.visibility, opacity: s.opacity };
    });
    const retry = status.querySelector('button');
    return { sidebar: rect(sidebar), footer: rect(footer), status: rect(status), controls, overlays,
      statusVisible: getComputedStyle(status).visibility, statusScrollWidth: status.scrollWidth, statusClientWidth: status.clientWidth,
      footerScrollWidth: footer.scrollWidth, footerClientWidth: footer.clientWidth,
      sidebarScrollWidth: sidebar.scrollWidth, sidebarClientWidth: sidebar.clientWidth,
      main: rect(document.querySelector('main')), header: rect(document.querySelector('header')),
      overflow: document.documentElement.scrollWidth > innerWidth, retry: retry ? rect(retry) : null };
  }));
  assert.equal(detail.sidebar.width, collapsed ? 56 : 236); assert.equal(detail.sidebar.x, 0);
  assert.equal(detail.main.x, detail.sidebar.right); assert.equal(detail.header.x, detail.sidebar.right);
  assert.equal(detail.overflow, false); assert.deepEqual(detail.overlays, []);
  assert.equal(detail.statusVisible, 'visible');
  assert.ok(detail.status.x >= detail.sidebar.x && detail.status.right <= detail.sidebar.right);
  assert.ok(detail.status.top >= 0 && detail.status.bottom <= detail.footer.top);
  assert.ok(detail.footer.x >= detail.sidebar.x && detail.footer.right <= detail.sidebar.right);
  assert.ok(detail.footer.bottom <= detail.sidebar.bottom && detail.footer.top >= 0);
  for (const part of ['status', 'footer', 'sidebar']) assert.ok(detail[part + 'ScrollWidth'] <= detail[part + 'ClientWidth'] + 1, part + ' fits without horizontal overflow');
  assert.deepEqual(detail.controls.map(c => c.title), ['Settings', 'Toggle theme', collapsed ? 'Expand' : 'Collapse']);
  for (const control of detail.controls) {
    assert.equal(control.hit, true, control.title + ' receives pointer hits');
    assert.equal(control.visibility, 'visible'); assert.equal(control.opacity, '1');
    assert.ok(control.rect.width >= 24 && control.rect.height >= 24);
    assert.ok(control.rect.x >= detail.footer.x && control.rect.right <= detail.footer.right);
    assert.ok(control.rect.top >= detail.footer.top && control.rect.bottom <= detail.footer.bottom);
  }
  if (collapsed) for (let i = 1; i < detail.controls.length; i++) {
    assert.ok(detail.controls[i - 1].rect.bottom <= detail.controls[i].rect.top, 'Collapsed controls occupy distinct vertical rows');
  }
  if (detail.retry) assert.ok(detail.retry.x >= detail.status.x && detail.retry.right <= detail.status.right && detail.retry.top >= detail.status.top && detail.retry.bottom <= detail.status.bottom);
  detail.accessibility = await status.ariaSnapshot();
  return detail;
}
async function visibleKeyboardFocus(target, name) {
  const detail = measured(name, await target.evaluate(el => {
    const s = getComputedStyle(el);
    return { focused: el === document.activeElement, focusVisible: el.matches(':focus-visible'), outlineWidth: s.outlineWidth, outlineStyle: s.outlineStyle, outlineColor: s.outlineColor };
  }));
  assert.equal(detail.focused, true); assert.equal(detail.focusVisible, true);
  assert.ok(parseFloat(detail.outlineWidth) >= 1); assert.notEqual(detail.outlineStyle, 'none');
  assert.ok(!['transparent', 'rgba(0, 0, 0, 0)'].includes(detail.outlineColor));
  return detail;
}
async function sidebarDesktop(width, mode) {
  await freshLibrary({ viewport: { width, height: 900 } }); await theme(mode);
  const prefix = `sidebar/${width}/${mode}`, before = await snapshot(prefix + '/before');
  assert.equal(await menu().isVisible(), false);
  const collapse = () => page.getByTitle('Collapse', { exact: true }), expand = () => page.getByTitle('Expand', { exact: true });
  await collapse().click(); await settled();
  const detail = await sidebarGeometry(prefix + '/saved'); assert.match(detail.accessibility, /Library saved to SQLite/);
  await snap(`sidebar-${width}-${mode}-collapsed-saved.png`);
  // Pointer round trip exercises the original interception without force.
  await expand().click(); await settled(); await sidebarGeometry(prefix + '/pointer-expanded', false);
  await snap(`sidebar-${width}-${mode}-expanded.png`);
  await collapse().click(); await settled();
  for (const key of ['Enter', 'Space']) {
    await search().focus(); await tabTo(expand(), 'Shift+Tab');
    await visibleKeyboardFocus(expand(), prefix + '/focus-' + key);
    if (key === 'Enter') await snap(`sidebar-${width}-${mode}-keyboard.png`);
    await page.keyboard.press(key); await settled(); await sidebarGeometry(prefix + '/' + key + '-expanded', false);
    await tabTo(collapse()); await visibleKeyboardFocus(collapse(), prefix + '/collapse-focus-' + key);
    await page.keyboard.press(key); await settled(); await sidebarGeometry(prefix + '/' + key + '-collapsed');
  }
  await page.reload(); await saved(); await settled();
  await sidebarGeometry(prefix + '/reloaded');
  assert.deepEqual(await snapshot(prefix + '/after'), before);
  return { width, mode, pointer: true, keyboard: ['Enter', 'Space'], reloadedCollapsed: true };
}
async function failedSidebarFavorite(width, mode) {
  await freshLibrary({ viewport: { width, height: 900 } }); await theme(mode);
  await page.getByTitle('Collapse', { exact: true }).click(); await settled();
  const name = `sidebar-write/${width}/${mode}`, before = await snapshot(name + '/before');
  const sqliteBefore = (await control('snapshot')).result, pressed = !before.browser.find(p => p.id === programming.id).favorite;
  const record = { name, expectedAttempts: 1, attempts: [] }; report.controlledWrites.push(record);
  let failureEnabled = false, release;
  const held = new Promise(resolve => { release = resolve; });
  const routeHandler = async route => { if (route.request().method() === 'POST') await held; await route.continue(); };
  await page.route(base + '/api/library', routeHandler);
  try {
    assert.equal((await control('fail-on')).ok, true); failureEnabled = true; controlledWrite = { page, record };
    const request = page.waitForRequest(r => r.url() === base + '/api/library' && r.method() === 'POST');
    await card(programming).getByRole('button').click(); await request;
    const status = page.getByRole('status', { name: 'SQLite save status', exact: true });
    const saving = status.getByRole('button', { name: 'Saving…', exact: true }); await saving.waitFor();
    assert.equal(await saving.isDisabled(), true);
    const pendingState = await sidebarGeometry(name + '/pending'); assert.match(pendingState.accessibility, /1 change pending SQLite save/);
    await snap(`sidebar-${width}-${mode}-collapsed-pending.png`);
    release();
    const retry = status.getByRole('button', { name: 'Retry SQLite save', exact: true }); await retry.waitFor();
    await page.waitForLoadState('networkidle');
    const failedState = await sidebarGeometry(name + '/error');
    assert.match(failedState.accessibility, /1 change pending SQLite save/);
    assert.match(failedState.accessibility, /SQLite library unavailable\. Changes were not saved; retry when storage is available\./);
    assert.equal(await retry.isEnabled(), true);
    await snap(`sidebar-${width}-${mode}-collapsed-error.png`);
    const sqliteFailed = (await control('snapshot')).result;
    const local = await page.evaluate(() => JSON.parse(localStorage.getItem('library-store-v1')).state);
    const api = await page.evaluate(async () => (await (await fetch('/api/library')).json()));
    measured(name + '/retained', { sqlite: sqliteFailed, browser: sorted(local.posts), api: sorted(api.posts), pending: local.pending });
    assert.deepEqual(sqliteFailed, sqliteBefore); assert.deepEqual(sorted(api.posts), before.api);
    favoriteDocument(before, { browser: sorted(local.posts) }, programming, pressed);
    assert.equal(Object.keys(local.pending).length, 1); assert.equal(Object.values(local.pending)[0].id, programming.id);
    assert.equal(record.attempts.length, 1);
    // The error itself cannot obstruct Expand, and expansion cannot consume Retry.
    await page.getByTitle('Expand', { exact: true }).click(); await settled(); await sidebarGeometry(name + '/error-expanded', false);
    await page.getByTitle('Collapse', { exact: true }).click(); await settled(); await sidebarGeometry(name + '/error-recollapsed');
    if (width !== 1365) { await search().focus(); await tabTo(retry, 'Shift+Tab'); await visibleKeyboardFocus(retry, name + '/retry-focus'); }
    assert.equal((await control('fail-off')).ok, true); failureEnabled = false; controlledWrite = undefined;
    const retryStart = report.requests.length;
    if (width === 1365) await retry.click(); else await page.keyboard.press(width === 1024 ? 'Enter' : 'Space');
    await saved();
    assert.equal(report.requests.slice(retryStart).filter(r => r.url === base + '/api/library' && r.method === 'POST').length, 1, 'Real Retry sends exactly one pending write');
    const after = await snapshot(name + '/recovered'); favoriteDocument(before, after, programming, pressed);
    assert.deepEqual(after.browser, sorted(local.posts), 'Retry preserves the exact pending document and timestamp');
    assert.equal(await retry.count(), 0); await sidebarGeometry(name + '/recovered');
    return record;
  } finally {
    release();
    await page.unroute(base + '/api/library', routeHandler);
    try { if (failureEnabled) assert.equal((await control('fail-off')).ok, true); }
    finally { controlledWrite = undefined; }
  }
}
async function sidebarMobileSanity(width, mode) {
  await freshLibrary(touchViewport(width)); await theme(mode);
  const name = `sidebar-mobile/${width}/${mode}`, before = await snapshot(name + '/before');
  await mobileStatus(name + '/status'); await openNavigation();
  assert.equal(await navigation().locator('[role="status"]').count(), 0, 'Mobile drawer must not duplicate the status');
  assert.equal(await page.locator('[role="status"][aria-label="SQLite save status"]').count(), 1);
  await visibleKeyboardFocus(navigation().getByRole('button', { name: 'Close navigation', exact: true }), name + '/close-focus');
  const count = await navigation().locator('a[href], button').count();
  for (let i = 0; i < count + 2; i++) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement === document.body || !!document.activeElement?.closest('#mobile-navigation')), true);
  }
  await snap(`sidebar-mobile-${width}-${mode}-drawer.png`);
  await dismissNavigation('close');
  for (const method of ['escape', 'backdrop']) { await openNavigation(); await dismissNavigation(method); }
  await mobileStatus(name + '/after-status');
  assert.deepEqual(await snapshot(name + '/after'), before);
  return { width, mode, dismissals: ['close', 'escape', 'backdrop'], exactRecords: 8 };
}
async function sidebarContentSanity() {
  await freshLibrary(); await theme('dark');
  const before = await snapshot('sidebar-content/before');
  assert.equal(await cards().count(), 8);
  await search().fill('TypeScript notes'); await page.waitForFunction(() => document.querySelectorAll('main article').length === 1);
  assert.equal(await card(programming).count(), 1);
  await search().fill(''); await page.waitForFunction(() => document.querySelectorAll('main article').length === 8);
  await page.getByTitle('Catch up on new links', { exact: true }).click(); await page.waitForURL(base + '/'); await settled();
  assert.deepEqual((await page.locator('.catchup-card').evaluateAll(els => els.map(el => el.dataset.postId))).sort(), queue.map(p => p.id).sort());
  const target = page.locator(`.catchup-card[data-post-id="${queue[0].id}"]`);
  await tabTo(target.locator('[data-expand]')); await page.keyboard.press('Enter'); await settled();
  assert.equal(await target.locator('[data-expand]').getAttribute('aria-expanded'), 'true');
  assert.equal(await target.locator('.catchup-title').getAttribute('href'), queue[0].url);
  await page.getByTitle('Saved Posts Library', { exact: true }).click(); await page.waitForURL(base + '/library'); await settled();
  assert.equal(await cards().count(), 8); assert.deepEqual(await snapshot('sidebar-content/after'), before);
  return 'Library search, Catch Up expand/original URL, Library return, exact eight-record preservation';
}
async function curationAtRest(mode) {
  await library(); await search().focus(); await page.mouse.move(0, 0);
  const cooking = byPath('/cooking');
  for (const p of seed) {
    assert.equal(await card(p).getByRole('button').getAttribute('aria-pressed'), String(!!p.favorite));
    for (const text of [...p.categories, ...p.tags.map(t => '#' + t)]) assert.ok((await card(p).locator('.cell-caption').innerText()).includes(text));
  }
  assert.ok((await card(cooking).locator('.cell-caption').innerText()).includes('Archived'));
  assert.ok((await card(programming).locator('.cell-caption').innerText()).includes('Reference'));
  assert.equal((await snapshot(mode + '-curation')).browser.find(p => p.id === cooking.id).categoryMode, 'manual');
  return 'favorite pressed state, statuses, categories, tags and intentional manual other retained';
}
async function favorites(mode) {
  for (const view of ['grid', 'list']) {
    await page.getByRole('radio', { name: view, exact: true }).click(); await settled();
    const row = post => page.locator(view === 'grid' ? 'main article' : 'main .row').filter({ has: page.locator(`a[href="/library/item/${post.id}"]`) });
    const before = await snapshot(`${mode}-${view}-before`), url = page.url(), pages = page.context().pages().length;
    assert.ok(before.browser.some(p => !Object.hasOwn(p, 'favorite')));
    for (const p of before.browser) {
      const button = row(p).getByRole('button');
      assert.equal(await button.getAttribute('aria-pressed'), String(!!p.favorite));
      assert.equal(await button.getAttribute('aria-label'), p.favorite ? 'Unfavorite' : 'Favorite');
    }
    assert.deepEqual(await snapshot(`${mode}-${view}-read-only`), before);
    const post = byPath('/exercise'), button = row(post).getByRole('button');
    await page.mouse.move(0, 0); await search().focus(); await tabTo(button); await settled();
    assert.equal(await button.evaluate(el => el.matches(':focus-visible') && getComputedStyle(el).opacity === '1'), true);
    let previous = before;
    for (const [pressed, keyboard] of [[true, true], [false, false]]) {
      if (keyboard) await page.keyboard.press('Space'); else await button.click();
      await saved(); await settled();
      assert.equal(await button.getAttribute('aria-pressed'), String(pressed));
      assert.equal(await button.getAttribute('aria-label'), pressed ? 'Unfavorite' : 'Favorite');
      assert.equal(page.url(), url); assert.equal(page.context().pages().length, pages);
      assert.equal(await page.getByRole('dialog').count(), 0);
      const current = await snapshot(`${mode}-${view}-${pressed}`), expected = structuredClone(previous.browser);
      const edited = expected.find(p => p.id === post.id);
      edited.favorite = pressed; edited.updatedAt = current.browser.find(p => p.id === post.id).updatedAt;
      assert.deepEqual(current.browser, expected); previous = current;
    }
    await page.reload(); await saved(); await settled();
    assert.equal(await button.getAttribute('aria-pressed'), 'false');
    assert.deepEqual(await snapshot(`${mode}-${view}-reload`), previous);
    await button.focus(); await settled(); await snap(`favorite-${mode}-${view}.png`);
  }
  await page.getByRole('radio', { name: 'table', exact: true }).click(); await settled();
  const tableBefore = await snapshot(`${mode}-table-before`);
  for (const p of tableBefore.browser) {
    const row = page.locator('main tbody tr').filter({ has: page.locator(`a[href="/library/item/${p.id}"]`) });
    assert.equal(await row.getByRole('button').count(), 0);
    assert.equal(await row.locator('svg.lucide-star').count(), p.favorite ? 1 : 0);
  }
  assert.deepEqual(await snapshot(`${mode}-table-after`), tableBefore);
  await page.getByRole('radio', { name: 'grid', exact: true }).click(); await settled();
  return 'Unset/true/false states, grid/list Tab+Space and pointer toggles, reload, exact document changes, table stars and no navigation';
}
async function catchupAppearance() {
  assert.ok(process.env.PASSB_BASELINE, 'PASSB_BASELINE must reference the fresh source baseline runtime.json');
  const baseline = JSON.parse(await readFile(process.env.PASSB_BASELINE, 'utf8'));
  await page.goto(base + '/'); await saved();
  const details = [];
  for (const mode of ['dark', 'light']) {
    await theme(mode);
    for (const [state, post] of [['populated', queue[0]], ['preview', travel], ['missing', byPath('/no-metadata')], ['broken', byPath('/budgeting')]]) {
      const target = page.locator(`.catchup-card[data-post-id="${post.id}"]`);
      await target.locator('[data-expand]').focus(); await settled(); await page.waitForLoadState('networkidle');
      const actual = await target.evaluate(el => {
        const style = selector => getComputedStyle(el.querySelector(selector)); const r = el.getBoundingClientRect();
        return { width: r.width, height: r.height, radius: getComputedStyle(el).borderRadius, title: style('.catchup-title').color, origin: style('.catchup-origin').color, date: style('.catchup-date').color, summary: el.querySelector('.catchup-summary') ? style('.catchup-summary').color : null, transition: style('.catchup-content').transition, shade: style('.catchup-shade').backgroundImage, focus: style('[data-expand]').outlineStyle, ids: [...document.querySelectorAll('.catchup-card')].map(c => c.dataset.postId), overflow: document.documentElement.scrollWidth > innerWidth, obscured: [...el.querySelectorAll('a, button, select')].filter(c => { const b = c.getBoundingClientRect(); const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return !hit || !c.contains(hit); }).map(c => c.textContent) };
      });
      assert.deepEqual(actual, baseline.results.find(r => r.name === `${mode}/${state}`).detail);
      await snap(`catchup-built-${mode}-${state}.png`); details.push({ mode, state, actual });
    }
  }
  return details;
}
async function triage(motion) {
  await page.emulateMedia({ reducedMotion: motion }); await page.goto(base + '/'); await saved();
  const before = await snapshot('before-catchup-' + motion), transitions = [];
  await page.mouse.move(0, 0);
  for (const [index, action] of ['reference', 'archived', 'to-review'].entries()) {
    const post = queue[index], target = page.locator(`.catchup-card[data-post-id="${post.id}"]`);
    await target.locator('[data-expand]').focus(); await settled();
    await tabTo(target.locator(`[data-triage="${action}"]`)); await page.keyboard.press('Enter');
    await target.waitFor({ state: 'detached' }); await settled(); await saved();
    const focus = await page.evaluate(() => ({ id: document.activeElement?.closest('[data-post-id]')?.dataset.postId, action: document.activeElement?.getAttribute('data-triage'), inert: !!document.activeElement?.closest('[inert]') }));
    assert.deepEqual(focus, { id: queue[index + 1].id, action, inert: false });
    const changed = await snapshot(`${motion}-${action}`);
    assert.equal(changed.browser.find(p => p.id === post.id).status, action);
    await page.locator('main').getByRole('button', { name: 'Undo', exact: true }).click(); await target.waitFor(); await settled(); await saved();
    assert.equal(await target.count(), 1);
    assert.equal(await target.locator('[data-expand]').evaluate(el => el === document.activeElement), true);
    assert.equal((await snapshot(`${motion}-${action}-undo`)).browser.find(p => p.id === post.id).status, 'inbox');
    transitions.push({ id: post.id, action, focus, undo: true });
  }
  const after = await snapshot('after-catchup-' + motion);
  const withoutTimestamp = posts => posts.map(({ updatedAt, ...p }) => p);
  assert.deepEqual(withoutTimestamp(after.browser), withoutTimestamp(before.browser));
  return transitions;
}
try {
  child = spawn(process.env.C6_PYTHON, ['-B', join(root, 'frontend/tests/library_fixture.py'), join(output, 'fixture.sqlite'), '0'], { cwd: root, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', TELEGRAM_API_ID: '0', TELEGRAM_API_HASH: '', LLM_API_KEY: 'fixture', LITELLM_PROXY_KEY: 'fixture' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  exit = once(child, 'exit');
  child.stderr.on('data', bytes => { void appendFile(join(output, 'server.txt'), bytes); });
  const ready = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => reject(new Error('Fixture exited before ready: ' + code)));
    createInterface({ input: child.stdout }).on('line', line => {
      const data = JSON.parse(line); report.events.push(data);
      if (data.ready) resolve(data);
      if (data.command) { pending.get(data.command)?.(data); pending.delete(data.command); }
    });
  });
  base = `http://127.0.0.1:${ready.port}`;
  if (stage === 'red' || stage === 'favorites-source' || stage === 'shell-source' || stage === 'b3-diagnose') {
    const { createServer } = await import(pathToFileURL(join(root, 'frontend/node_modules/vite/dist/node/index.js')));
    vite = await createServer({ root: join(root, 'frontend'), envFile: false, cacheDir: join(output, 'vite-cache'), server: { host: '127.0.0.1', port: 0, open: false, hmr: false, proxy: { '/api': { target: base, changeOrigin: false } } } });
    await vite.listen(); base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  }
  report.origin = base;
  report.distIndexHash = createHash('sha256').update(await readFile(join(root, 'frontend/dist/index.html'))).digest('hex');
  browser = await chromium.launch({ headless: true, channel: 'msedge' }); page = await newPage();
  await page.goto(base + '/library');
  await page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /^Library saved to SQLite$/ }).waitFor();
  await page.evaluate(async posts => {
    const response = await fetch('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts, deletedUrls: [] }) });
    if (!response.ok) throw new Error('Fixture seed failed: ' + await response.text());
  }, seed);
  await library(); assert.deepEqual((await snapshot('initial')).browser, sorted(seed));
  if (matrix) {
    report.captureSettings = { cap: 32, channel: 'msedge', headless: true, historicalDpr: 1,
      dprVariant: 'Not repeated: historical and current default DPR are both 1',
      variants: ['page-disabled', 'locator', 'page-ordinary', 'locator-explicit-scroll', 'page-two-frames', 'page-pointer-release', 'page-desktop-no-touch'],
      note: 'Diagnostic captures only; clean captures do not establish the historical cause.' };
    for (const width of [390, 320]) for (const mode of ['dark', 'light']) {
      await check('b3-matrix', `${width} ${mode} finite page/card matrix`, async () => {
        matrixCase = { width, mode, isMobile: true, hasTouch: true, deviceScaleFactor: 1 };
        await freshLibrary({ ...touchViewport(width), deviceScaleFactor: 1 });
        const before = await snapshot(`matrix/${width}/${mode}/before`);
        await check27(width, mode);
        assert.equal((await b3Metadata()).dpr, 1);
        await matrixSnap(width === 390 && mode === 'dark' ? 'b3-affected-card-locator.png' : `b3-${width}-${mode}-locator.png`, 'locator');
        await matrixSnap(`b3-${width}-${mode}-ordinary.png`);
        await card(programming).scrollIntoViewIfNeeded();
        await matrixSnap(`b3-${width}-${mode}-locator-scrolled.png`, 'locator');
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await matrixSnap(`b3-${width}-${mode}-two-frames.png`);
        await page.mouse.up(); await page.mouse.move(0, 0); await search().focus();
        await card(programming).scrollIntoViewIfNeeded();
        assert.equal(await card(programming).evaluate(el => el.matches(':active') || !!el.querySelector(':active')), false);
        await matrixSnap(`b3-${width}-${mode}-pointer-release.png`);
        assert.deepEqual(await snapshot(`matrix/${width}/${mode}/after-touch`), before);
        await mobileStatus(`matrix/${width}/${mode}/status`);
        await openNavigation(); await dismissNavigation('escape');
        matrixCase = { width, mode, isMobile: false, hasTouch: false, deviceScaleFactor: 1 };
        await freshLibrary({ viewport: { width, height: 844 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
        await theme(mode); await search().focus();
        // Match the historical focus/scroll traversal without imposing touch-only panel assertions.
        for (const post of seed) {
          await card(post).scrollIntoViewIfNeeded();
          for (const target of [card(post).getByRole('checkbox'), card(post).getByRole('button'), title(post)]) { await target.focus(); await settled(); }
        }
        await card(programming).scrollIntoViewIfNeeded(); await search().focus(); await card(programming).scrollIntoViewIfNeeded();
        await matrixSnap(`b3-${width}-${mode}-desktop.png`);
        assert.deepEqual(await snapshot(`matrix/${width}/${mode}/after-desktop`), before);
        return { width, mode, captures: 7, exactEightRecords: true, mobileGeometryAndHitTargets: 'PASS', drawerEscapeAndStatus: 'PASS' };
      });
    }
    await check('b3-drawer', 'mobile Menu Close focus trap and dismissals', async () => {
      const detail = await drawerKeyboard('no-preference');
      matrixCase = { width: 390, mode: 'dark', isMobile: true, hasTouch: true, deviceScaleFactor: 1 };
      await openNavigation(); await matrixSnap('b3-mobile-drawer.png'); await dismissNavigation('close');
      return detail;
    });
    await check('b3-reduced', 'reduced-motion Library and drawer keyboard sanity', async () => {
      const detail = await drawerKeyboard('reduce');
      await focusCheck();
      const state = await panelState(programming);
      assert.equal(state.position, 'static');
      const durations = await card(programming).evaluate(el => [el, ...el.querySelectorAll('*')].map(node => {
        const s = getComputedStyle(node); return { transition: s.transitionDuration, animation: s.animationDuration };
      }));
      assert.ok(durations.every(s => Object.values(s).every(value => value.split(',').every(part => parseFloat(part) <= 0.01))));
      return { ...detail, state, durations };
    });
    await check('b3-content', 'Library search and frozen Catch Up navigation sanity', sidebarContentSanity);
    await check('b3-preservation', 'complete eight-record fixture unchanged', async () => {
      assert.deepEqual((await snapshot('matrix/final')).browser, sorted(seed));
      return 'Eight exact documents including manual categories, tags, notes, favorite and status retained in browser/API/SQLite';
    });
  } else if (b3) {
    for (const capture of b3Cases) {
      b3Capture = capture;
      await check(27, `${stage}/${capture.name} original touch sequence`, async () => {
        await freshLibrary(touchViewport(capture.width));
        const prefix = `${stage}/${capture.name}`, before = await snapshot(prefix + '/before');
        let detail;
        try { detail = await check27(capture.width, capture.mode); }
        finally { assert.deepEqual(await snapshot(prefix + '/after'), before, prefix + ' full-state preservation'); }
        return { ...detail, snapshotsEqual: true };
      });
    }
    b3Capture = undefined;
  } else if (stage === 'red') {
    await check(13, 'keyboard-equivalent reveal', focusCheck);
  } else if (stage === 'favorites' || stage === 'favorites-source') {
    for (const mode of ['dark', 'light']) {
      await theme(mode);
      await check(18, mode + ' favorite and curation at rest', () => curationAtRest(mode));
      await check('favorites', mode + ' explicit favorite states and interactions', () => favorites(mode));
    }
  } else if (stage === 'sidebar-repair') {
    // This owner-authorized sidebar slice intentionally excludes check 27 and
    // all mobile card screenshots/blank-band investigation.
    if (!selectedCheck) for (const width of [1365, 1024, 768]) {
      for (const mode of ['dark', 'light']) await check('sidebar-desktop', `${width} ${mode} saved rail and pointer/keyboard round trips`, () => sidebarDesktop(width, mode));
    }
    for (const width of [1365, 1024, 768]) {
      for (const mode of ['dark', 'light']) await check('sidebar-write', `${width} ${mode} pending error and explicit Retry`, () => failedSidebarFavorite(width, mode));
    }
    if (!selectedCheck) {
      for (const collapsed of [false, true]) await check('sidebar-resize', '719/720/721 preference collapsed=' + collapsed, () => drawerResize(collapsed));
      for (const width of [390, 320]) {
        for (const mode of ['dark', 'light']) await check('sidebar-mobile', `${width} ${mode} Menu Close focus dismissals and status`, () => sidebarMobileSanity(width, mode));
      }
      await check('sidebar-content', 'Library and frozen Catch Up lightweight sanity', sidebarContentSanity);
    }
  } else if (stage === 'shell-source' || stage === 'shell') {
    for (const width of [390, 320]) {
      for (const mode of ['dark', 'light']) {
        await check(27, `shell ${width}x844 ${mode} full original touch checks`, async () => {
          await freshLibrary(touchViewport(width));
          const before = await snapshot(`shell/${width}/${mode}/before-layout`);
          const detail = await check27(width, mode);
          assert.deepEqual(await snapshot(`shell/${width}/${mode}/after-layout`), before);
          return detail;
        });
        if (stage === 'shell') await check('shell-touch', `${width} ${mode} real taps and mobile status`, async () => {
          await freshLibrary(touchViewport(width)); await theme(mode);
          await mobileStatus(`shell/${width}/${mode}/status`);
          return mobileTaps(`shell/${width}/${mode}`);
        });
      }
    }
    if (stage === 'shell-source') {
      // Source red is deliberately short: retain all four obstruction results,
      // then one immediate missing-Menu assertion, never the expanded scenarios.
      await check('shell-menu', 'source mobile Menu exists', async () => {
        assert.equal(await menu().isVisible(), true, 'Mobile Topbar must expose button Menu');
      });
    } else {
      for (const motion of ['no-preference', 'reduce']) await check('shell-keyboard', 'native drawer keyboard ' + motion, () => drawerKeyboard(motion));
      for (const width of [390, 320]) await check('shell-drawer', `drawer routes, theme and palette at ${width}`, () => drawerNavigation(width));
      for (const collapsed of [false, true]) await check('shell-resize', '719/720/721 preference collapsed=' + collapsed, () => drawerResize(collapsed));
      await check('shell-write', 'failed mobile favorite and explicit Retry', failedMobileFavorite);
      for (const [width, columns] of [[1365, 4], [1024, 3], [768, 2]]) {
        for (const mode of ['dark', 'light']) await check('shell-desktop', `${width} ${mode} geometry and hit targets`, async () => {
          await freshLibrary({ viewport: { width, height: 900 } }); await theme(mode);
          const before = await snapshot(`shell-desktop/${width}/${mode}/before`);
          const detail = measured(`shell-desktop/${width}/${mode}`, await geometry());
          assert.equal(detail.columns, columns); assert.equal(detail.overflow, false); assert.equal(detail.cards.length, 8);
          if (width === 1365) assert.ok(detail.cards.every(c => c.height < 400));
          await hitTargets();
          if (width === 768) { const state = await panelState(programming); assert.equal(state.position, 'static'); assert.equal(state.opacity, '1'); }
          assert.deepEqual(await snapshot(`shell-desktop/${width}/${mode}/after`), before);
          await search().focus(); await page.mouse.move(0, 0); await search().scrollIntoViewIfNeeded(); await settled();
          await snap(`shell-library-${width}-${mode}.png`); return detail;
        });
      }
      await check(28, 'shell Catch Up desktop appearance only', async () => {
        await freshLibrary();
        const before = await snapshot('shell-catchup/before');
        const detail = await catchupAppearance();
        assert.deepEqual(await snapshot('shell-catchup/after'), before); return detail;
      });
    }
  } else {
    for (const mode of ['dark', 'light']) {
      await theme(mode);
      await check(12, mode + ' hover information and stable bounds', async () => {
        await library(); await search().focus(); await page.mouse.move(0, 0); await settled();
        const before = await snapshot(mode + '-before-hover');
        const url = page.url(), count = page.context().pages().length;
        const bounds = await card(travel).boundingBox(); await card(travel).hover(); await settled();
        const state = await panelState(travel); assert.equal(state.opacity, '1'); assert.equal(state.visibility, 'visible'); assert.ok(state.text.includes(travel.excerpt));
        const after = await card(travel).boundingBox(); assert.deepEqual(after, bounds, 'Hover must not move or resize the card');
        for (const p of [programming, byPath('/reference'), byPath('/no-metadata')]) assert.equal((await panelState(p)).opacity, '0');
        assert.deepEqual(await snapshot(mode + '-after-hover'), before); assert.equal(page.url(), url); assert.equal(page.context().pages().length, count);
        if (mode === 'dark') await snap('library-pass-b-hover.png');
        return state;
      });
      await check(13, mode + ' keyboard-equivalent reveal', async () => {
        const before = await snapshot(mode + '-before-focus'), url = page.url(), count = page.context().pages().length;
        const result = await focusCheck();
        assert.ok(result.text.includes(programming.userNotes));
        assert.deepEqual(await snapshot(mode + '-after-focus'), before); assert.equal(page.url(), url); assert.equal(page.context().pages().length, count);
        if (mode === 'dark') await snap('library-pass-b-keyboard.png');
        return result;
      });
      await check(14, mode + ' hover/focus exact non-mutation', async () => {
        const values = report.snapshots.filter(s => s.name.startsWith(mode + '-'));
        assert.equal(values.length, 4); for (const v of values) assert.deepEqual(v.value, values[0].value);
        assert.equal(page.locator('[role="dialog"]').count && await page.locator('[role="dialog"]').count(), 0);
        return 'API/browser/SQLite before and after snapshots, URL and popup count unchanged';
      });
      await check(18, mode + ' favorite and curation at rest', () => curationAtRest(mode));
      await check(19, mode + ' broken thumbnail fallback', async () => {
        const broken = card(byPath('/budgeting')); await broken.scrollIntoViewIfNeeded();
        await broken.getByLabel('No content preview available').waitFor(); assert.equal(await broken.locator('img').count(), 0);
        if (mode === 'dark') await snap('library-pass-b-broken-image.png');
      });
      await check(20, mode + ' missing tiny and valid previews', async () => {
        for (const path of ['/exercise', '/cooking', '/no-metadata']) {
          const target = card(byPath(path)); await target.scrollIntoViewIfNeeded(); await target.getByLabel('No content preview available').waitFor(); assert.equal(await target.locator('img').count(), 0);
        }
        await card(travel).scrollIntoViewIfNeeded();
        await card(travel).locator('img.is-loaded').waitFor(); assert.equal(await card(travel).locator('img').count(), 1);
        assert.equal(await card(travel).locator('img').evaluate(el => el.naturalWidth), 640);
      });
      await check(24, mode + ' desktop layout and hit targets', async () => {
        await page.setViewportSize({ width: 1365, height: 900 }); await library();
        const detail = await geometry(); report.results.push({ number: 24, name: mode + ' measured geometry', status: 'MEASURED', detail });
        assert.equal(detail.columns, 4); assert.equal(detail.overflow, false); assert.equal(detail.cards.length, 8);
        assert.ok(detail.cards.every(c => c.height < 400));
        await hitTargets(); await search().focus(); await page.mouse.move(0, 0); await search().scrollIntoViewIfNeeded(); await settled();
        await snap(mode === 'dark' ? 'library-pass-b-1365x900.png' : 'library-pass-b-1365x900-light.png');
        return detail;
      });
    }
    await check(21, 'all eight cards native keyboard operations', async () => {
      await library(); await page.mouse.move(0, 0); await search().focus();
      for (const p of seed) {
        const before = await snapshot('before-keyboard-' + p.id), url = page.url();
        const select = card(p).getByRole('checkbox'); await tabTo(select); await page.keyboard.press('Space'); assert.equal(await select.isChecked(), true); assert.equal(page.url(), url);
        await page.keyboard.press('Space'); assert.equal(await select.isChecked(), false);
        assert.deepEqual(await snapshot('after-select-' + p.id), before);
        const fav = card(p).getByRole('button'); await tabTo(fav); await page.keyboard.press('Space'); await saved();
        assert.equal(await fav.getAttribute('aria-pressed'), String(!p.favorite)); assert.equal(page.url(), url);
        let changed = await snapshot('after-favorite-' + p.id);
        const expected = structuredClone(before.browser); const edited = expected.find(x => x.id === p.id); edited.favorite = !p.favorite; edited.updatedAt = changed.browser.find(x => x.id === p.id).updatedAt;
        assert.deepEqual(changed.browser, expected);
        await page.keyboard.press('Space'); await saved(); assert.equal(await fav.getAttribute('aria-pressed'), String(!!p.favorite));
        await tabTo(title(p)); await page.keyboard.press('Enter');
        await page.getByRole('dialog', { name: 'Saved post detail' }).waitFor(); assert.equal(new URL(page.url()).pathname, '/library/item/' + p.id);
        await tabTo(page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true })); await page.keyboard.press('Enter');
        await page.getByRole('dialog').waitFor({ state: 'hidden' }); await saved();
      }
      return 'Tab reaches all 24 controls; Space toggles only intended selection/favorite; Enter opens each title';
    });
    await check(22, 'no hidden panel focus trap', async () => {
      await library(); await search().focus(); await page.mouse.move(0, 0);
      assert.equal(await page.locator('.cell-overlay a, .cell-overlay button, .cell-overlay input, .cell-overlay select, .cell-overlay textarea, .cell-overlay [tabindex], .cell-overlay [contenteditable]').count(), 0);
      const first = cards().first(), last = cards().last();
      await tabTo(first.getByRole('checkbox')); await page.keyboard.press('Shift+Tab'); assert.equal(await page.evaluate(() => !!document.activeElement?.closest('main article')), false);
      await tabTo(last.getByRole('link')); await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => !!document.activeElement?.closest('main article')), false);
      await card(programming).hover(); assert.equal(await card(programming).locator('.cell-overlay :is(a,button,input,select,textarea,[tabindex],[contenteditable])').count(), 0);
      await hitTargets();
    });
    await check(23, 'reduced motion immediate reveal and focus', async () => {
      await page.context().close(); page = await newPage({ reducedMotion: 'reduce' }); await library(); await page.mouse.move(0, 0); await search().focus(); await tabTo(title(programming));
      const state = await panelState(programming); assert.equal(state.opacity, '1'); assert.equal(state.visibility, 'visible'); assert.equal(state.transform, 'none'); assert.match(state.transition, /none/);
      assert.equal(await title(programming).evaluate(el => el.matches(':focus-visible')), true); return state;
    });
    for (const [number, width, columns] of [[25, 1024, 3], [26, 768, 2]]) {
      await check(number, width + ' responsive layout in both themes', async () => {
        await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.setViewportSize({ width, height: 900 }); await library(); const measurements = [];
        for (const mode of ['dark', 'light']) {
          await theme(mode); const detail = await geometry(); measurements.push({ mode, ...detail });
          assert.equal(detail.columns, columns); assert.equal(detail.overflow, false); await hitTargets();
          if (width === 768) { const panel = await panelState(programming); assert.equal(panel.position, 'static'); assert.equal(panel.opacity, '1'); }
          await search().focus(); await search().scrollIntoViewIfNeeded(); await snap(`library-pass-b-${width}-${mode}.png`);
        }
        return measurements;
      });
    }
    for (const width of [390, 320]) {
      for (const mode of ['dark', 'light']) await check(27, `${width} touch layout ${mode}`, async () => {
        await freshLibrary(touchViewport(width)); return check27(width, mode);
      });
    }
    await page.context().close(); page = await newPage(); await library(); await theme('dark');
    await search().fill('TypeScript notes'); await page.waitForFunction(() => document.querySelectorAll('main article').length === 1); await settled(); await snap('library-pass-b-filtered.png');
    await check(28, 'Catch Up fresh-built appearance equals accepted-source baseline', catchupAppearance);
    for (const motion of ['no-preference', 'reduce']) await check(28, 'Catch Up triage Undo and focus ' + motion, () => triage(motion));
  }
  await check('isolation', 'synthetic-only runtime and network', async () => {
    assert.deepEqual(report.errors, []); assert.deepEqual(report.denied, []);
    assert.ok(report.consoleErrors.every(e => e.url.endsWith('/__fixture/broken.svg') && /404/.test(e.text)), JSON.stringify(report.consoleErrors));
    // Only the one real, deliberately failed favorite POST can explain a 503.
    // Unrelated errors retain the original console guard above, even in that group.
    for (const write of report.controlledWrites) {
      assert.ok(['shell', 'sidebar-repair'].includes(stage)); assert.equal(write.expectedAttempts, 1); assert.equal(write.attempts.length, 1);
      const failures = report.responses.filter(r => write.attempts.includes(r.request));
      assert.equal(failures.length, 1); assert.equal(failures[0].status, 503);
      assert.equal(failures[0].url, base + '/api/library'); assert.equal(failures[0].method, 'POST');
      const messages = report.expected503.filter(e => e.group === write.name);
      assert.equal(messages.length, write.expectedAttempts);
      assert.ok(messages.every(e => e.url === base + '/api/library' && expected503Text.test(e.text)));
    }
    assert.equal(report.expected503.length, report.controlledWrites.reduce((sum, write) => sum + write.expectedAttempts, 0));
    assert.ok(report.responses.every(r =>
      (r.url === base + '/__fixture/broken.svg' && r.status === 404) ||
      (r.url === base + '/api/library' && r.method === 'POST' && r.status === 503 && report.controlledWrites.some(write => write.attempts.includes(r.request)))
    ), JSON.stringify(report.responses));
    assert.ok(report.requests.every(r => { const path = new URL(r.url).pathname; return !path.startsWith('/thumb/') && (!path.startsWith('/api/') || ['/api/library', '/api/stats', '/api/categories', '/api/telegram/auth', '/api/telegram/config'].includes(path)); }));
    await snapshot('final'); return 'No external, provider, personal-state or unexpected API access; controlled 503 exact count/path checked separately';
  });
} catch (error) {
  report.failure = error.stack; process.exitCode = 1; console.error(error);
} finally {
  if (browser) { await browser.close(); report.browserClosed = true; }
  if (vite) { await vite.close(); report.devServerClosed = true; }
  if (child && child.exitCode === null) child.stdin.end('{"command":"stop"}\n');
  if (exit) { const [code] = await exit; report.events.push({ pid: child.pid, exitCode: code }); if (code !== 0) process.exitCode = 1; }
  await writeFile(join(output, 'runtime.json'), JSON.stringify(report, null, 2)); console.log('Evidence', output);
}
if (report.results.some(r => r.status === 'FAIL')) process.exitCode = 1;
