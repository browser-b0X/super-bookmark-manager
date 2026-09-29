// G5 integrated acceptance. Only established synthetic exports, owned guarded
// SQLite, a fresh loopback origin and fresh browser contexts may be used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, appendFile, readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidenceRoot = join(root, '.verify/g5-core-acceptance-20260923');
const resumeName = process.env.G5_RESUME;
const retainName = process.env.G5_RETAIN;
const supplemental = retainName ? retainName.split(',') : [];
for (const name of [resumeName, ...supplemental]) assert.ok(!name || /^journey-[a-zA-Z0-9]+$/.test(name));
assert.ok(!retainName || resumeName, 'Supplemental results require the original database journey');
const resumeFrom = resumeName ? join(evidenceRoot, resumeName) : undefined;
const retainedSources = [resumeName, ...supplemental].filter(Boolean);
assert.equal(new Set(retainedSources).size, retainedSources.length);
const retainedByName = new Map();
for (const name of retainedSources) {
  const source = join(evidenceRoot, name);
  if (name !== resumeName) {
    assert.deepEqual(JSON.parse(await readFile(join(source, 'presentation-baseline.json'), 'utf8')), JSON.parse(await readFile(join(resumeFrom, 'presentation-baseline.json'), 'utf8')));
    assert.deepEqual(JSON.parse(await readFile(join(source, 'fixture-hashes.json'), 'utf8')), JSON.parse(await readFile(join(resumeFrom, 'fixture-hashes.json'), 'utf8')));
    const provenance = JSON.parse(await readFile(join(source, 'retained-checks.json'), 'utf8'));
    assert.equal(provenance.db ?? join(provenance.source, 'fixture.sqlite'), join(resumeFrom, 'fixture.sqlite'));
  }
  for (const result of JSON.parse(await readFile(join(source, 'results.json'), 'utf8'))) retainedByName.set(result.name, result);
}
const retainedResults = [...retainedByName.values()].filter(r => r.status === 'PASS');
const retained = new Set(retainedResults.map(r => r.name));
if (retainName) {
  const matrix = JSON.parse(await readFile(join(evidenceRoot, 'acceptance-matrix.json'), 'utf8'));
  assert.deepEqual([...retained].sort(), matrix.groups.filter(group => group.status === 'PASS').map(group => group.name).sort(), 'Retain every recorded passing group without rerunning it');
  assert.ok(retained.size >= 23, 'Renewed G5 must retain all twenty-three passing groups');
}
await mkdir(evidenceRoot, { recursive: true });
const evidence = await mkdtemp(join(evidenceRoot, 'journey-'));
const db = join(resumeFrom || evidence, 'fixture.sqlite');
const python = process.env.G5_PYTHON;
assert.ok(python, 'Set G5_PYTHON to the existing bundled runtime');
const { chromium } = createRequire(import.meta.url)(process.env.G5_PLAYWRIGHT_MODULE || 'playwright');
let server, browser, port = 0, base, page, apiOffline = false, classifierFailure = false, expectedExternal;
const events = [], errors = [], denied = [], requests = [], consoleMessages = [], timeline = [], results = [], imports = [], retrieval = [], externalTargets = [];
const sorted = posts => [...posts].sort((a, b) => a.url.localeCompare(b.url));
const fixture = name => join(root, 'frontend/tests/fixtures', name);
const output = (name, data) => writeFile(join(evidence, name), JSON.stringify(data, null, 2));
const getState = () => page.evaluate(() => JSON.parse(localStorage.getItem('library-store-v1')).state);
const posts = async () => (await getState()).posts;
const status = () => page.getByRole('status', { name: 'SQLite save status' });
const drawer = () => page.getByRole('dialog', { name: 'Saved post detail' });
const searchBox = () => page.getByPlaceholder('Search… ( / )');
const filters = () => page.getByRole('navigation', { name: 'Library filters' });

async function check(name, test) {
  if (retained.has(name)) return;
  try {
    const detail = await test();
    results.push({ name, status: 'PASS', detail });
    await output('results.json', results);
    console.log('PASS ' + name + (typeof detail === 'string' ? ': ' + detail : ''));
    return detail;
  } catch (error) {
    results.push({ name, status: 'FAIL', error: error.message });
    await output('results.json', results);
    throw error;
  }
}
async function start() {
  const child = spawn(python, ['-B', join(root, 'frontend/tests/categorization_fixture.py'), db, String(port)], {
    cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', TELEGRAM_API_ID: '0', TELEGRAM_API_HASH: '', LLM_API_KEY: 'synthetic', LITELLM_PROXY_KEY: 'synthetic' },
  });
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
  port = data.port; base = `http://127.0.0.1:${port}`; events.push(data);
  console.log('Fixture ready ' + JSON.stringify(data));
}
async function control(command) {
  timeline.push({ at: Date.now(), event: 'control-start', command });
  const result = new Promise(resolve => server.pending.set(command, resolve));
  server.child.stdin.write(JSON.stringify({ command }) + '\n');
  const response = await result;
  timeline.push({ at: Date.now(), event: 'control-end', command });
  return response;
}
const snapshot = async () => (await control('snapshot')).result;
async function stop() {
  if (!server) return;
  const child = server.child;
  if (child.exitCode === null) {
    const exited = once(child, 'exit');
    child.stdin.end(JSON.stringify({ command: 'stop' }) + '\n');
    const [code] = await exited;
    assert.equal(code, 0); events.push({ exit: true, pid: child.pid, code });
  }
  server = undefined;
}
async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) {
      if (expectedExternal && request.isNavigationRequest() && url.href === expectedExternal.split('#')[0]) {
        externalTargets.push(url.href);
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Intercepted synthetic source</title>' });
      }
      denied.push(url.href); return route.abort();
    }
    if (url.pathname.startsWith('/api/')) {
      requests.push({ at: Date.now(), path: url.pathname, method: request.method(), body: request.postDataJSON() });
      if (apiOffline) return route.abort('connectionrefused');
      if (url.pathname === '/api/enrich') return route.fulfill({ status: 503, json: { error: 'Synthetic metadata unavailable' } });
      if (classifierFailure && url.pathname === '/api/categorize') return route.fulfill({ status: 503, json: { error: 'Synthetic classifier unavailable' } });
    }
    return route.continue();
  });
  const next = await context.newPage(); next.setDefaultTimeout(10000);
  next.on('pageerror', error => errors.push(error.message));
  next.on('console', message => { if (message.type() === 'error') consoleMessages.push(message.text()); });
  next.on('request', request => {
    if (new URL(request.url()).pathname === '/api/library') timeline.push({ at: Date.now(), event: 'request', method: request.method(), payload: request.postDataJSON() });
  });
  next.on('response', response => {
    if (new URL(response.url()).pathname === '/api/library') timeline.push({ at: Date.now(), event: 'response', method: response.request().method(), status: response.status() });
  });
  await next.exposeFunction('recordG5', entry => timeline.push(entry));
  await next.addInitScript(() => {
    document.addEventListener('click', event => {
      if (!(event.target instanceof Element)) return;
      const state = JSON.parse(localStorage.getItem('library-store-v1') || '{}').state;
      void window.recordG5({ at: Date.now(), event: 'click', button: event.target.closest('button')?.textContent,
        ariaLabel: event.target.closest('button')?.getAttribute('aria-label'), path: location.pathname, pending: state?.pending });
    }, true);
  });
  return next;
}
async function saved(count) {
  await page.waitForFunction(count => {
    const state = JSON.parse(localStorage.getItem('library-store-v1') || '{}').state;
    const panel = document.querySelector('[aria-label="SQLite save status"]');
    return state?.posts.length === count && Object.keys(state.pending).length === 0 && panel?.textContent.includes('Library saved to SQLite');
  }, count);
  const result = await snapshot();
  assert.equal(result.posts.length, count); assert.deepEqual(sorted(result.posts), sorted(await posts()));
  assert.deepEqual(result.blocked, []); assert.equal(result.legacyCount, 0);
  return result;
}
async function classified(count) {
  await page.waitForFunction(count => {
    const state = JSON.parse(localStorage.getItem('library-store-v1') || '{}').state;
    return state?.posts.length === count && state.posts.every(p => ['automatic', 'manual'].includes(p.categoryMode));
  }, count);
  // Metadata-settling alignment with metadata-e2e.mjs waitMetadata(): categorization
  // resolves before the async enrich-on-import write, so gating only on categoryMode
  // lets saved() snapshot SQLite while enrichment is still in flight (transient
  // 'partial' vs settled 'failed'). Under this harness /api/enrich is intercepted to
  // 503 unconditionally, so backendProvider.enrich throws and every import-enriched
  // post deterministically terminates at metadataStatus 'failed'. Wait for that
  // quiescence before the durable comparison; bounded by the page default timeout.
  await page.waitForFunction(count => {
    const state = JSON.parse(localStorage.getItem('library-store-v1') || '{}').state;
    return state?.posts.length === count && state.posts.every(p => p.metadataStatus === 'failed');
  }, count);
  await page.waitForLoadState('networkidle'); await saved(count);
}
async function compare(name, expected, deletedUrls = []) {
  const database = await saved(expected.length);
  const api = await page.evaluate(async () => { const r = await fetch('/api/library'); if (!r.ok) throw new Error('API read failed'); return r.json(); });
  const browserState = await getState();
  assert.deepEqual(sorted(database.posts), sorted(expected));
  assert.deepEqual(sorted(api.posts), sorted(expected));
  assert.deepEqual(sorted(browserState.posts), sorted(expected));
  assert.deepEqual(database.deletedUrls, deletedUrls); assert.deepEqual(api.deletedUrls, deletedUrls);
  assert.equal(new Set(expected.map(p => p.id)).size, expected.length);
  assert.equal(new Set(expected.map(p => p.canonicalUrl)).size, expected.length);
  assert.ok(expected.every(p => new URL(p.url).hostname === 'example.invalid'));
  await output(name, { database, api, browser: browserState });
}
async function importBookmark(name, expectedText, count) {
  await page.getByLabel('Import bookmarks HTML').setInputFiles(fixture(`bookmarks-${name}.html`));
  const result = page.getByRole('status').filter({ hasText: expectedText }); await result.waitFor();
  await classified(count); imports.push({ file: name, text: await result.innerText(), count });
  await output('import-results.json', imports);
}
async function importTelegram(expectedText) {
  await page.getByLabel('Import Telegram JSON').setInputFiles(fixture('telegram-saved-messages.json'));
  const result = page.getByRole('status', { name: 'Telegram import result' }).filter({ hasText: expectedText }); await result.waitFor();
  await classified(8); imports.push({ file: 'telegram', text: await result.innerText(), count: 8 });
  await output('import-results.json', imports);
}
async function reimportAll() {
  await page.goto(base + '/library/settings'); await saved(8);
  await importBookmark('firefox', '0 new, 3 already present', 8);
  await importBookmark('chromium', '0 new, 3 already present', 8);
  await importTelegram('0 new, 4 already present');
}
async function detail(post) { await page.goto(`${base}/library/item/${post.id}`); await drawer().waitFor(); return drawer(); }
async function library() { await page.goto(base + '/library'); await saved(8); await searchBox().waitFor(); }
async function expectResults(expected) {
  await page.waitForFunction(count => document.querySelectorAll('main article').length === count, expected.length);
  const cards = page.locator('main article'); assert.equal(await cards.count(), expected.length);
  for (const p of expected) assert.equal(await cards.filter({ has: page.locator(`a[href="/library/item/${p.id}"]`) }).count(), 1, p.title);
}
async function tabTo(locator, limit = 130) {
  assert.equal(await locator.count(), 1);
  for (let i = 0; i < limit; i++) { if (await locator.evaluate(el => el === document.activeElement)) return; await page.keyboard.press('Tab'); }
  throw new Error('Control unreachable with Tab');
}
const ninthHtml = '<!DOCTYPE NETSCAPE-Bookmark-file-1><TITLE>Fixture</TITLE><H1>Fixture</H1><DL><p><DT><A HREF="https://example.invalid/disposable">Ninth disposable</A></DL><p>';
async function ninth() {
  await page.goto(base + '/library/settings');
  await page.getByLabel('Import bookmarks HTML').setInputFiles({ name: 'ninth.html', mimeType: 'text/html', buffer: Buffer.from(ninthHtml) });
}

try {
  const hashes = {};
  for (const name of ['bookmarks-firefox.html', 'bookmarks-chromium.html', 'telegram-saved-messages.json', 'categorization-cases.json']) {
    hashes[name] = createHash('sha256').update(await readFile(fixture(name))).digest('hex');
  }
  await output('fixture-hashes.json', hashes);
  await start(); browser = await chromium.launch({ headless: true, channel: process.env.G5_BROWSER_CHANNEL || undefined });
  page = await newPage(); await page.goto(base + '/library/settings'); await saved(resumeFrom ? 8 : 0);
  assert.equal((await getState()).demo, false);
  let expected, first, second;
  if (!resumeFrom) {
  await check('C2 actual Settings bookmark imports and repeat imports', async () => {
    await importBookmark('firefox', '3 new, 0 already present, 1 duplicate entries in this file, 1 unsupported-scheme', 3);
    await importBookmark('chromium', '2 new, 1 already present', 5);
    const initial = sorted(await posts());
    const expected = [
      ['https://example.invalid/cooking?course=main&serves=2', 'Cooking & Kitchen — supplied title'],
      ['https://example.invalid/programming#typescript', 'Programming: TypeScript notes'],
      ['http://example.invalid/exercise', 'Exercise routine'], ['https://example.invalid/art', 'Art & drawing ideas'],
      ['https://example.invalid/budgeting', 'Budget planning café'],
    ].sort((a, b) => a[0].localeCompare(b[0]));
    assert.deepEqual(initial.map(p => [p.url, p.title]), expected); assert.ok(initial.every(p => p.source === 'browser'));
    await importBookmark('firefox', '0 new, 3 already present', 5);
    await importBookmark('chromium', '0 new, 3 already present', 5);
    await compare('bookmark-comparison.json', initial);
    return '3 distinct Firefox + 3 distinct Chromium − 1 overlap = 5; duplicate/unsupported/nested titles retained; repeats add zero';
  });
  await check('C2 malformed empty and unsupported bookmark inputs do not mutate', async () => {
    const wrap = body => `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>${body}</DL><p>`;
    const invalid = [['', /empty/], ['<html><a href="https://example.invalid/no-export">Not an export</a></html>', /not a Netscape/],
      ['<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><A HREF="https://example.invalid/truncated">Broken', /malformed/],
      [wrap('<A HREF="https://example.invalid/valid">Valid first</A><A HREF="https://">Invalid second</A>'), /invalid URL/],
      [wrap('<A>Missing URL</A>'), /incomplete link/], [wrap(''), /No bookmarks/],
      [wrap('<A HREF="file:///synthetic-only">Local file</A>'), /No HTTP\(S\).*1 unsupported/],
      [wrap('<A HREF="https://example.invalid/unclosed">Unclosed'), /malformed/]];
    const expected = sorted(await posts()), reports = [];
    for (const [raw, pattern] of invalid) {
      const before = await page.evaluate(() => localStorage.getItem('library-store-v1'));
      await page.getByLabel('Import bookmarks HTML').setInputFiles({ name: 'invalid.html', mimeType: 'text/html', buffer: Buffer.from(raw) });
      const result = page.getByRole('status').filter({ hasText: pattern }); await result.waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem('library-store-v1')), before);
      assert.deepEqual(sorted((await snapshot()).posts), expected); reports.push({ input: raw, result: await result.innerText() });
    }
    await output('bookmark-errors.json', reports); return '8 controlled errors; exact browser and SQLite documents unchanged';
  });
  await check('C3 documented Telegram import preserves complete source association', async () => {
    assert.match(await page.locator('main').innerText(), /Export chat history[\s\S]*Machine-readable JSON[\s\S]*full date range/);
    assert.match(await page.locator('main').innerText(), /All messages in the file are checked; there is no item limit/);
    await importTelegram('3 new, 1 already present; 5 messages checked, 1 without eligible links, 1 duplicate URLs');
    const initial = await posts(), raw = JSON.parse(await readFile(fixture('telegram-saved-messages.json'), 'utf8'));
    const urls = ['https://example.invalid/travel', 'https://example.invalid/programming#typescript', 'https://example.invalid/reference', 'http://example.invalid/no-metadata'];
    for (const [i, messageIndex] of [0, 0, 1, 2].entries()) {
      const p = initial.find(p => p.url === urls[i]), message = raw.messages[messageIndex]; assert.ok(p);
      const text = typeof message.text === 'string' ? message.text : message.text.map(t => typeof t === 'string' ? t : t.text).join('');
      assert.deepEqual(p.telegramMessage, { id: String(message.id), date: message.date, text });
      assert.equal(p.sourceMessageId, String(message.id));
      if (i !== 1) { assert.equal(p.excerpt, text); assert.equal(p.createdAt, message.date); assert.equal(p.source, 'telegram'); }
    }
    assert.equal(initial.filter(p => p.source === 'telegram').length, 3);
    assert.equal(initial.filter(p => p.telegramMessage).length, 4);
    await compare('telegram-comparison.json', initial);
    await reimportAll(); await compare('initial-reimport-comparison.json', initial);
    return '5 messages → 4 links; two from 97001, labeled entity, duplicate/linkless counts; 5 + 4 − 1 = 8, all three repeats still 8';
  });
  await check('C3 malformed supported-invalid unsupported and linkless outcomes preserve state', async () => {
    const wrap = messages => JSON.stringify({ type: 'saved_messages', messages });
    const msg = patch => ({ id: 1, type: 'message', text: '', ...patch });
    const original = JSON.parse(await readFile(fixture('telegram-saved-messages.json'), 'utf8'));
    const invalid = [['', /empty/], ['{', /not valid JSON/], ['null', /Unsupported export/], ['[]', /Unsupported export/], ['{}', /Unsupported export/],
      ['{"messages":{}}', /Unsupported export/], ['{"messages":[null]}', /Malformed/], ['{"messages":[]}', /No messages/],
      ['{"chats":{"list":[]}}', /Unsupported export/], [JSON.stringify({ type: 'personal_chat', messages: [msg({})] }), /Unsupported export/],
      [wrap([msg({ text: null })]), /Malformed/], [wrap([msg({ text: [null] })]), /Malformed/], [wrap([msg({ text_entities: {} })]), /Malformed/],
      [wrap([msg({ text_entities: [null] })]), /Malformed/], [wrap([msg({ text: [{ type: 'text_link', text: 'missing target' }] })]), /Malformed/],
      [wrap([msg({ date: {} })]), /Malformed/], [wrap([msg({ id: {} })]), /Malformed/], [wrap([original.messages[0], null]), /Malformed/],
      [wrap([msg({ text: 'A note only' })]), /0 new, 0 already present; 1 messages checked, 1 without eligible links/]];
    const expected = sorted(await posts()), reports = [];
    for (const [raw, pattern] of invalid) {
      const before = await page.evaluate(() => localStorage.getItem('library-store-v1'));
      await page.getByLabel('Import Telegram JSON').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(raw) });
      const result = page.getByRole('status', { name: 'Telegram import result' }).filter({ hasText: pattern }); await result.waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem('library-store-v1')), before);
      assert.deepEqual(sorted((await snapshot()).posts), expected); reports.push({ input: raw, result: await result.innerText() });
    }
    await output('telegram-errors.json', reports); return '18 controlled errors + linkless outcome; exact browser and SQLite state unchanged';
  });
  await check('C5 automatic local bounded categorization on both import paths', async () => {
    const initial = await posts(), cases = JSON.parse(await readFile(fixture('categorization-cases.json'), 'utf8'));
    const categories = cases.map(item => {
      const post = initial.find(p => new URL(p.url).pathname === item.path); assert.ok(post);
      assert.deepEqual(post.categories, [item.expected]); assert.equal(post.categoryMode, 'automatic'); assert.equal(post.categoryReview, item.expected === 'other');
      return { ...item, id: post.id, actual: post.categories, review: post.categoryReview, source: post.source };
    });
    await output('category-results.json', categories);
    const calls = requests.filter(r => r.path === '/api/categorize');
    assert.ok(calls.length >= 8); assert.ok(calls.every(r => r.body.keywords_only === true && !('tg_msg_id' in r.body)));
    for (const p of initial) assert.ok(calls.some(r => r.body.content.includes(p.url)), p.url);
    const before = await snapshot(); assert.equal(before.shelves.filter(c => !['other', 'uncategorized'].includes(c)).length, 9);
    const invalidWrites = await page.evaluate(async post => {
      const results = [];
      for (const patch of [{ categories: Array.from({ length: 13 }, (_, i) => 'synthetic-extra-' + i), categoryMode: 'manual' },
        { categories: ['synthetic-invented-shelf'], categoryMode: 'automatic' }]) {
        const response = await fetch('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts: [{ ...post, ...patch }], deletedUrls: [] }) });
        results.push({ status: response.status, body: await response.json() });
      }
      return results;
    }, initial[0]);
    assert.ok(invalidWrites.every(r => r.status === 400)); assert.deepEqual(await snapshot(), before);
    await output('category-bounds.json', { shelves: before.shelves, invalidWrites, calls });
    return 'six exact topical matches, two honest other/review; keyword-only requests, no provider calls; nine topical shelves; over-bound/manual and invented/automatic writes rejected atomically';
  });

  await check('C4 curated fields belong to intended records only', async () => {
    const initial = sorted(await posts()); first = initial.find(p => new URL(p.url).pathname === '/cooking'); second = initial.find(p => new URL(p.url).pathname === '/programming');
    let dialog = await detail(first);
    await dialog.getByRole('button', { name: 'food-drink', exact: true }).click(); await dialog.getByRole('button', { name: 'other', exact: true }).click();
    await dialog.getByRole('button', { name: 'Favorite', exact: true }).click(); await dialog.getByRole('button', { name: 'Archived', exact: true }).click();
    await dialog.getByPlaceholder('Your notes…').fill('CuminLedger: G5 cooking note — café'); await saved(8);
    dialog = await detail(second);
    await dialog.getByRole('button', { name: 'technology', exact: true }).click(); await dialog.getByRole('button', { name: 'arts-culture', exact: true }).click();
    // Scope the Status chip to its labelled section: the accepted B4 Related Items
    // row can also be titled "Reference", so a dialog-wide role query is ambiguous.
    const statusSection = dialog.getByText('Status', { exact: true }).locator('xpath=..');
    await statusSection.getByRole('button', { name: 'Reference', exact: true }).click();
    await dialog.getByPlaceholder('Your notes…').fill('LambdaNotebook: G5 programming note\nSecond line');
    await dialog.getByPlaceholder('add tag ⏎').fill('MixedCase'); await dialog.getByPlaceholder('add tag ⏎').press('Enter'); await saved(8);
    assert.deepEqual((await posts()).find(p => p.id === second.id).tags, ['mixedcase']);
    // Existing tag entry normalizes case; exercise preservation/search of a
    // pre-existing mixed-case tag through the supported synthetic SQLite API.
    await page.evaluate(async id => {
      const p = JSON.parse(localStorage.getItem('library-store-v1')).state.posts.find(p => p.id === id);
      const r = await fetch('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posts: [{ ...p, tags: ['ui-tag', 'MixedCase'] }], deletedUrls: [] }) });
      if (!r.ok) throw new Error('Synthetic mixed-case tag setup failed');
    }, second.id);
    await page.goto(base + '/library/settings'); await saved(8); expected = sorted(await posts());
    const a = expected.find(p => p.id === first.id), b = expected.find(p => p.id === second.id);
    assert.deepEqual(a.categories, ['other']); assert.equal(a.categoryMode, 'manual'); assert.equal(a.categoryReview, false);
    assert.equal(a.favorite, true); assert.equal(a.status, 'archived'); assert.equal(a.userNotes, 'CuminLedger: G5 cooking note — café');
    assert.deepEqual(b.categories, ['arts-culture']); assert.equal(b.categoryMode, 'manual'); assert.equal(b.status, 'reference');
    assert.equal(b.userNotes, 'LambdaNotebook: G5 programming note\nSecond line'); assert.deepEqual(b.tags, ['ui-tag', 'MixedCase']);
    const curatedIds = new Set([first.id, second.id]);
    assert.deepEqual(expected.filter(p => !curatedIds.has(p.id)), initial.filter(p => !curatedIds.has(p.id)));
    await output('curation-before.json', expected); await compare('curation-before-comparison.json', expected);
    return 'distinct A/B notes, manual other, corrected topic, favorite/archive/reference and stored MixedCase tag; other six documents unchanged';
  });
  await check('C4 disposable ninth cancel confirm deletion and C5 failed-provider fallback', async () => {
    classifierFailure = true; await ninth(); await classified(9); classifierFailure = false;
    let disposable = (await posts()).find(p => p.url === 'https://example.invalid/disposable');
    assert.deepEqual(disposable.categories, ['other']); assert.equal(disposable.categoryReview, true);
    const dialog = await detail(disposable);
    await dialog.getByRole('button', { name: 'Refresh metadata', exact: true }).click();
    await dialog.getByRole('button', { name: 'Refresh metadata', exact: true }).waitFor(); await saved(9);
    disposable = (await posts()).find(p => p.id === disposable.id);
    // Accepted metadata contract: an unconditional /api/enrich 503 makes backendProvider.enrich
    // throw, and enrich() maps any throw to the terminal state 'failed' with the safe user-facing
    // message (metadataEnrichment.ts:30; proven by metadata-e2e.mjs:246/394). 'partial' is reserved
    // for a SUCCESSFUL fetch that returned no metadata, never for an errored 503.
    assert.equal(disposable.metadataStatus, 'failed'); assert.equal(disposable.metadataError, 'Metadata unavailable. The saved link is unchanged; retry later.');
    assert.match(await dialog.innerText(), /metadata: failed — Metadata unavailable/);
    const beforeCancel = sorted(await posts());
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.deepEqual(sorted(await posts()), beforeCancel); await saved(9);
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click(); await dialog.getByRole('button', { name: 'Confirm delete', exact: true }).click();
    await saved(8); await compare('deletion-comparison.json', expected, [disposable.url]);
    await ninth(); await saved(8); await compare('ninth-reimport-comparison.json', expected, [disposable.url]);
    return 'classifier 503 → other/review; metadata 503 → terminal failed state with honest retry message; cancel exact9, confirm exact8; ninth reimport cannot resurrect';
  });
  await check('C4 reload owned backend restart fresh browser and three-file reimport exact recovery', async () => {
    const deleted = ['https://example.invalid/disposable'];
    await page.reload(); await compare('after-reload.json', expected, deleted);
    await stop(); await start(); await page.reload(); await compare('after-restart.json', expected, deleted);
    await page.context().close(); page = await newPage(); await page.goto(base + '/library/settings'); await compare('after-fresh-browser.json', expected, deleted);
    await ninth(); await saved(8); await reimportAll();
    await page.getByRole('button', { name: 'Re-sync from SQLite', exact: true }).click(); await saved(8);
    await compare('after-reimport-resync.json', expected, deleted);
    return 'exact eight full documents + tombstone in fresh browser/API/SQLite after every recovery stage; manual categories retain priority';
  });
  await check('C4 failed write pending reload and explicit Retry changes only intended note', async () => {
    await page.goto(base + '/library/settings'); await saved(8); await control('fail-on');
    await detail(first); await drawer().getByPlaceholder('Your notes…').fill('CuminLedger: G5 failed-write note');
    await status().filter({ hasText: 'Changes were not saved' }).waitFor();
    assert.match(await status().innerText(), /1 change pending SQLite save/); assert.doesNotMatch(await status().innerText(), /Library saved to SQLite/);
    assert.deepEqual(sorted((await snapshot()).posts), expected);
    await page.reload(); await status().filter({ hasText: 'Changes were not saved' }).waitFor();
    assert.equal(await drawer().getByPlaceholder('Your notes…').inputValue(), 'CuminLedger: G5 failed-write note');
    const navigationWrite = page.waitForResponse(r => new URL(r.url()).pathname === '/api/library' && r.request().method() === 'POST' && r.status() === 503);
    await drawer().getByRole('button', { name: 'Close', exact: true }).click(); await page.waitForURL(base + '/library/settings'); await navigationWrite;
    await status().filter({ hasText: 'Changes were not saved' }).waitFor();
    const retry = status().getByRole('button', { name: 'Retry SQLite save' }); assert.equal(await retry.isEnabled(), true);
    const state = await getState(); assert.deepEqual(Object.keys(state.pending), [first.url]);
    const pendingPost = state.pending[first.url];
    const retryExpected = expected.map(p => p.id === first.id ? { ...p, userNotes: 'CuminLedger: G5 failed-write note', updatedAt: pendingPost.updatedAt } : p);
    assert.deepEqual(sorted(state.posts), retryExpected); assert.deepEqual(sorted((await snapshot()).posts), expected);
    const boundary = timeline.length;
    await control('fail-off'); await retry.click(); await saved(8);
    const after = timeline.slice(boundary), click = after.find(e => e.event === 'click' && e.ariaLabel === 'Retry SQLite save');
    const writes = after.filter(e => e.event === 'request' && e.method === 'POST');
    assert.ok(click); assert.deepEqual(click.pending, { [first.url]: pendingPost }); assert.equal(writes.length, 1);
    assert.ok(writes[0].at >= click.at); assert.deepEqual(writes[0].payload, { posts: [pendingPost], deletedUrls: [] });
    expected = retryExpected; await compare('retry-comparison.json', expected, ['https://example.invalid/disposable']);
    await page.reload(); await compare('retry-after-reload.json', expected, ['https://example.invalid/disposable']);
    return 'real SQLite abort retained pending note; explicit Retry precedes one exact POST; only A note/timestamp changes';
  });
  await check('C4 offline cached edit reload reconnect and exact restart recovery', async () => {
    await detail(first); apiOffline = true;
    await drawer().getByPlaceholder('Your notes…').fill('CuminLedger: G5 offline note recovered');
    await status().filter({ hasText: 'Failed to fetch' }).waitFor(); await page.reload(); await status().filter({ hasText: 'Failed to fetch' }).waitFor();
    assert.equal(await drawer().getByPlaceholder('Your notes…').inputValue(), 'CuminLedger: G5 offline note recovered');
    assert.deepEqual(sorted((await snapshot()).posts), expected);
    await page.goto(base + '/library'); await status().filter({ hasText: 'Failed to fetch' }).waitFor();
    await searchBox().fill('TypeScript notes'); await expectResults([second]);
    await page.goto(base + '/library/settings'); await status().filter({ hasText: 'Failed to fetch' }).waitFor();
    const state = await getState(); const offlineExpected = expected.map(p => p.id === first.id ? { ...p, userNotes: 'CuminLedger: G5 offline note recovered', updatedAt: state.posts.find(q => q.id === p.id).updatedAt } : p);
    assert.deepEqual(sorted(state.posts), offlineExpected); apiOffline = false;
    await page.getByRole('button', { name: 'Re-sync from SQLite', exact: true }).click(); await saved(8); expected = offlineExpected;
    await stop(); await start(); await page.context().close(); page = await newPage(); await page.goto(base + '/library/settings');
    await compare('offline-recovery-comparison.json', expected, ['https://example.invalid/disposable']);
    return 'cached note and searchable library survive API outage/reload; reconnect re-sync + owned restart/fresh browser recover exact8';
  });

  await check('C6 home search keyboard route and deep-link refresh', async () => {
    await page.goto(base + '/'); await saved(8);
    const search = page.getByRole('button', { name: /Search or jump to/ }); assert.equal(await search.isVisible(), true);
    await tabTo(search); await page.keyboard.press('Enter'); const palette = page.getByRole('dialog', { name: 'Command palette' }); await palette.waitFor();
    assert.equal(await palette.getByRole('textbox').evaluate(el => el === document.activeElement), true);
    await page.keyboard.type('TypeScript notes'); await palette.getByRole('button', { name: /Programming: TypeScript notes/ }).waitFor(); await page.keyboard.press('Enter');
    await drawer().waitFor(); assert.equal(new URL(page.url()).pathname, '/library/item/' + second.id);
    await page.reload(); await drawer().waitFor(); await saved(8); return 'visible home search → Tab/Enter/query/Enter → exact local detail; refresh retains detail';
  });
  await check('C6 independent title exact URL domain tag and distinct-note searches', async () => {
    const a = expected.find(p => p.id === first.id), b = expected.find(p => p.id === second.id);
    const queries = [['title', 'TypeScript notes', [b]], ['exact URL', a.url, [a]], ['domain', 'example.invalid', expected],
      ['mixed-case tag', 'mIxEdCaSe', [b]], ['note A', 'cuminledger', [a]], ['note B', 'lambdanotebook', [b]]];
    for (const [name, query, matches] of queries) { await library(); await searchBox().fill(query); await expectResults(matches); retrieval.push({ name, query, ids: matches.map(p => p.id) }); }
    await page.screenshot({ path: join(evidence, 'g5-library-filtered.png') }); await output('retrieval-results.json', retrieval);
    return 'all six independent searches return exact expected sets (shared fixture domain returns all8)';
  });
  await check('C6 category favorite archive status filters and clear to eight', async () => {
    for (const [name, label, matches] of [['category', /^other /, expected.filter(p => p.categories.includes('other'))],
      ['favorite', /^Favorites /, expected.filter(p => p.favorite)], ['archive', /^Archived /, expected.filter(p => p.status === 'archived')],
      ['status', /^Reference /, expected.filter(p => p.status === 'reference')]]) {
      await library(); await filters().getByRole('button', { name: label }).click(); await expectResults(matches); retrieval.push({ name, ids: matches.map(p => p.id) });
    }
    await library(); await filters().getByRole('button', { name: /^Favorites / }).click(); await searchBox().fill('cuminledger'); await expectResults([first]);
    await searchBox().fill(''); await filters().getByRole('button', { name: /^All saved / }).click(); await expectResults(expected);
    await output('retrieval-results.json', retrieval);
    return 'each filter exact; clearing combined search/favorite restores eight including archived';
  });
  await check('C6 two-item detail note isolation and keyboard search open edit original source', async () => {
    const aNote = expected.find(p => p.id === first.id).userNotes;
    await detail(first); assert.equal(await drawer().getByPlaceholder('Your notes…').inputValue(), aNote);
    await drawer().getByRole('button', { name: second.title, exact: true }).click();
    assert.equal(await drawer().getByPlaceholder('Your notes…').inputValue(), expected.find(p => p.id === second.id).userNotes);
    await drawer().getByPlaceholder('Your notes…').fill('LambdaNotebook: G5 isolated programming edit');
    await drawer().getByRole('button', { name: first.title, exact: true }).click();
    assert.equal(await drawer().getByPlaceholder('Your notes…').inputValue(), aNote);
    await drawer().getByRole('button', { name: second.title, exact: true }).click();
    assert.equal(await drawer().getByPlaceholder('Your notes…').inputValue(), 'LambdaNotebook: G5 isolated programming edit'); await saved(8);
    await library(); await tabTo(searchBox()); await page.keyboard.type('TypeScript notes'); await expectResults([second]);
    const opener = page.locator('main').getByRole('link', { name: second.title, exact: true }); await tabTo(opener); await page.keyboard.press('Enter'); await drawer().waitFor();
    await tabTo(drawer().getByPlaceholder('Your notes…')); await page.keyboard.press('Control+A'); await page.keyboard.type('LambdaNotebook: G5 keyboard edited programming'); await saved(8);
    const source = drawer().getByRole('link', { name: 'Open source', exact: true });
    assert.equal(await source.getAttribute('href'), second.url); assert.equal(await source.getAttribute('target'), '_blank');
    await tabTo(source); expectedExternal = second.url; const popupReady = page.waitForEvent('popup'); await page.keyboard.press('Enter');
    const popup = await popupReady; await popup.waitForLoadState(); assert.equal(popup.url(), second.url); await popup.close(); expectedExternal = undefined; await saved(8);
    const actual = sorted(await posts()), oldB = expected.find(p => p.id === second.id), newB = actual.find(p => p.id === second.id);
    const expectedB = { ...oldB, userNotes: 'LambdaNotebook: G5 keyboard edited programming', lastOpenedAt: newB.lastOpenedAt, updatedAt: newB.updatedAt };
    assert.ok(newB.lastOpenedAt); assert.deepEqual(newB, expectedB);
    assert.deepEqual(actual.filter(p => p.id !== second.id), expected.filter(p => p.id !== second.id)); expected = actual;
    await page.screenshot({ path: join(evidence, 'g5-detail-curated.png') }); await compare('after-c6-comparison.json', expected, ['https://example.invalid/disposable']);
    return 'A/B related navigation preserves ownership; Tab/type/Enter search/detail/note/original URL; locally intercepted exact popup; only B intended note/open timestamps change';
  });

  } else {
    expected = JSON.parse(await readFile(join(resumeFrom, 'presentation-baseline.json'), 'utf8'));
    await compare('continuation-entry-comparison.json', expected, ['https://example.invalid/disposable']);
    await output('retained-checks.json', { sources: retainedSources, db, results: retainedResults });
  }
  await output('presentation-baseline.json', expected);
  const { verifyPresentation } = await import('./core-presentation.mjs');
  await verifyPresentation({ page, browser, origin: base, evidenceDir: evidence, baseline: expected, getState, saved, snapshot,
    setApiOffline: value => { apiOffline = value; }, check });
  await check('G5 final all-source reimport browser API SQLite exact preservation', async () => {
    apiOffline = false; await page.setViewportSize({ width: 1365, height: 900 });
    await page.goto(base + '/library/settings'); await saved(8);
    await compare('after-presentation-comparison.json', expected, ['https://example.invalid/disposable']);
    await reimportAll(); await ninth(); await saved(8);
    await compare('final-comparison.json', expected, ['https://example.invalid/disposable']);
    await output('curation-after.json', sorted(await posts()));
    assert.deepEqual(sorted(await posts()), expected);
    return 'final reimport Firefox/Chromium/Telegram adds zero; exact8 unique canonical URLs/IDs/documents, complete latest curation and deleted9 tombstone across browser/API/SQLite';
  });
  await check('G5 fixture isolation and runtime errors', async () => {
    assert.deepEqual(errors, []); assert.deepEqual(denied, []);
    assert.ok(requests.every(r => ['/api/library', '/api/stats', '/api/categories', '/api/categorize', '/api/enrich', '/api/telegram/auth', '/api/telegram/config'].includes(r.path)));
    assert.deepEqual((await snapshot()).blocked, []);
    return 'zero uncaught browser errors, forbidden API calls, outbound requests or fixture guard violations';
  });
} catch (error) {
  await output('failure.json', { message: error.message, stack: error.stack, failureCaptureOmitted: !!retainName });
  if (page && !page.isClosed()) {
    if (!retainName) await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
    await output('failure-state.json', await getState().catch(() => ({})));
  }
  throw error;
} finally {
  if (browser) await browser.close();
  await stop();
  await output('timeline.json', timeline.sort((a, b) => a.at - b.at));
  await output('runtime.json', { db, port, events, errors, denied, externalTargets, requests, consoleMessages, results, stopped: true });
  console.log('CLEANUP owned browser and guarded fixture closed; evidence ' + evidence);
}
