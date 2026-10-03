import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, appendFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(join(root, '.verify/g3-c5-categorization-20260917'), { recursive: true });
const evidence = await mkdtemp(join(root, '.verify/g3-c5-categorization-20260917/e2e-'));
const db = join(evidence, 'fixture.sqlite');
const python = process.env.C5_PYTHON;
assert.ok(python, 'Set C5_PYTHON to the existing bundled runtime');
const { chromium } = createRequire(import.meta.url)(process.env.C5_PLAYWRIGHT_MODULE || 'playwright');
let server, browser, port = 0, base, page;
const events = [], errors = [], denied = [], requests = [], consoleMessages = [];
let apiOffline = false;
const pass = message => console.log('PASS ' + message);
const sorted = posts => [...posts].sort((a, b) => a.url.localeCompare(b.url));
const fixture = name => join(root, 'frontend/tests/fixtures', name);

async function start() {
  const child = spawn(python, ['-B', join(root, 'frontend/tests/categorization_fixture.py'), db, String(port)], { cwd: root, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
    if (url.origin !== base) { denied.push(url.href); return route.abort(); }
    if (url.pathname.startsWith('/api/')) {
      requests.push({ path: url.pathname, method: route.request().method(), body: route.request().postDataJSON() });
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
async function importAll(reimport = false) {
  await page.goto(base + '/library/settings');
  for (const name of ['firefox', 'chromium']) {
    await page.getByLabel('Import bookmarks HTML').setInputFiles(fixture(`bookmarks-${name}.html`));
    const expected = reimport ? '0 new, 3 already present' : name === 'firefox' ? '3 new, 0 already present' : '2 new, 1 already present';
    await page.getByRole('status').filter({ hasText: expected }).waitFor();
  }
  await page.getByLabel('Import Telegram JSON').setInputFiles(fixture('telegram-saved-messages.json'));
  await page.getByRole('status', { name: 'Telegram import result' }).filter({ hasText: reimport ? '0 new, 4 already present' : '3 new, 1 already present' }).waitFor();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('library-store-v1')).state.posts.every(p => p.categoryMode === 'automatic' || p.categoryMode === 'manual'));
  await page.waitForLoadState('networkidle');
  await saved(8);
}
async function detail(post) {
  await page.goto(`${base}/library/item/${post.id}`);
  const dialog = page.getByRole('dialog', { name: 'Saved post detail' });
  await dialog.waitFor();
  return dialog;
}
const cases = JSON.parse(await readFile(fixture('categorization-cases.json'), 'utf8'));
try {
  await start();
  browser = await chromium.launch({ headless: true, channel: process.env.C5_BROWSER_CHANNEL || undefined });
  page = await newPage();
  await page.goto(base + '/library/settings');
  await saved(0);
  await importAll();
  const initial = await posts();
  const results = cases.map(item => {
    const post = initial.find(p => new URL(p.url).pathname === item.path);
    assert.ok(post, item.item);
    assert.deepEqual(post.categories, [item.expected], item.item);
    assert.equal(post.categoryMode, 'automatic', item.item);
    assert.equal(post.categoryReview, item.expected === 'other', item.item);
    return { item: item.item, category: post.categories[0], review: post.categoryReview, source: post.source, id: post.id };
  });
  await writeFile(join(evidence, 'category-results.json'), JSON.stringify(results, null, 2));
  console.log('RESULTS ' + JSON.stringify(results));
  const snapshot = (await control('snapshot')).result;
  assert.equal(snapshot.shelves.filter(c => !['other', 'uncategorized'].includes(c)).length, 9);
  const firstCalls = requests.filter(r => r.path === '/api/categorize');
  assert.equal(firstCalls.length, 8);
  assert.ok(firstCalls.every(r => r.body.keywords_only === true && !('tg_msg_id' in r.body)));
  pass('both Settings file imports automatically classify 8 unique links into existing shelves; six topics plus two other/review; provider/metadata entry points unavailable');

  const first = initial.find(p => new URL(p.url).pathname === '/cooking');
  const second = initial.find(p => new URL(p.url).pathname === '/programming');
  let dialog = await detail(first);
  await dialog.getByRole('button', { name: 'food-drink', exact: true }).click();
  await dialog.getByRole('button', { name: 'other', exact: true }).click();
  await dialog.getByRole('button', { name: 'Favorite', exact: true }).click();
  await dialog.getByRole('button', { name: 'Archived', exact: true }).click();
  await dialog.getByPlaceholder('Your notes…').fill('C5 manual other — café');
  await saved(8);
  dialog = await detail(second);
  await dialog.getByRole('button', { name: 'technology', exact: true }).click();
  await dialog.getByRole('button', { name: 'technology', exact: true }).click();
  // Status chip (button.chip.transition-colors) — disambiguated from any Related-item
  // button that happens to share the label. Status renders before Related in the drawer.
  await dialog.locator('button.chip.transition-colors', { hasText: 'Reference' }).click();
  await dialog.getByPlaceholder('Your notes…').fill('C5 programming note\nSecond line');
  await dialog.getByPlaceholder('add tag ⏎').fill('ui-tag');
  await dialog.getByPlaceholder('add tag ⏎').press('Enter');
  await saved(8);
  let expected = sorted(await posts());
  assert.deepEqual(expected.find(p => p.id === first.id).categories, ['other']);
  assert.equal(expected.find(p => p.id === first.id).categoryMode, 'manual');
  assert.equal(expected.find(p => p.id === first.id).categoryReview, false);
  assert.equal(expected.find(p => p.id === first.id).favorite, true);
  assert.equal(expected.find(p => p.id === first.id).status, 'archived');
  assert.equal(expected.find(p => p.id === second.id).categoryMode, 'manual');
  assert.deepEqual(expected.find(p => p.id === second.id).tags, ['ui-tag']);
  await writeFile(join(evidence, 'curation-before.json'), JSON.stringify(expected, null, 2));
  await page.reload(); await saved(8);
  assert.deepEqual(sorted(await posts()), expected);
  await stop(); await start();
  await page.reload(); await saved(8);
  assert.deepEqual(sorted(await posts()), expected);
  await page.context().close(); page = await newPage();
  await page.goto(base + '/library/settings'); await saved(8);
  assert.deepEqual(sorted(await posts()), expected);
  const previousCalls = requests.filter(r => r.path === '/api/categorize').length;
  await importAll(true);
  const retryCalls = requests.filter(r => r.path === '/api/categorize').slice(previousCalls);
  assert.equal(retryCalls.length, 2);
  assert.ok(retryCalls.every(r => /example.invalid\/(reference|no-metadata)/.test(r.body.content)));
  assert.deepEqual(sorted(await posts()), expected);
  await writeFile(join(evidence, 'curation-after-recovery.json'), JSON.stringify(sorted(await posts()), null, 2));
  pass('manual other/topic, notes, tags, favorite/status and every field survive reload, owned restart, fresh browser and all reimports; only two automatic review records retry');

  await control('fail-on');
  const travel = initial.find(p => new URL(p.url).pathname === '/travel');
  dialog = await detail(travel);
  await dialog.getByRole('button', { name: 'travel', exact: true }).click();
  await dialog.getByRole('button', { name: 'other', exact: true }).click();
  await status().filter({ hasText: 'Changes were not saved' }).waitFor();
  assert.match(await status().innerText(), /1 change pending SQLite save/);
  assert.doesNotMatch(await status().innerText(), /Library saved to SQLite/);
  assert.deepEqual(sorted((await control('snapshot')).result.posts), expected);
  await page.reload();
  await status().filter({ hasText: 'Changes were not saved' }).waitFor();
  assert.deepEqual((await posts()).find(p => p.id === travel.id).categories, ['other']);
  assert.equal((await posts()).find(p => p.id === travel.id).categoryMode, 'manual');
  // The reloaded /library/item/:id route restores the PostDrawer, whose z-[90] backdrop covers the
  // sidebar save-status panel and intercepts a Retry click there. Navigate to Settings (no drawer
  // open) so the explicit Retry is a real, unobstructed user click — the proven core-acceptance /
  // library-e2e sequence. The pending change lives in the store/localStorage, so it survives this
  // navigation while fail-on is still active; the explicit Retry below is still what persists it.
  await page.goto(base + '/library/settings');
  await status().filter({ hasText: 'Changes were not saved' }).waitFor();
  await control('fail-off');
  await status().getByRole('button', { name: 'Retry SQLite save' }).click();
  await saved(8);
  expected = sorted(await posts());
  await page.context().close(); page = await newPage();
  await page.goto(base + '/library/settings'); await saved(8);
  assert.deepEqual(sorted(await posts()), expected);
  await importAll(true);
  assert.deepEqual(sorted(await posts()), expected);
  await writeFile(join(evidence, 'final-sqlite.json'), JSON.stringify((await control('snapshot')).result, null, 2));
  pass('failed category writes remain visibly pending across reload; SQLite transaction unchanged; retry and fresh browser retain manual correction and all 8 records');
  assert.deepEqual(errors, []);
  assert.deepEqual(denied, []);
  assert.ok(requests.every(r => ['/api/library', '/api/stats', '/api/categories', '/api/categorize', '/api/enrich', '/api/telegram/auth', '/api/telegram/config', '/api/ai/providers'].includes(r.path)));
  assert.deepEqual((await control('snapshot')).result.blocked, []);
  pass('no uncaught browser errors, metadata/model calls, personal data or external requests; shelf count stays nine topical plus reserved');
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
    await writeFile(join(evidence, 'failure-state.json'), JSON.stringify(await posts().catch(() => []), null, 2));
  }
  throw error;
} finally {
  if (browser) await browser.close();
  await stop();
  await writeFile(join(evidence, 'runtime.json'), JSON.stringify({ db, port, events, errors, denied, requests, consoleMessages, stopped: true }, null, 2));
  console.log('CLEANUP owned browser and fixture server closed; evidence', evidence);
}
