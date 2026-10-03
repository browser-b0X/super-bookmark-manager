import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, appendFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(join(root, '.verify/g4-c6-retrieval-20260917'), { recursive: true });
const evidence = await mkdtemp(join(root, '.verify/g4-c6-retrieval-20260917/e2e-'));
const db = join(evidence, 'fixture.sqlite');
const python = process.env.C6_PYTHON;
assert.ok(python, 'Set C6_PYTHON to the existing bundled runtime');
const { chromium } = createRequire(import.meta.url)(process.env.C6_PLAYWRIGHT_MODULE || 'playwright');
let server, browser, port = 0, base, page;
const events = [], errors = [], denied = [], requests = [], consoleMessages = [];
let apiOffline = false;
const pass = message => console.log('PASS ' + message);
const sorted = posts => [...posts].sort((a, b) => a.url.localeCompare(b.url));
const fixture = name => join(root, 'frontend/tests/fixtures', name);

async function start() {
  const child = spawn(python, ['-B', join(root, 'frontend/tests/library_fixture.py'), db, String(port)], { cwd: root, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', TELEGRAM_API_ID: '0', TELEGRAM_API_HASH: '', LLM_API_KEY: 'fixture', LITELLM_PROXY_KEY: 'fixture' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
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
  server = { child, pending };
  const data = await ready;
  port = data.port;
  base = `http://127.0.0.1:${port}`;
  events.push(data);
  console.log('Fixture ready', JSON.stringify(data));
}
async function control(command) {
  const result = new Promise(resolve => server.pending.set(command, resolve));
  server.child.stdin.write(JSON.stringify({ command }) + '\n');
  return result;
}
async function stop() {
  if (!server) return;
  const child = server.child;
  if (child.exitCode === null) {
    const exited = once(child, 'exit');
    child.stdin.end(JSON.stringify({ command: 'stop' }) + '\n');
    const [code] = await exited;
    assert.equal(code, 0);
  }
  server = undefined;
}
async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) {
      if (expectedExternal && route.request().isNavigationRequest() && url.href === expectedExternal.split('#')[0]) {
        externalTargets.push(url.href);
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Intercepted synthetic source</title>' });
      }
      denied.push(url.href); return route.abort();
    }
    if (url.pathname.startsWith('/api/')) {
      requests.push({ path: url.pathname, method: route.request().method() });
      if (apiOffline) return route.abort('connectionrefused');
    }
    return route.continue();
  });
  const next = await context.newPage();
  next.on('pageerror', error => errors.push(error.message));
  next.on('console', message => { if (message.type() === 'error') consoleMessages.push(message.text()); });
  return next;
}
const posts = () => page.evaluate(() => JSON.parse(localStorage.getItem('library-store-v1')).state.posts);
const status = () => page.getByRole('status', { name: 'SQLite save status' });
async function saved(count) {
  await status().filter({ hasText: /^Library saved to SQLite$/ }).waitFor();
  await page.waitForFunction(count => {
    const state = JSON.parse(localStorage.getItem('library-store-v1') || '{}').state;
    return state?.posts.length === count && Object.keys(state.pending).length === 0;
  }, count);
  const result = (await control('snapshot')).result;
  assert.equal(result.posts.length, count);
  assert.deepEqual(sorted(result.posts), sorted(await posts()));
  assert.deepEqual(result.blocked, []);
  assert.equal(result.legacyCount, 0);
  return result;
}
const seed = JSON.parse(await readFile(fixture('retrieval-library.json'), 'utf8'));
const byPath = path => seed.find(p => new URL(p.url).pathname === path);
const cooking = byPath('/cooking'), programming = byPath('/programming');
const results = [], externalTargets = [];
let expectedExternal;
const searchBox = () => page.getByPlaceholder('Search… ( / )');
// Filters live in the main sidebar since the feed revamp; shelves are links, lists are buttons.
const filters = () => { const nav = page.getByRole('complementary', { name: 'Navigation' }); return { getByRole: (_role, opts) => nav.getByRole('button', opts).or(nav.getByRole('link', opts)) }; };
const drawer = () => page.getByRole('dialog', { name: 'Saved post detail' });
async function check(name, test) {
  if (process.env.C6_CHECK && name !== process.env.C6_CHECK && name !== 'fixture isolation and runtime errors') return;
  try { const detail = await test(); results.push({ name, status: 'PASS', detail }); pass(name + (detail ? ': ' + detail : '')); }
  catch (error) {
    results.push({ name, status: 'FAIL', error: error.message });
    console.error('FAIL ' + name + ': ' + error.message);
    await page.screenshot({ path: join(evidence, 'failure-' + results.length + '.png') }).catch(() => {});
  }
}
async function library() {
  await page.goto(base + '/library');
  await saved(8);
  await searchBox().waitFor();
}
async function expectResults(expected) {
  const cards = page.locator('main article');
  await page.waitForFunction(count => document.querySelectorAll('main article').length === count, expected.length, { timeout: 1500 }).catch(() => {});
  assert.equal(await cards.count(), expected.length, 'Result count');
  for (const p of expected) assert.equal(await cards.filter({ has: page.locator(`a[href="/library/item/${p.id}"]`) }).count(), 1, 'Missing result ' + p.title);
}
async function detail(post) {
  await page.goto(`${base}/library/item/${post.id}`);
  await drawer().waitFor();
  await saved(8);
  assert.equal(await drawer().getByRole('heading', { name: post.title, exact: true }).count(), 1);
}
async function tabTo(locator, limit = 110) {
  assert.equal(await locator.count(), 1, 'A unique keyboard control must exist');
  for (let step = 0; step < limit; step++) {
    if (await locator.evaluate(el => el === document.activeElement)) return step;
    await page.keyboard.press('Tab');
  }
  throw new Error('Control not reachable with Tab');
}
try {
  await start();
  browser = await chromium.launch({ headless: true, channel: process.env.C6_BROWSER_CHANNEL || undefined });
  page = await newPage();
  page.setDefaultTimeout(5000);
  await page.goto(base + '/library');
  await saved(0);
  await page.evaluate(async posts => {
    const response = await fetch('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts, deletedUrls: [] }) });
    if (!response.ok) throw new Error('Synthetic fixture seed failed: ' + await response.text());
  }, seed);
  await library();
  assert.deepEqual(sorted(await posts()), sorted(seed));

  await check('home search discoverable and keyboard usable', async () => {
    await page.goto(base + '/'); await saved(8);
    const visibleSearch = page.getByRole('button', { name: /Search or jump to/ });
    assert.equal(await visibleSearch.isVisible(), true);
    await tabTo(visibleSearch); await page.keyboard.press('Enter');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await palette.waitFor();
    assert.equal(await palette.getByRole('textbox').evaluate(el => el === document.activeElement), true);
    await page.keyboard.type('TypeScript notes');
    await palette.getByRole('button', { name: /Programming: TypeScript notes/ }).waitFor();
    await page.keyboard.press('Enter');
    await drawer().waitFor();
    assert.equal(new URL(page.url()).pathname, '/library/item/' + programming.id);
    return 'visible home search → keyboard query/Enter → programming detail';
  });
  const queries = [
    ['title search', 'TypeScript notes', [programming]],
    ['URL search including archived record', 'course=main&serves=2', [cooking]],
    ['domain search', 'gallery.example.invalid', [byPath('/art')]],
    ['mixed-case tag search', 'mixedcase', [programming]],
    ['note search first item', 'cuminledger', [cooking]],
    ['note search second item', 'lambdanotebook', [programming]],
  ];
  for (const [name, query, expected] of queries) await check(name, async () => {
    await library(); await searchBox().fill(query); await expectResults(expected);
    return query + ' → ' + expected.map(p => p.title).join(', ');
  });
  for (const [name, label, expected] of [
    ['category filter', /^other /, seed.filter(p => p.categories.includes('other'))],
    ['favorite filter', /^Favorites /, [cooking]],
    ['archive filter', /^Archived /, [cooking]],
    ['status filter', /^Kept /, [programming]],
  ]) await check(name, async () => {
    await library(); await filters().getByRole('button', { name: label }).click(); await expectResults(expected);
    return expected.map(p => p.title).join(', ');
  });
  await check('clear search and filters restores all eight', async () => {
    await library(); await filters().getByRole('button', { name: /^Favorites / }).click();
    await searchBox().fill('CuminLedger'); await expectResults([cooking]);
    await searchBox().fill(''); await filters().getByRole('button', { name: /^All saved / }).click();
    await expectResults(seed);
    return '8 records, including archived';
  });
  await check('original source and local result detail/deep-link refresh', async () => {
    await library(); await searchBox().fill('TypeScript notes');
    await page.locator('main article').getByText(programming.title, { exact: true }).click();
    await drawer().waitFor();
    assert.equal(new URL(page.url()).pathname, '/library/item/' + programming.id);
    await page.reload(); await drawer().waitFor(); await saved(8);
    const source = drawer().getByRole('link', { name: 'Open source', exact: true });
    assert.equal(await source.getAttribute('href'), programming.url);
    assert.equal(await source.getAttribute('target'), '_blank');
    expectedExternal = programming.url;
    const popupReady = page.waitForEvent('popup');
    await source.click();
    const popup = await popupReady;
    await popup.waitForLoadState();
    assert.equal(popup.url(), programming.url);
    await popup.close(); expectedExternal = undefined;
    await saved(8);
    return 'exact original URL including #typescript; actual popup intercepted locally; detail survives refresh';
  });
  await check('two-item note isolation', async () => {
    await detail(cooking);
    assert.equal(await drawer().getByPlaceholder('Your notes…').inputValue(), cooking.userNotes);
    await drawer().getByRole('button', { name: programming.title, exact: true }).click();
    assert.equal(await drawer().getByPlaceholder('Your notes…').inputValue(), programming.userNotes);
    await drawer().getByPlaceholder('Your notes…').fill('LambdaNotebook: edited only programming');
    await drawer().getByRole('button', { name: cooking.title, exact: true }).click();
    assert.equal(await drawer().getByPlaceholder('Your notes…').inputValue(), cooking.userNotes);
    await drawer().getByPlaceholder('Your notes…').fill('CuminLedger: edited only cooking');
    await drawer().getByRole('button', { name: programming.title, exact: true }).click();
    assert.equal(await drawer().getByPlaceholder('Your notes…').inputValue(), 'LambdaNotebook: edited only programming');
    await saved(8);
    const state = await posts();
    assert.equal(state.find(p => p.id === cooking.id).userNotes, 'CuminLedger: edited only cooking');
    assert.equal(state.find(p => p.id === programming.id).userNotes, 'LambdaNotebook: edited only programming');
    return 'cooking → programming → cooking → programming: notes remain on their own IDs in UI and SQLite';
  });
  for (const view of ['grid', 'list', 'table']) await check('keyboard result opening: ' + view, async () => {
    await library();
    await tabTo(searchBox()); await page.keyboard.type('TypeScript notes');
    const mode = page.getByRole('radio', { name: view, exact: true });
    await tabTo(mode); await page.keyboard.press('Space');
    const opener = page.locator('main').getByRole('link', { name: programming.title, exact: true });
    assert.equal(await opener.count(), 1, 'Result title needs a keyboard-reachable detail link');
    await tabTo(opener); await page.keyboard.press('Enter');
    await drawer().waitFor();
    assert.equal(new URL(page.url()).pathname, '/library/item/' + programming.id);
    await tabTo(drawer().getByPlaceholder('Your notes…'));
    await page.keyboard.press('Control+A'); await page.keyboard.type('LambdaNotebook: keyboard edit ' + view);
    await saved(8);
    assert.equal((await posts()).find(p => p.id === programming.id).userNotes, 'LambdaNotebook: keyboard edit ' + view);
    const source = drawer().getByRole('link', { name: 'Open source', exact: true });
    await tabTo(source);
    expectedExternal = programming.url;
    const popupReady = page.waitForEvent('popup'); await page.keyboard.press('Enter');
    const popup = await popupReady; await popup.waitForLoadState(); assert.equal(popup.url(), programming.url);
    await popup.close(); expectedExternal = undefined;
    await tabTo(drawer().getByRole('button', { name: 'Close', exact: true })); await page.keyboard.press('Enter');
    await drawer().waitFor({ state: 'hidden' });
    await saved(8);
    return 'Tab/type/Space/Enter: search, view, result, note edit, original link, close';
  });
  await check('affected C4 exact curation survives reload/restart/fresh browser', async () => {
    await saved(8);
    const expected = sorted(await posts());
    assert.deepEqual(expected.find(p => p.id === programming.id).tags, ['ui-tag', 'MixedCase']);
    assert.equal(expected.find(p => p.id === cooking.id).favorite, true);
    assert.equal(expected.find(p => p.id === cooking.id).status, 'archived');
    assert.deepEqual(expected.find(p => p.id === cooking.id).categories, ['other']);
    assert.equal(expected.find(p => p.id === cooking.id).categoryMode, 'manual');
    await writeFile(join(evidence, 'curation-before-recovery.json'), JSON.stringify(expected, null, 2));
    await page.reload(); await saved(8); assert.deepEqual(sorted(await posts()), expected);
    await stop(); await start(); await page.reload(); await saved(8); assert.deepEqual(sorted(await posts()), expected);
    await page.context().close(); page = await newPage(); page.setDefaultTimeout(5000);
    await library(); assert.deepEqual(sorted(await posts()), expected);
    await writeFile(join(evidence, 'curation-after-recovery.json'), JSON.stringify(sorted(await posts()), null, 2));
    return 'exact full documents match in SQLite, reloaded app, restarted backend and fresh browser';
  });
  await check('fixture isolation and runtime errors', async () => {
    assert.deepEqual(errors, []); assert.deepEqual(denied, []);
    assert.ok(requests.every(r => ['/api/library', '/api/stats', '/api/categories', '/api/telegram/auth', '/api/telegram/config', '/api/ai/providers'].includes(r.path)));
    assert.deepEqual((await control('snapshot')).result.blocked, []);
    return 'no provider/personal/external network access or uncaught browser errors';
  });
} finally {
  if (browser) await browser.close();
  await stop();
  await writeFile(join(evidence, 'runtime.json'), JSON.stringify({ db, port, events, errors, denied, externalTargets, requests, consoleMessages, results, stopped: true }, null, 2));
  console.log('CLEANUP owned browser and fixture server closed; evidence', evidence);
}
assert.deepEqual(results.filter(r => r.status !== 'PASS').map(r => r.name), [], 'C6 verification failures');
