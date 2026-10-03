import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile, appendFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const root = fileURLToPath(new URL('../../', import.meta.url));
await mkdir(join(root, '.verify/g2-c4-durability-20260917'), { recursive: true });
const evidence = await mkdtemp(join(root, '.verify/g2-c4-durability-20260917/e2e-'));
const db = join(evidence, 'fixture.sqlite');
const python = process.env.C4_PYTHON;
assert.ok(python, 'Set C4_PYTHON to the existing bundled runtime');
const { chromium } = createRequire(import.meta.url)(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
let server, browser, port = 0, base, page;
const events = [], errors = [], denied = [], requests = [], consoleMessages = [], timeline = [];
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
  timeline.push({ at: Date.now(), event: 'control-start', command });
  const result = new Promise(resolve => server.pending.set(command, resolve));
  server.child.stdin.write(JSON.stringify({ command }) + '\n');
  const response = await result;
  timeline.push({ at: Date.now(), event: 'control-end', command });
  return response;
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
      requests.push({ path: url.pathname, method: route.request().method() });
      if (apiOffline) return route.abort('connectionrefused');
      // C5 added automatic classification after this C4 suite was written.
      // Keep the durability regression deterministic, offline and provider-free.
      if (url.pathname === '/api/categorize') return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Fixture classifier unavailable"}' });
    }
    return route.continue();
  });
  const next = await context.newPage();
  next.on('pageerror', error => errors.push(error.message));
  next.on('console', message => { if (message.type() === 'error') consoleMessages.push(message.text()); });
  next.on('request', request => {
    if (new URL(request.url()).pathname === '/api/library') timeline.push({ at: Date.now(), event: 'request', method: request.method(), payload: request.postDataJSON() });
  });
  next.on('response', response => {
    if (new URL(response.url()).pathname === '/api/library') timeline.push({ at: Date.now(), event: 'response', method: response.request().method(), status: response.status() });
  });
  await next.exposeFunction('recordC4', entry => timeline.push(entry));
  await next.addInitScript(() => {
    let previous;
    const record = (event, button) => {
      const panel = document.querySelector('[aria-label="SQLite save status"]')?.textContent;
      if (event === 'status' && panel === previous) return;
      previous = panel;
      const state = JSON.parse(localStorage.getItem('library-store-v1') || '{}').state;
      void window.recordC4({ at: Date.now(), event, button, path: location.pathname, panel, pending: state?.pending });
    };
    document.addEventListener('click', event => {
      if (event.target instanceof Element) record('click', event.target.closest('button')?.textContent);
    }, true);
    new MutationObserver(() => record('status')).observe(document, { subtree: true, childList: true, characterData: true });
  });
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
  await saved(8);
}
async function detail(post) {
  await page.goto(`${base}/library/item/${post.id}`);
  const dialog = page.getByRole('dialog', { name: 'Saved post detail' });
  await dialog.waitFor();
  return dialog;
}
const ninthHtml = '<!DOCTYPE NETSCAPE-Bookmark-file-1><TITLE>Fixture</TITLE><H1>Fixture</H1><DL><p><DT><A HREF="https://example.invalid/disposable">Ninth disposable</A></DL><p>';
async function ninth() {
  await page.goto(base + '/library/settings');
  await page.getByLabel('Import bookmarks HTML').setInputFiles({ name: 'ninth.html', mimeType: 'text/html', buffer: Buffer.from(ninthHtml) });
}

try {
  await start();
  browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
  page = await newPage();
  await page.goto(base + '/library/settings');
  await saved(0);
  let first, second, dialog, expected;
  if (process.env.C4_RECOVERY_SEED) {
    const seed = JSON.parse(await readFile(join(root, process.env.C4_RECOVERY_SEED), 'utf8'));
    assert.equal(seed.length, 8);
    assert.ok(seed.every(post => new URL(post.url).hostname === 'example.invalid'));
    await page.evaluate(async posts => {
      const response = await fetch('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts, deletedUrls: ['https://example.invalid/disposable'] }) });
      if (!response.ok) throw new Error('Recovery fixture seed failed');
    }, seed);
    await page.reload(); await saved(8);
    expected = sorted(seed); assert.deepEqual(sorted(await posts()), expected);
    first = seed.find(p => p.url.includes('/cooking'));
    second = seed.find(p => p.url.includes('/programming'));
    console.log('SETUP recovery-only: retained synthetic curation seeded; completed import/durability/deletion groups not rerun');
  } else {
  assert.doesNotMatch(await page.locator('main').innerText(), /stored in this browser only|not yet backed up to SQLite|not backed up to SQLite/);
  pass('Settings explains SQLite durability without obsolete browser-only claims');
  await importAll();
  pass('actual Settings imports 3 + 2 + 3 = 8 complete SQLite records');
  const initial = await posts();
  first = initial.find(p => p.url.includes('/cooking'));
  second = initial.find(p => p.url.includes('/programming'));
  dialog = await detail(first);
  // The offline C5 fallback may already select other; explicitly correct it
  // through the UI, rather than toggling the selected category off by accident.
  if (first.categories.includes('other')) await dialog.getByRole('button', { name: 'other', exact: true }).click();
  await dialog.getByRole('button', { name: 'other', exact: true }).click();
  await dialog.getByRole('button', { name: 'Favorite', exact: true }).click();
  await dialog.getByRole('button', { name: 'Archived', exact: true }).click();
  await dialog.getByPlaceholder('Your notes…').fill('C4 cooking note — café');
  await saved(8);
  dialog = await detail(second);
  await dialog.getByRole('button', { name: 'technology', exact: true }).click();
  // Scope to the status chip specifically: accessible name exactly "Reference" AND the
  // status-chip class. A B4 Related Items row can share the visible label "Reference",
  // so a name-only selector is ambiguous. Not positional; expresses "the Reference status chip".
  await dialog.getByRole('button', { name: 'Reference', exact: true }).and(dialog.locator('button.chip.transition-colors')).click();
  await dialog.getByPlaceholder('Your notes…').fill('C4 programming note\nSecond line');
  await dialog.getByPlaceholder('add tag ⏎').fill('ui-tag');
  await dialog.getByPlaceholder('add tag ⏎').press('Enter');
  await saved(8);
  // The existing tag input lowercases; seed an already-stored mixed-case tag through the real API.
  await page.evaluate(async id => {
    const current = JSON.parse(localStorage.getItem('library-store-v1')).state.posts.find(p => p.id === id);
    const response = await fetch('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts: [{ ...current, tags: [...current.tags, 'MixedCase'] }], deletedUrls: [] }) });
    if (!response.ok) throw new Error('Synthetic stored-tag setup failed');
  }, second.id);
  await page.goto(base + '/library/settings');
  await saved(8);
  expected = sorted(await posts());
  assert.deepEqual(expected.find(p => p.id === first.id).categories, ['other']);
  assert.equal(expected.find(p => p.id === first.id).favorite, true);
  assert.equal(expected.find(p => p.id === first.id).status, 'archived');
  assert.equal(expected.find(p => p.id === second.id).status, 'reference');
  assert.deepEqual(expected.find(p => p.id === second.id).tags, ['ui-tag', 'MixedCase']);
  await writeFile(join(evidence, 'curation-before.json'), JSON.stringify(expected, null, 2));
  await page.reload(); await saved(8);
  assert.deepEqual(sorted(await posts()), expected);
  await stop(); await start();
  await page.reload(); await saved(8);
  assert.deepEqual(sorted(await posts()), expected);
  await page.context().close();
  page = await newPage();
  assert.equal(await page.evaluate(() => Object.keys(localStorage).length).catch(() => 0), 0);
  await page.goto(base + '/library/settings'); await saved(8);
  assert.deepEqual(sorted(await posts()), expected);
  await importAll(true);
  await page.getByRole('button', { name: 'Re-sync from SQLite', exact: true }).click();
  await saved(8);
  assert.deepEqual(sorted(await posts()), expected);
  await writeFile(join(evidence, 'curation-after-recovery.json'), JSON.stringify(sorted(await posts()), null, 2));
  pass('reload, owned backend restart, fresh browser, all reimports and re-sync preserve every field; SQLite count 8');

  await ninth(); await saved(9);
  const disposable = (await posts()).find(p => p.title === 'Ninth disposable');
  dialog = await detail(disposable);
  const beforeCancel = sorted(await posts());
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.deepEqual(sorted(await posts()), beforeCancel); await saved(9);
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  const deleted = await saved(8);
  assert.deepEqual(deleted.deletedUrls, [disposable.url]);
  assert.deepEqual(sorted(await posts()), expected);
  await ninth(); await saved(8);
  await page.context().close(); page = await newPage();
  await page.goto(base + '/library/settings'); await saved(8);
  await ninth(); await saved(8);
  assert.deepEqual(sorted(await posts()), expected);
  pass('ninth item: cancel retains 9 unchanged; confirm leaves original 8; tombstone prevents reimport and fresh-browser resurrection');
  }

  await control('fail-on');
  dialog = await detail(first);
  await dialog.getByPlaceholder('Your notes…').fill('C4 failed-write note');
  await status().filter({ hasText: 'Changes were not saved' }).waitFor();
  assert.match(await status().innerText(), /1 change pending SQLite save/);
  assert.doesNotMatch(await status().innerText(), /Library saved to SQLite/);
  assert.deepEqual(sorted((await control('snapshot')).result.posts), expected);
  await page.screenshot({ path: join(evidence, 'failed-write.png') });
  await page.reload();
  await status().filter({ hasText: 'Changes were not saved' }).waitFor();
  assert.equal(await page.getByPlaceholder('Your notes…').inputValue(), 'C4 failed-write note');
  // Back navigation starts another sync; keep writes failing until that attempt settles.
  const navigationWrite = page.waitForResponse(response => new URL(response.url()).pathname === '/api/library' && response.request().method() === 'POST' && response.status() === 503);
  await page.getByRole('dialog', { name: 'Saved post detail' }).getByRole('button', { name: 'Close', exact: true }).click();
  await page.waitForURL(base + '/library/settings');
  await navigationWrite;
  await status().filter({ hasText: 'Changes were not saved' }).waitFor();
  const retry = status().getByRole('button', { name: 'Retry SQLite save' });
  assert.equal(await retry.isEnabled(), true);
  assert.deepEqual(sorted((await control('snapshot')).result.posts), expected);
  const pendingState = await page.evaluate(() => JSON.parse(localStorage.getItem('library-store-v1')).state);
  assert.deepEqual(Object.keys(pendingState.pending), [first.url]);
  const pendingPost = pendingState.pending[first.url];
  const retryExpected = expected.map(post => post.id === first.id ? { ...post, userNotes: 'C4 failed-write note', updatedAt: pendingPost.updatedAt } : post);
  assert.deepEqual(sorted(pendingState.posts), retryExpected);
  await page.screenshot({ path: join(evidence, 'retry-ready.png') });
  const retryBoundary = timeline.length;
  await control('fail-off');
  await retry.click();
  const retried = await saved(8);
  const retryEvents = timeline.slice(retryBoundary);
  const click = retryEvents.find(event => event.event === 'click' && event.button === 'Retry SQLite save');
  const writes = retryEvents.filter(event => event.event === 'request' && event.method === 'POST');
  assert.ok(click, 'An explicit Retry click must occur while the change remains pending');
  assert.deepEqual(click.pending, { [first.url]: pendingPost });
  assert.equal(writes.length, 1);
  assert.ok(writes[0].at >= click.at, 'The successful write must follow the explicit Retry click');
  // `since` is the delta-sync revision (audit F8); the write itself is exactly the pending post.
  const { since: _since, ...payload } = writes[0].payload;
  assert.deepEqual(payload, { posts: [pendingPost], deletedUrls: [] });
  assert.deepEqual(sorted(retried.posts), retryExpected);
  assert.equal(new Set(retried.posts.map(post => post.id)).size, 8);
  assert.equal(new Set(retried.posts.map(post => post.url)).size, 8);
  assert.deepEqual(retried.deletedUrls, ['https://example.invalid/disposable']);
  await writeFile(join(evidence, 'retry-sqlite.json'), JSON.stringify(retried, null, 2));
  await page.screenshot({ path: join(evidence, 'retry-saved.png') });
  await page.reload(); await saved(8);
  assert.deepEqual(sorted(await posts()), retryExpected);
  expected = retryExpected;
  pass('real SQLite abort: pending note survives reload; explicit Retry sends one exact document, saves only its note/timestamp, preserves 8 unique records and tombstone, and survives reload');

  await detail(first);
  apiOffline = true;
  await page.getByPlaceholder('Your notes…').fill('C4 offline note recovered');
  await status().filter({ hasText: 'Failed to fetch' }).waitFor();
  await page.reload();
  await status().filter({ hasText: 'Failed to fetch' }).waitFor();
  assert.equal(await page.getByPlaceholder('Your notes…').inputValue(), 'C4 offline note recovered');
  assert.deepEqual(sorted((await control('snapshot')).result.posts), expected);
  await page.goto(base + '/library/settings');
  await status().filter({ hasText: 'Failed to fetch' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Re-sync from SQLite', exact: true }).isEnabled(), true);
  const offlinePosts = sorted(await posts());
  const offlineExpected = expected.map(post => post.id === first.id ? { ...post, userNotes: 'C4 offline note recovered', updatedAt: offlinePosts.find(item => item.id === first.id).updatedAt } : post);
  assert.deepEqual(offlinePosts, offlineExpected);
  apiOffline = false;
  await page.getByRole('button', { name: 'Re-sync from SQLite', exact: true }).click();
  await saved(8);
  assert.deepEqual(sorted(await posts()), offlineExpected);
  expected = offlineExpected;
  await stop(); await start();
  await page.context().close(); page = await newPage();
  await page.goto(base + '/library/settings'); await saved(8);
  assert.deepEqual(sorted(await posts()), expected);
  await page.screenshot({ path: join(evidence, 'recovered.png') });
  await writeFile(join(evidence, 'final-sqlite.json'), JSON.stringify((await control('snapshot')).result, null, 2));
  pass('API-offline edit survives reload; Settings retry after reconnection and another restart/fresh browser retain latest note and 8 records');
  assert.deepEqual(errors, []);
  assert.deepEqual(denied, []);
  // /api/enrich is an accepted first-party endpoint (import-time metadata enrichment): same-origin,
  // deterministic fixture response, not a provider/personal/external request. Explicit allowlist only.
  assert.ok(requests.every(r => ['/api/library', '/api/stats', '/api/categories', '/api/categorize', '/api/enrich', '/api/telegram/auth', '/api/ai/providers'].includes(r.path)
    || (r.path === '/api/telegram/config' && r.method === 'GET')));
  pass('no uncaught browser errors, provider requests, personal data or external requests');
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
    await writeFile(join(evidence, 'failure-state.json'), JSON.stringify(await posts().catch(() => []), null, 2));
  }
  throw error;
} finally {
  if (browser) await browser.close();
  await stop();
  await writeFile(join(evidence, 'timeline.json'), JSON.stringify(timeline.sort((a, b) => a.at - b.at), null, 2));
  await writeFile(join(evidence, 'runtime.json'), JSON.stringify({ db, port, events, errors, denied, requests, consoleMessages, stopped: true }, null, 2));
  console.log('CLEANUP owned browser and fixture server closed; evidence', evidence);
}
