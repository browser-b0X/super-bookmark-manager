import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { appendFile, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';

const root = fileURLToPath(new URL('../../', import.meta.url));
assert.equal(resolve(process.cwd()).toLowerCase(), resolve(root).toLowerCase(), 'Run with explicit project-root cwd');
const evidence = join(root, '.verify/metadata-enrichment-20260924');
const output = await mkdtemp(join(evidence, 'e2e-'));
const python = process.env.C6_PYTHON || 'python';
const playwright = process.env.C6_PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = createRequire(import.meta.url)(playwright);
const fixture = 'http://metadata.fixture.test';
const report = { started: new Date().toISOString(), output, checks: [], requests: [], responses: [], events: [],
  snapshots: [], screenshots: [], denied: [], errors: [], limitations: [
    'Synthetic HTTP/DNS/IP pinning fixture, not live provider or TLS verification.',
    'Categories and Telegram refresh payload are deterministic mocks; real fake-client B1 verification is separate.',
    'Saved Views are browser-only and are not expected in a new browser profile.',
    'No source parser/store changes; no personal data, existing services or dependencies accessed.',
  ] };
const pending = new Map();
let child, childClosed, browser, context, page, base, ready, sequence = 0, gate;
const responseTasks = [];
const sorted = posts => [...posts].sort((a, b) => a.id.localeCompare(b.id));
// Fields enrichment itself writes (including its provenance bookkeeping).
const metadataKeys = new Set(['title', 'description', 'thumbnailUrl', 'metadataStatus', 'metadataError', 'updatedAt',
  'enrichedAt', 'linkStatus', 'metadataAttempts', 'faviconUrl', 'siteName']);
const ownSources = sources => sources && Object.fromEntries(Object.entries(sources).filter(([, from]) => from !== 'fetched'));
const withoutMetadata = post => Object.fromEntries(Object.entries(post).filter(([key]) => !metadataKeys.has(key))
  .map(([key, value]) => [key, key === 'fieldSources' ? ownSources(value) : value]));
const CACHED_THUMB = /^\/thumb\/img_[0-9a-f]+$/;
const stable = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function bound(promise, ms, name) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(name + ' timed out')), ms); })])
    .finally(() => clearTimeout(timer));
}
function control(command) {
  const id = ++sequence;
  return bound(new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, command }) + '\n', error => { if (error) reject(error); });
  }), 8000, command).finally(() => pending.delete(id));
}
const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('library-store-v1')).state);
async function saved(count) {
  await page.getByRole('status', { name: 'SQLite save status' }).filter({ hasText: /^Library saved to SQLite$/ }).waitFor();
  await page.waitForFunction(count => {
    const s = JSON.parse(localStorage.getItem('library-store-v1')).state;
    return s.posts.length === count && Object.keys(s.pending).length === 0;
  }, count);
}
async function snapshot(name, count, expectedViews) {
  await saved(count);
  const local = await state();
  const sqlite = (await control('snapshot')).result;
  const api = await page.evaluate(async () => (await (await fetch('/api/library')).json()));
  assert.deepEqual(sorted(local.posts), sorted(sqlite.posts), name + ': browser/SQLite');
  assert.deepEqual(sorted(api.posts), sorted(sqlite.posts), name + ': API/SQLite');
  assert.deepEqual([...local.deletedUrls].sort(), [...sqlite.deletedUrls].sort());
  assert.deepEqual([...api.deletedUrls].sort(), [...sqlite.deletedUrls].sort());
  assert.equal(sqlite.legacyCount, 0);
  assert.deepEqual(sqlite.blocked, []);
  if (expectedViews) assert.deepEqual(local.views, expectedViews);
  report.snapshots.push({ name, browser: local.posts, views: local.views, pending: local.pending, api, sqlite });
  return sorted(local.posts);
}
function pass(name, detail) { report.checks.push({ name, status: 'PASS', detail }); console.log('PASS', name); }
async function screenshot(name) {
  await page.screenshot({ path: join(output, name), animations: 'disabled' });
  report.screenshots.push(name);
}
async function hashes() {
  const indexPath = join(root, 'frontend/dist/index.html');
  const index = await readFile(indexPath, 'utf8');
  const names = ['frontend/dist/index.html', ...[...index.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(m => 'frontend/dist' + m[1]),
    'frontend/tests/metadata-e2e.mjs', 'frontend/tests/metadata_e2e_fixture.py', 'frontend/tests/metadata_fixture.py',
    'app.py', 'safe_http.py', 'metadata_fetcher.py', 'frontend/src/lib/providers.ts', 'frontend/src/lib/metadataEnrichment.ts',
    'frontend/src/lib/importCategorization.ts', 'frontend/src/store/library.ts', 'frontend/src/lib/bookmarks.ts',
    'frontend/src/lib/chromiumBookmarks.ts', 'frontend/src/lib/telegram.ts'];
  const result = {};
  for (const name of names) result[name] = { sha256: createHash('sha256').update(await readFile(join(root, name))).digest('hex'),
    mtime: (await stat(join(root, name))).mtime.toISOString() };
  return result;
}
async function newContext() {
  const ctx = await browser.newContext({ viewport: { width: 1365, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await ctx.route('**/*', async route => {
    try {
      const request = route.request();
      const url = new URL(request.url());
      if (url.href === ready.preview && request.resourceType() === 'image') {
        report.events.push({ kind: 'synthetic-browser-image', url: url.href });
        return await route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(ready.png, 'base64') });
      }
      if (url.origin !== base) { report.denied.push(url.href); return await route.abort(); }
      if (url.pathname === '/api/enrich' && gate && request.postDataJSON().url === gate.url) {
        const active = gate;
        active.started.resolve();
        await active.release.promise;
      }
      await route.continue();
    } catch (error) {
      report.errors.push('route: ' + error.message);
      await route.abort().catch(() => {});
    }
  });
  const tab = await ctx.newPage();
  tab.setDefaultTimeout(15000);
  tab.on('pageerror', error => report.errors.push(error.message));
  tab.on('request', request => report.requests.push({ at: Date.now(), url: request.url(), method: request.method(), body: request.postData() }));
  tab.on('response', response => {
    if (!response.url().includes('/api/')) return;
    responseTasks.push((async () => {
      const entry = { url: response.url(), status: response.status(), body: await response.json().catch(() => null) };
      report.responses.push(entry);
    })());
  });
  return { ctx, tab };
}
const html = items => '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>'
  + items.map(([path, title]) => `<DT><A HREF="${path.startsWith('http') ? path : fixture + path}">${title}</A>`).join('') + '</DL><p>';
const htmlFile = items => ({ name: 'synthetic-bookmarks.html', mimeType: 'text/html', buffer: Buffer.from(html(items)) });
const initialHtml = htmlFile([['/html', 'Owner HTML title'], ['/failure', 'Owner failure title'],
  ['/empty', 'Owner no-metadata title'], ['/classify-failure', 'Owner classification failure title']]);
const chromiumFile = { name: 'Bookmarks', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ roots: {
  bookmark_bar: { type: 'folder', children: [{ type: 'folder', children: [{ type: 'url', url: fixture + '/chromium', name: 'Owner Chromium title' }] }] },
} })) };
const telegramFile = { name: 'result.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ messages: [
  { id: 81003, type: 'message', date: '2026-09-24T11:00:00', text: 'Synthetic Telegram caption ' + fixture + '/telegram' },
] })) };
async function waitMetadata(url, status) {
  await page.waitForFunction(({ url, status }) => JSON.parse(localStorage.getItem('library-store-v1')).state.posts
    .find(p => p.url === url)?.metadataStatus === status, { url, status });
}
async function openDetail(post) {
  // Navigate through the actual card link, not a source-module/store import.
  await page.goto(base + '/library');
  const link = page.locator(`main a[href="/library/item/${post.id}"]`);
  await link.focus(); // the title link sits in the tile's hover panel
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Saved post detail' });
  await dialog.waitFor();
  return dialog;
}
async function curate(post, note) {
  const dialog = await openDetail(post);
  await dialog.locator('textarea').fill(note);
  if (!post.favorite) await dialog.getByTitle('Favorite', { exact: true }).click();
  for (const category of post.categories) await dialog.getByRole('button', { name: category, exact: true }).click();
  await dialog.getByRole('button', { name: 'other', exact: true }).click();
  const tag = dialog.getByPlaceholder('add tag ⏎');
  await tag.fill('metadata-owner'); await tag.press('Enter');
  if (post.status !== 'archived') await dialog.getByRole('button', { name: 'Archive', exact: true }).click();
  await dialog.getByTitle('Close', { exact: true }).click();
}
const enrichCount = () => report.requests.filter(r => new URL(r.url).pathname === '/api/enrich').length;

try {
  report.before = await hashes();
  const readySignal = deferred();
  child = spawn(python, ['-B', join(root, 'frontend/tests/metadata_e2e_fixture.py'), join(output, 'fixture.sqlite')], {
    cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      TEMP: output, TMP: output, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8',
      TELEGRAM_API_ID: '0', TELEGRAM_API_HASH: '', MAX_MESSAGES: '200' },
  });
  childClosed = new Promise(resolve => child.once('close', (code, signal) => {
    for (const handler of pending.values()) handler.reject(new Error('Owned fixture closed'));
    resolve({ code, signal });
    readySignal.resolve({ failed: 'Fixture exited before ready: ' + code });
  }));
  child.on('error', error => { report.errors.push(error.message); readySignal.resolve({ failed: error.message }); });
  child.stderr.on('data', bytes => { responseTasks.push(appendFile(join(output, 'server.txt'), bytes)); });
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const data = JSON.parse(line);
      report.events.push(data.ready ? { ...data, png: '(valid synthetic PNG omitted from log)' } : data);
      if (data.ready) readySignal.resolve(data);
      if (data.id) pending.get(data.id)?.resolve(data);
      if (data.controlError) report.errors.push(data.controlError);
    } catch (error) { report.errors.push('fixture stdout: ' + error.message); }
  });
  ready = await bound(readySignal.promise, 20000, 'fixture readiness');
  assert.ok(!ready.failed, ready.failed);
  base = `http://127.0.0.1:${ready.port}`;
  report.origin = base;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  ({ ctx: context, tab: page } = await newContext());
  await page.goto(base + '/library/settings'); await saved(0);
  assert.equal(enrichCount(), 0);
  assert.deepEqual((await control('events')).httpRequests, []);
  pass('Startup and Settings do not enrich an empty synthetic library');

  // The first import remains usable even when SQLite writes fail. Neither
  // classification nor metadata may run until the durable write succeeds.
  await control('fail-on');
  await page.getByLabel('Import bookmarks HTML').setInputFiles(initialHtml);
  await page.getByRole('status').filter({ hasText: 'Bookmark import complete — 4 new' }).waitFor();
  await page.getByRole('button', { name: 'Retry SQLite save', exact: true }).waitFor();
  assert.equal((await state()).posts.length, 4);
  assert.ok(Object.keys((await state()).pending).length);
  assert.deepEqual((await control('snapshot')).result.posts, []);
  assert.equal(enrichCount(), 0);
  assert.equal((await control('events')).events.filter(e => e.kind === 'categorize').length, 0);
  await screenshot('pending-import.png');
  pass('HTML imports immediately; failed SQLite save is honest and blocks categorize/enrich');

  gate = { url: fixture + '/html', started: deferred(), release: deferred() };
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Retry SQLite save', exact: true }).waitFor();
  await control('fail-off');
  await page.getByRole('button', { name: 'Retry SQLite save', exact: true }).click();
  await bound(gate.started.promise, 15000, 'new HTML metadata request');
  // Categorization reaches SQLite through the next delta sync, which may land
  // after enrichment has started; wait for it rather than assume an order.
  let durableBefore;
  for (let i = 0; i < 50; i += 1) {
    durableBefore = (await control('snapshot')).result.posts.find(p => p.url === gate.url);
    if (durableBefore?.categoryMode === 'automatic') break;
    await new Promise(r => setTimeout(r, 200));
  }
  assert.equal(durableBefore.categoryMode, 'automatic');
  assert.deepEqual(durableBefore.categories, ['technology']);
  // Do not navigate/reload: keep this request owned by the live document.
  await page.getByTitle('Every saved link, archived ones included', { exact: true }).click();
  const htmlPost = (await state()).posts.find(p => p.url === gate.url);
  const firstCard = page.locator(`article[data-post-id="${htmlPost.id}"]`);
  await firstCard.getByLabel('No content preview available').waitFor();
  // The title link sits in the tile's hover panel; open it from the keyboard.
  await firstCard.locator(`a[href="/library/item/${htmlPost.id}"]`).focus();
  await page.keyboard.press('Enter');
  let dialog = page.getByRole('dialog', { name: 'Saved post detail' });
  assert.equal(await dialog.getByRole('link', { name: 'Open source', exact: true }).getAttribute('href'), gate.url);
  await dialog.locator('textarea').fill('Owner note typed while metadata is in flight');
  const inflight = (await state()).posts.find(p => p.id === htmlPost.id);
  gate.release.resolve(); gate = undefined;
  await waitMetadata(fixture + '/html', 'enriched');
  await dialog.getByText('Synthetic HTML description & detail.', { exact: true }).waitFor();
  await screenshot('html-drawer.png');
  await dialog.getByTitle('Close', { exact: true }).click();
  await waitMetadata(fixture + '/failure', 'failed');
  await waitMetadata(fixture + '/classify-failure', 'enriched');
  let posts = await snapshot('html-import', 4);
  const enrichedHtml = posts.find(p => p.id === htmlPost.id);
  assert.equal(enrichedHtml.title, 'Owner HTML title');
  assert.deepEqual(withoutMetadata(enrichedHtml), withoutMetadata(inflight));
  assert.equal(enrichedHtml.description, 'Synthetic HTML description & detail.');
  assert.match(enrichedHtml.thumbnailUrl, CACHED_THUMB); // previews are cached locally
  assert.equal(enrichedHtml.metadataError, undefined);
  const failure = posts.find(p => p.url === fixture + '/failure');
  assert.equal(failure.title, 'Owner failure title');
  assert.equal(failure.description, undefined); assert.equal(failure.thumbnailUrl, undefined);
  assert.equal(failure.metadataError, 'Metadata unavailable. The saved link is unchanged; retry later.');
  const empty = posts.find(p => p.url === fixture + '/empty');
  assert.equal(empty.metadataStatus, 'none'); // 'site offers none' assert.equal(empty.metadataError, undefined);
  assert.equal(empty.title, 'Owner no-metadata title'); assert.equal(empty.thumbnailUrl, undefined);
  const classifierFailed = posts.find(p => p.url === fixture + '/classify-failure');
  assert.deepEqual(classifierFailed.categories, ['other']); assert.equal(classifierFailed.categoryReview, true);
  assert.equal(classifierFailed.metadataStatus, 'enriched');
  pass('Real metadata after durable classification; meaningful title/note preserved; failure/empty honest; classifier failure independent');

  await page.goto(base + '/library/settings');
  await page.getByLabel('Select copied Chromium Bookmarks file').setInputFiles(chromiumFile);
  await page.getByRole('status', { name: 'Chromium import result' }).filter({ hasText: '1 new' }).waitFor();
  await waitMetadata(fixture + '/chromium', 'enriched');
  await page.getByLabel('Import Telegram JSON').setInputFiles(telegramFile);
  await page.getByRole('status', { name: 'Telegram import result' }).filter({ hasText: '1 new' }).waitFor();
  await waitMetadata(fixture + '/telegram', 'enriched');
  await page.getByRole('button', { name: 'Refresh Telegram Saved Messages', exact: true }).click();
  await page.getByRole('status', { name: 'Telegram refresh result' }).filter({ hasText: '1 new links' }).waitFor();
  await waitMetadata(fixture + '/refresh', 'enriched');
  await page.getByLabel('Import bookmarks HTML').setInputFiles(htmlFile([[ready.instagram, 'Owner Instagram title']]));
  await page.getByRole('status').filter({ hasText: 'Bookmark import complete — 1 new' }).waitFor();
  await waitMetadata(ready.instagram, 'enriched');
  posts = await snapshot('all-imports', 8);
  for (const [path, title, description, source] of [
    ['/chromium', 'Owner Chromium title', 'Synthetic Chromium description & detail.', 'browser'],
    ['/telegram', 'Fetched Telegram title', 'Synthetic Telegram description & detail.', 'telegram'],
    ['/refresh', 'Fetched Refresh title', 'Synthetic Refresh description & detail.', 'telegram'],
  ]) {
    const p = posts.find(p => p.url === fixture + path);
    assert.equal(p.title, title); assert.equal(p.description, description); assert.equal(p.source, source);
    assert.match(p.thumbnailUrl, CACHED_THUMB); assert.equal(p.metadataStatus, 'enriched');
    assert.equal(p.metadataError, undefined); assert.equal(p.categoryMode, 'automatic');
    if (source === 'telegram') { assert.ok(p.telegramMessage.text.includes('Synthetic')); assert.equal(p.excerpt, p.telegramMessage.text); }
  }
  assert.equal(posts.find(p => p.url === ready.instagram).thumbnailUrl, '/thumb/SyntheticIG123');
  pass('HTML/Chromium JSON/Telegram JSON/mock refresh durably enriched; generated Telegram titles filled; Instagram cache isolated');

  await curate(failure, 'Owner failure note; retry must preserve');
  await saved(8);
  await page.getByRole('button', { name: 'Saved Views', exact: true }).click();
  const viewsDialog = page.getByRole('dialog', { name: 'Saved Views', exact: true });
  await viewsDialog.getByLabel('View name').fill('Metadata preservation');
  await viewsDialog.getByRole('button', { name: 'Save current', exact: true }).click();
  await viewsDialog.getByRole('status').filter({ hasText: 'View saved.' }).waitFor();
  await viewsDialog.getByRole('button', { name: 'Close', exact: true }).click();
  const views = stable((await state()).views);
  assert.equal(views.length, 1);
  const curated = await snapshot('curated-with-view', 8, views);
  const curatedFailure = curated.find(p => p.id === failure.id);
  assert.deepEqual(curatedFailure.categories, ['other']); assert.equal(curatedFailure.categoryMode, 'manual');
  assert.equal(curatedFailure.categoryReview, false); assert.equal(curatedFailure.favorite, true);
  assert.equal(curatedFailure.status, 'archived'); assert.deepEqual(curatedFailure.tags, ['metadata-owner']);
  for (const post of curated.filter(p => p.thumbnailUrl)) {
    const card = page.locator(`article[data-post-id="${post.id}"]`);
    await card.scrollIntoViewIfNeeded();
    await card.locator('img').waitFor();
    await page.waitForFunction(id => {
      const image = document.querySelector(`article[data-post-id="${id}"] img`);
      return image?.complete && image.naturalWidth >= 128 && image.naturalHeight >= 80 && image.classList.contains('is-loaded');
    }, post.id);
  }
  for (const post of [failure, empty]) await page.locator(`article[data-post-id="${post.id}"]`).getByLabel('No content preview available').waitFor();
  await screenshot('metadata-cards.png');
  pass('Real PNG previews decode (including local Instagram); no-image fallback; curated failure and Saved View established');

  const countBeforeDuplicates = enrichCount();
  const networkBeforeDuplicates = (await control('events')).httpRequests.length;
  await page.goto(base + '/library/settings');
  await page.getByLabel('Import bookmarks HTML').setInputFiles(initialHtml);
  await page.getByRole('status').filter({ hasText: 'Bookmark import complete — 0 new' }).waitFor();
  await page.getByLabel('Select copied Chromium Bookmarks file').setInputFiles(chromiumFile);
  await page.getByRole('status', { name: 'Chromium import result' }).filter({ hasText: '0 new' }).waitFor();
  await page.getByLabel('Import Telegram JSON').setInputFiles(telegramFile);
  await page.getByRole('status', { name: 'Telegram import result' }).filter({ hasText: '0 new' }).waitFor();
  await page.getByRole('button', { name: 'Refresh Telegram Saved Messages', exact: true }).click();
  await page.getByRole('status', { name: 'Telegram refresh result' }).filter({ hasText: '0 new links' }).waitFor();
  assert.deepEqual(await snapshot('duplicates', 8, views), curated);
  assert.equal(enrichCount(), countBeforeDuplicates);
  assert.equal((await control('events')).httpRequests.length, networkBeforeDuplicates);
  pass('Duplicate imports and mock refresh retain complete documents/views and make zero extra metadata requests');

  await page.reload(); assert.deepEqual(await snapshot('reload', 8, views), curated);
  assert.equal(enrichCount(), countBeforeDuplicates);
  await context.close(); report.firstContextClosed = true;
  ({ ctx: context, tab: page } = await newContext());
  await page.goto(base + '/library');
  assert.deepEqual(await snapshot('fresh-browser', 8, []), curated);
  assert.equal(enrichCount(), countBeforeDuplicates);
  assert.equal((await control('events')).httpRequests.length, networkBeforeDuplicates);
  pass('Reload and fresh browser restore all metadata/curation exactly from SQLite; startup does not enrich; Views remain profile-local');

  const recovery = await control('recover');
  report.events.push({ kind: 'wait-real-production-cooldown', milliseconds: recovery.retryAfterMs });
  if (recovery.retryAfterMs) await delay(recovery.retryAfterMs);
  dialog = await openDetail(curatedFailure);
  await dialog.getByRole('button', { name: 'Refresh metadata', exact: true }).click();
  await waitMetadata(fixture + '/failure', 'enriched');
  await dialog.getByText('Synthetic Recovered description & detail.', { exact: true }).waitFor();
  await screenshot('retry-recovered.png');
  await dialog.getByTitle('Close', { exact: true }).click();
  const recovered = await snapshot('detail-retry', 8, []);
  const recoveredFailure = recovered.find(p => p.id === failure.id);
  assert.deepEqual(withoutMetadata(recoveredFailure), withoutMetadata(curatedFailure));
  assert.equal(recoveredFailure.title, curatedFailure.title);
  assert.equal(recoveredFailure.metadataError, undefined); assert.match(recoveredFailure.thumbnailUrl, CACHED_THUMB);
  for (const post of curated.filter(p => p.id !== failure.id)) assert.deepEqual(recovered.find(p => p.id === post.id), post);
  pass('Existing detail Refresh metadata recovers failure after real cooldown, clearing error without changing any curation');

  // Hold only this browser's request, then delete via the real drawer. Releasing
  // it still calls production Flask/HTTP; late completion must not resurrect it.
  await page.goto(base + '/library/settings');
  gate = { url: fixture + '/delete', started: deferred(), release: deferred() };
  await page.getByLabel('Import bookmarks HTML').setInputFiles(htmlFile([['/delete', 'Disposable metadata record']]));
  await page.getByRole('status').filter({ hasText: 'Bookmark import complete — 1 new' }).waitFor();
  await bound(gate.started.promise, 15000, 'disposable metadata request');
  const disposable = (await state()).posts.find(p => p.url === gate.url);
  await page.getByTitle('Every saved link, archived ones included', { exact: true }).click();
  await page.locator(`main a[href="/library/item/${disposable.id}"]`).focus();
  await page.keyboard.press('Enter');
  dialog = page.getByRole('dialog', { name: 'Saved post detail' });
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await saved(8);
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/enrich' && r.request().postDataJSON().url === disposable.url);
  gate.release.resolve(); gate = undefined;
  await response;
  // Exercise a full browser turn and durable reconciliation after the late result.
  await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: 'Re-sync from SQLite', exact: true }).click();
  assert.deepEqual(await snapshot('deleted-inflight', 8, []), recovered);
  assert.deepEqual((await state()).deletedUrls, [disposable.url]);
  await page.getByLabel('Import bookmarks HTML').setInputFiles(htmlFile([['/delete', 'Disposable metadata record']]));
  await page.getByRole('status').filter({ hasText: 'Bookmark import complete — 0 new' }).waitFor();
  assert.deepEqual(await snapshot('deleted-reimport', 8, []), recovered);
  await page.reload();
  assert.deepEqual(await snapshot('deleted-reload', 8, []), recovered);
  assert.deepEqual((await state()).deletedUrls, [disposable.url]);
  pass('Deleting an in-flight new record preserves tombstone; late real metadata, reimport and reload cannot resurrect it');

  const final = await control('events');
  report.fixtureRequests = final;
  for (const event of final.events.filter(e => e.kind === 'enrich-start' && e.url !== fixture + '/delete')) {
    assert.ok(event.durable, 'Enrichment before SQLite save: ' + event.url);
  }
  // Classification is synced through the next delta and may land while a preview
  // is still loading; it must still reach SQLite for every surviving record.
  for (const post of (await control('snapshot')).result.posts) {
    assert.ok(['automatic', 'manual'].includes(post.categoryMode), 'Never classified durably: ' + post.url);
  }
  for (const event of final.events.filter(e => e.kind === 'categorize')) {
    assert.ok(event.durableUrls.length); assert.equal(event.keywordsOnly, true);
  }
  const initialFailure = final.events.find(e => e.kind === 'enrich-end' && e.url === fixture + '/failure');
  assert.equal(initialFailure.status, 502); assert.equal(initialFailure.response.status, 'failed');
  assert.equal(initialFailure.response.error, 'http_error');
  const noMetadata = final.events.find(e => e.kind === 'enrich-end' && e.url === fixture + '/empty');
  assert.equal(noMetadata.status, 200); assert.equal(noMetadata.response.status, 'empty'); assert.equal(noMetadata.response.error, '');
  assert.ok(final.connections.length >= 9);
  assert.ok(final.connections.every(([ip]) => ip === '93.184.216.34'));
  assert.ok(final.dnsCalls.every(([host]) => ['metadata.fixture.test', 'cdn.fixture.test', 'www.instagram.com'].includes(host)));
  assert.deepEqual(report.denied, []); assert.deepEqual(report.errors, []);
  assert.deepEqual((await control('snapshot')).result.blocked, []);
  pass('Request evidence verifies durable ordering, API statuses/errors and public-fixture-IP-only controlled HTTP; no blocked access');
} catch (error) {
  report.failure = error.stack;
  report.checks.push({ name: 'Initial browser execution', status: 'FAIL', detail: error.message });
  process.exitCode = 1;
  console.error(error);
  if (page && !page.isClosed()) await screenshot('failure.png').catch(error => report.errors.push('failure screenshot: ' + error.message));
  // No harness/production repair or second execution in this assigned pass.
} finally {
  gate?.release.resolve();
  if (child?.exitCode === null && child?.stdin.writable) {
    try { report.finalFixture = await control('events'); report.finalSnapshot = (await control('snapshot')).result; }
    catch (error) { report.errors.push('final evidence: ' + error.message); }
  }
  if (browser) {
    try { await browser.close(); report.browserClosed = true; }
    catch (error) { report.errors.push('browser cleanup: ' + error.message); process.exitCode = 1; }
  }
  if (child?.exitCode === null && child?.stdin.writable) child.stdin.end(JSON.stringify({ id: ++sequence, command: 'stop' }) + '\n');
  if (childClosed) {
    try { report.fixtureExit = await bound(childClosed, 12000, 'owned fixture cleanup'); }
    catch (error) {
      report.errors.push(error.message); child.kill();
      report.fixtureExit = await bound(childClosed, 8000, 'owned fixture termination'); process.exitCode = 1;
    }
    if (report.fixtureExit.code !== 0) process.exitCode = 1;
  }
  if (ready?.port) {
    report.portClosed = await new Promise(resolve => {
      const socket = net.connect({ host: '127.0.0.1', port: ready.port });
      socket.once('error', () => { socket.destroy(); resolve(true); });
      socket.once('connect', () => { socket.destroy(); resolve(false); });
      socket.setTimeout(2000, () => { socket.destroy(); resolve(false); });
    });
    if (!report.portClosed) process.exitCode = 1;
  }
  await Promise.allSettled(responseTasks);
  report.after = await hashes();
  report.finished = new Date().toISOString();
  report.exitCode = process.exitCode || 0;
  await writeFile(join(output, 'runtime.json'), JSON.stringify(report, null, 2));
  console.log('Evidence', output);
}
