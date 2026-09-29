import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, appendFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = await mkdtemp(join(root, '.verify/g4-c7-landing-20260918/e2e-'));
let db = join(evidence, 'fixture.sqlite');
const python = process.env.C7_PYTHON;
assert.ok(python, 'Set C7_PYTHON to the existing bundled runtime');
const { chromium } = createRequire(import.meta.url)(process.env.C7_PLAYWRIGHT_MODULE || 'playwright');
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
    if (url.origin === base && url.pathname.startsWith('/__fixture/')) {
      if (url.pathname.endsWith('broken.svg')) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'Synthetic missing image' });
      return route.fulfill({ contentType: 'image/svg+xml', body: url.pathname.endsWith('tiny.svg') ? tinyImage : previewImage });
    }
    if (url.origin !== base) {
      if (expectedExternal && route.request().isNavigationRequest() && url.href === expectedExternal.split('#')[0]) {
        externalTargets.push(url.href);
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Intercepted synthetic source</title>' });
      }
      denied.push(url.href); return route.abort();
    }
    if (url.pathname.startsWith('/api/')) {
      requests.push({ path: url.pathname, method: route.request().method() });
      if (apiOffline) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture backend unavailable' }) });
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
const previewImage = await readFile(fixture('landing-preview.svg'), 'utf8');
const tinyImage = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="5" fill="#6c8cff"/><text x="8" y="24" font-size="22" fill="white">L</text></svg>';
const seed = JSON.parse(await readFile(fixture('retrieval-library.json'), 'utf8'));
const results = [], screenshots = [], externalTargets = [];
let expectedExternal, scenario;
const main = () => page.locator('main');
const article = post => main().locator('article').filter({ has: page.getByRole('link', { name: post.title, exact: true }) });
async function check(name, run) {
  try { const detail = await run(); results.push({ scenario, name, status: 'PASS', detail }); pass(scenario + ' / ' + name); }
  catch (error) { results.push({ scenario, name, status: 'FAIL', error: error.message }); console.error('FAIL ' + scenario + ' / ' + name + ': ' + error.message); }
}
async function snap(name) {
  await page.mouse.move(1300, 50);
  await page.waitForLoadState('networkidle');
  const path = join(evidence, name + '.png');
  await page.screenshot({ path, animations: 'disabled' });
  screenshots.push({ scenario, name, path });
}
async function noObstruction() {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Horizontal page overflow');
  const controls = page.locator('main a, main button, main select, aside[aria-label="Navigation"] > div.border-t a, aside[aria-label="Navigation"] > div.border-t button');
  const covered = await controls.evaluateAll(elements => elements.flatMap(el => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.top < 60 || r.bottom > innerHeight - 10) return [];
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return top && (el.contains(top) || top === el) ? [] : [el.textContent?.trim() || el.getAttribute('aria-label')];
  }));
  assert.deepEqual(covered, [], 'Visible core controls must not be obscured');
}
try {
  browser = await chromium.launch({ headless: true, channel: process.env.C7_BROWSER_CHANNEL || undefined });
  for (scenario of ['populated', 'zero-inbox', 'empty-library', 'valid-image', 'broken-missing', 'degraded-cache', 'degraded-demo']) {
    db = join(evidence, scenario + '.sqlite'); port = 0; apiOffline = false;
    await start();
    page = await newPage(); page.setDefaultTimeout(5000);
    try {
      let fixturePosts = structuredClone(seed);
      for (const post of fixturePosts) {
        if (['/art', '/travel'].includes(new URL(post.url).pathname)) post.thumbnailUrl = '/__fixture/preview.svg';
        if (new URL(post.url).pathname === '/exercise') post.thumbnailUrl = '/__fixture/tiny.svg';
        if (new URL(post.url).pathname === '/budgeting') post.thumbnailUrl = '/__fixture/broken.svg';
      }
      if (scenario === 'zero-inbox') fixturePosts = fixturePosts.map(p => ({ ...p, status: p.status === 'inbox' ? 'reference' : p.status }));
      if (scenario === 'empty-library' || scenario === 'degraded-demo') fixturePosts = [];
      if (scenario === 'broken-missing') fixturePosts = fixturePosts.map(p => ({ ...p, thumbnailUrl: new URL(p.url).pathname === '/art' ? '/__fixture/broken.svg' : new URL(p.url).pathname === '/exercise' ? '/__fixture/tiny.svg' : undefined }));
      if (scenario === 'degraded-demo') apiOffline = true;
      await page.goto(base + '/');
      if (!apiOffline) {
        await saved(0);
        if (fixturePosts.length) {
          await page.evaluate(async posts => {
            const response = await fetch('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts, deletedUrls: [] }) });
            if (!response.ok) throw new Error('Fixture seed failed');
          }, fixturePosts);
          await page.reload(); await saved(8);
        }
        if (scenario === 'degraded-cache') { apiOffline = true; await page.reload(); }
      }
      if (apiOffline) await status().filter({ hasText: /unavailable|Demo only/ }).waitFor();
      await snap(scenario);
      await check('no blocking overlap or clipping', noObstruction);
      if (scenario === 'populated') {
        await main().evaluate(el => { el.scrollTop = el.scrollHeight; });
        await snap('populated-bottom');
        await check('last card actions reachable by scrolling', noObstruction);
        await main().evaluate(el => { el.scrollTop = 0; });
      }
      if (['populated', 'valid-image', 'broken-missing', 'degraded-cache'].includes(scenario)) {
        const shown = fixturePosts.filter(p => p.status === 'inbox');
        await check('mixed imported sources, readable titles and domains', async () => {
          assert.ok(shown.some(p => p.source === 'browser') && shown.some(p => p.source === 'telegram'));
          for (const post of shown) {
            const card = article(post);
            assert.equal(await card.count(), 1);
            assert.match(await card.innerText(), new RegExp(post.source === 'browser' ? 'Browser bookmark' : 'Telegram', 'i'));
            assert.ok((await card.innerText()).includes(post.domain));
            const title = card.getByRole('link', { name: post.title, exact: true });
            assert.equal(await title.evaluate(el => el.scrollWidth > el.clientWidth + 1), false);
          }
          assert.doesNotMatch(await main().innerText(), /\d+ new links from Telegram/);
        });
        await check('category and item state visible', async () => {
          for (const post of shown) {
            const text = await article(post).innerText();
            assert.ok(text.includes(post.categories[0]), post.title + ' category absent');
            assert.match(text, /Inbox/);
          }
        });
        await check('search, open and curation actions available', async () => {
          assert.equal(await page.getByRole('button', { name: /Search or jump to/ }).isVisible(), true);
          const art = fixturePosts.find(p => new URL(p.url).pathname === '/art');
          assert.equal(await article(art).getByRole('link', { name: art.title, exact: true }).getAttribute('href'), art.url);
          assert.equal(await article(art).getByRole('button', { name: 'Keep', exact: true }).isVisible(), true);
          assert.equal(await main().getByRole('link', { name: 'Library', exact: true }).isVisible(), true);
        });
      }
      if (scenario === 'populated' || scenario === 'valid-image') await check('recognizable content preview', async () => {
        const art = fixturePosts.find(p => new URL(p.url).pathname === '/art');
        const image = article(art).locator('img');
        const size = await image.evaluate(el => ({ w: el.clientWidth, h: el.clientHeight, natural: el.naturalWidth }));
        assert.equal(size.natural, 640);
        assert.ok(size.w >= 120 && size.h >= 80, 'Content preview remains too small to recognize: ' + JSON.stringify(size));
      });
      if (scenario === 'populated' || scenario === 'broken-missing') {
        await check('broken and missing images retain content with fallback', async () => {
          const brokenPath = scenario === 'populated' ? '/budgeting' : '/art';
          const broken = fixturePosts.find(p => new URL(p.url).pathname === brokenPath);
          const missing = fixturePosts.find(p => new URL(p.url).pathname === '/no-metadata');
          for (const post of [broken, missing]) {
            assert.equal(await article(post).locator('img').count(), 0);
            assert.equal(await article(post).locator('svg').count() > 0, true);
            assert.equal(await article(post).getByRole('link', { name: post.title, exact: true }).isVisible(), true);
          }
        });
        await check('tiny favicon not enlarged as content', async () => {
          const tiny = fixturePosts.find(p => new URL(p.url).pathname === '/exercise');
          const sizes = await article(tiny).locator('img').evaluateAll(images => images.map(el => ({ w: el.clientWidth, h: el.clientHeight, nw: el.naturalWidth, nh: el.naturalHeight })));
          assert.ok(sizes.every(s => s.w <= s.nw && s.h <= s.nh), JSON.stringify(sizes));
        });
      }
      if (scenario === 'zero-inbox') await check('retained library is useful after inbox zero', async () => {
        assert.equal((await posts()).length, 8);
        const browse = main().getByRole('link', { name: /Browse.*library/ });
        assert.equal(await browse.isVisible(), true);
        assert.doesNotMatch(await main().innerText(), /library is empty/i);
        await browse.click(); await saved(8);
        assert.equal(await main().locator('article').count(), 8);
      });
      if (scenario === 'empty-library') await check('empty library clearly identified with both import sources', async () => {
        const text = await main().innerText();
        assert.match(text, /library is empty|no saved links|no links yet/i);
        assert.match(text, /bookmark/i); assert.match(text, /Telegram/i);
        assert.equal(await main().getByRole('link', { name: /Import/ }).getAttribute('href'), '/library/settings');
      });
      if (scenario === 'degraded-cache') await check('backend unavailable clearly labeled, cached content retained', async () => {
        assert.match(await status().innerText(), /SQLite unavailable.*browser cache/);
        assert.equal((await posts()).length, 8);
        assert.equal(await status().getByRole('button', { name: 'Retry SQLite save' }).isVisible(), true);
      });
      if (scenario === 'degraded-demo') await check('sample content clearly separated from personal imports', async () => {
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('library-store-v1')).state.demo), true);
        assert.match(await main().innerText(), /sample|demo/i);
        assert.doesNotMatch(await main().innerText(), /\d+ new links from Telegram/);
        assert.match(await status().innerText(), /Demo only/);
      });
      if (scenario === 'populated') await check('affected C6 home/library/search/detail and curation regression', async () => {
        const art = fixturePosts.find(p => new URL(p.url).pathname === '/art');
        await article(art).getByRole('button', { name: 'Later', exact: true }).click(); await saved(8);
        assert.equal((await posts()).find(p => p.id === art.id).status, 'to-review');
        await main().getByRole('button', { name: 'Undo', exact: true }).click(); await saved(8);
        assert.equal((await posts()).find(p => p.id === art.id).status, 'inbox');
        await page.keyboard.press('Control+k');
        const palette = page.getByRole('dialog', { name: 'Command palette' });
        await palette.getByRole('textbox').fill('TypeScript notes'); await page.keyboard.press('Enter');
        const drawer = page.getByRole('dialog', { name: 'Saved post detail' }); await drawer.waitFor();
        const programming = fixturePosts.find(p => new URL(p.url).pathname === '/programming');
        assert.equal(new URL(page.url()).pathname, '/library/item/' + programming.id);
        assert.equal(await drawer.getByPlaceholder('Your notes…').inputValue(), programming.userNotes);
        await page.goto(base + '/library'); await saved(8);
        await page.waitForLoadState('networkidle');
        const artCard = main().locator('article').filter({ has: page.getByRole('link', { name: art.title, exact: true }) });
        assert.equal(await artCard.locator('img').evaluate(el => el.naturalWidth), 640);
        const exercise = fixturePosts.find(p => new URL(p.url).pathname === '/exercise');
        assert.equal(await main().locator('article').filter({ has: page.getByRole('link', { name: exercise.title, exact: true }) }).locator('img').count(), 0, 'Library must not inflate a tiny favicon');
        await page.getByPlaceholder('Search… ( / )').fill('mixedcase');
        assert.equal(await main().locator('article').count(), 1);
        const detailLink = main().getByRole('link', { name: programming.title, exact: true });
        assert.equal(await detailLink.getAttribute('href'), '/library/item/' + programming.id);
        await detailLink.click(); await drawer.waitFor();
        assert.equal(await drawer.getByRole('link', { name: 'Open source', exact: true }).getAttribute('href'), programming.url);
      });
      const snapshot = (await control('snapshot')).result;
      assert.deepEqual(snapshot.blocked, []); assert.equal(snapshot.legacyCount, 0);
    } finally {
      await page.context().close(); await stop();
    }
  }
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
} finally {
  if (browser) await browser.close(); await stop();
  await writeFile(join(evidence, 'runtime.json'), JSON.stringify({ events, errors, denied, requests, consoleMessages, results, screenshots, stopped: true }, null, 2));
  console.log('CLEANUP owned fixture servers and browser closed; evidence', evidence);
}
assert.deepEqual(results.filter(r => r.status === 'FAIL').map(r => r.scenario + '/' + r.name), [], 'C7 objective checks failed');
