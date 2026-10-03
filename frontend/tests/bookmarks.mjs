// C2-only browser checks. Requires a guarded synthetic server, not the owner's app.
// C2_BASE_URL must serve X-C2-Fixture: bookmarks on /__c2_harness.html.
// C2_PLAYWRIGHT_MODULE may point to a preinstalled Playwright package; no install needed.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.C2_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.C2_BASE_URL;
assert.ok(base && new URL(base).hostname === '127.0.0.1', 'An isolated loopback C2 server is required');
const fixtureResponse = await fetch(`${base}/__c2_harness.html`);
assert.equal(fixtureResponse.headers.get('x-c2-fixture'), 'bookmarks', 'Refuse to use a non-fixture server');
const fixture = name => fileURLToPath(new URL(`./fixtures/bookmarks-${name}.html`, import.meta.url));
const firefox = await readFile(fixture('firefox'), 'utf8');
const chromiumHtml = await readFile(fixture('chromium'), 'utf8');
const expected = [
  ['https://example.invalid/cooking?course=main&serves=2', 'Cooking & Kitchen — supplied title'],
  ['https://example.invalid/programming#typescript', 'Programming: TypeScript notes'],
  ['http://example.invalid/exercise', 'Exercise routine'],
  ['https://example.invalid/art', 'Art & drawing ideas'],
  ['https://example.invalid/budgeting', 'Budget planning café'],
];
// Same five browser outcomes as the accepted C5 suite; no catch-all category.
const categoryCases = JSON.parse(await readFile(new URL('./fixtures/categorization-cases.json', import.meta.url), 'utf8'));
const expectedCategories = expected.map(([url, title]) => {
  const item = categoryCases.find(item => item.path === new URL(url).pathname);
  assert.equal(item?.content, title);
  return item.expected;
});
const sorted = posts => [...posts].sort((a, b) => a.url.localeCompare(b.url));
const allowedApis = new Set(['GET /api/library', 'POST /api/library', 'GET /api/stats',
  'POST /api/categorize', 'POST /api/enrich', 'GET /api/telegram/config', 'GET /api/telegram/auth']);
const wrap = body => `<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p>${body}</DL><p>`;
const invalid = [
  ['', /empty/],
  ['<html><a href="https://example.invalid/no-export">Not an export</a></html>', /not a Netscape/],
  ['<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><A HREF="https://example.invalid/truncated">Broken', /malformed/],
  
  [wrap('<A>Missing URL</A>'), /No HTTP\(S\).*1 malformed/],
  [wrap(''), /No bookmarks/],
  [wrap('<A HREF="file:///synthetic-only">Local file</A>'), /No HTTP\(S\).*1 unsupported/],
  [wrap('<A HREF="https://example.invalid/unclosed">Unclosed'), /malformed/],
];
const bundle = await build({
  stdin: {
    contents: 'export { parseBookmarkHtml } from "./src/lib/bookmarks"; export { useLibrary } from "./src/store/library";',
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
  },
  bundle: true, write: false, format: 'iife', globalName: 'c2',
  define: { 'process.env.NODE_ENV': '"test"' },
});
const browser = await chromium.launch({ headless: true, channel: process.env.C2_BROWSER_CHANNEL || undefined });
const errors = [];
const apiRequests = [];
const denied = [];
const snapshots = {};
let phase = 'parser-store';
const classificationRequests = () => apiRequests.filter(r => r.path === '/api/categorize');
function assertClassifications(count) {
  assert.deepEqual(classificationRequests().map(r => r.body.content).sort(),
    expected.slice(0, count).map(([url, title]) => `${title}\n${url}`).sort());
  for (const request of classificationRequests()) {
    assert.equal(request.method, 'POST');
    assert.deepEqual(Object.keys(request.body).sort(), ['content', 'keywords_only']);
    assert.equal(request.body.keywords_only, true);
  }
}
async function isolatedPage() {
  const context = await browser.newContext({ viewport: { width: 1365, height: 900 }, bypassCSP: true, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) { denied.push(url.href); return route.abort(); }
    if (url.pathname.startsWith('/api/')) {
      const request = route.request();
      apiRequests.push({ phase, path: url.pathname, method: request.method(), body: request.postDataJSON() });
      if (!allowedApis.has(`${request.method()} ${url.pathname}`)) {
        denied.push(`${request.method()} ${url.pathname}`); return route.abort();
      }
      if (url.pathname === '/api/enrich') {
        // Empty metadata starts AND ends at partial. Record the pre-response
        // version so classified() can observe the actual completion write.
        await request.frame().page().evaluate(url => {
          const post = JSON.parse(localStorage.getItem('library-store-v1')).state.posts.find(p => p.url === url);
          window.__c2EnrichmentStarts ??= {};
          window.__c2EnrichmentStarts[url] = post.updatedAt;
        }, request.postDataJSON().url);
      }
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  return { page, context };
}
const report = message => console.log(`PASS ${message}`);
try {
  const { page: unit, context: unitContext } = await isolatedPage();
  await unit.goto(`${base}/__c2_harness.html`);
  await unit.addScriptTag({ content: bundle.outputFiles[0].text });
  const parsed = await unit.evaluate(({ firefox, chromiumHtml }) => [c2.parseBookmarkHtml(firefox), c2.parseBookmarkHtml(chromiumHtml)], { firefox, chromiumHtml });
  assert.equal(parsed[0].posts.length, 3);
  assert.equal(parsed[0].duplicates, 1);
  assert.equal(parsed[0].unsupported, 1);
  assert.equal(parsed[1].posts.length, 3);
  report('parser: three distinct valid bookmarks per export; repeated entry and unsupported scheme reported');

  // A later malformed entry must reject the entire file before any store mutation.
  for (const [raw, pattern] of invalid) {
    const result = await unit.evaluate(raw => c2.parseBookmarkHtml(raw), raw);
    assert.match(result.error, pattern);
    assert.equal(result.posts.length, 0);
  }
  // An unusable entry is skipped and counted; valid entries in the same file still import.
  const mixed = await unit.evaluate(raw => c2.parseBookmarkHtml(raw), wrap('<A HREF="https://example.invalid/valid">Valid first</A><A HREF="https://">Invalid second</A><A>No URL</A>'));
  assert.equal(mixed.error, undefined);
  assert.deepEqual(mixed.posts.map(p => p.url), ['https://example.invalid/valid']);
  assert.equal(mixed.malformed, 2);
  // Bookmark dates and folders survive the import.
  const dated = await unit.evaluate(raw => c2.parseBookmarkHtml(raw), wrap('<DT><H3>Bookmarks bar</H3><DL><p><DT><H3>Recipes</H3><DL><p><DT><A HREF="https://example.invalid/soup" ADD_DATE="1700000000">Soup</A></DL><p></DL><p>'));
  assert.deepEqual(dated.posts[0].folderPath, ['Bookmarks bar', 'Recipes']);
  assert.equal(dated.posts[0].createdAt, new Date(1700000000 * 1000).toISOString());
  // Preserve distinct fragments/query values and avoid the old 32-bit URL hash collision.
  const edgeUrls = ['https://example.invalid/page#a', 'https://example.invalid/page#b',
    'https://example.invalid/?tag=a&tag=b', 'https://example.invalid/?tag=b',
    'https://example.invalid/Aa', 'https://example.invalid/BB'];
  const edge = await unit.evaluate(raw => c2.parseBookmarkHtml(raw), wrap(edgeUrls.map(url => `<A HREF="${url.replaceAll('&', '&amp;')}">Edge</A>`).join('')));
  assert.deepEqual(edge.posts.map(p => p.url), edgeUrls);
  assert.equal(new Set(edge.posts.map(p => p.id)).size, edgeUrls.length);
  assert.ok(edge.posts.every(p => /^browser-[A-Za-z0-9_-]+$/.test(p.id)));
  report('parser: controlled all-or-nothing errors; distinct fragments, repeated query values and colliding legacy hashes preserved');

  const store = await unit.evaluate(({ firefox, chromiumHtml }) => {
    const importFile = raw => c2.useLibrary.getState().importPosts(c2.parseBookmarkHtml(raw).posts);
    const first = importFile(firefox);
    const second = importFile(chromiumHtml);
    const state = c2.useLibrary.getState();
    state.updatePost(state.posts[0].id, { title: 'My curated title', categories: ['other'], tags: ['MixedCase'],
      userNotes: 'First distinct note', favorite: true, status: 'archived', projectIds: ['synthetic-project'], pinned: true });
    state.updatePost(state.posts[1].id, { categories: ['technology'], userNotes: 'Second distinct note', status: 'reference' });
    const before = JSON.stringify(c2.useLibrary.getState().posts);
    const again = [importFile(firefox), importFile(chromiumHtml)];
    const after = JSON.stringify(c2.useLibrary.getState().posts);
    return { first, second, again, before, after, persisted: JSON.parse(localStorage.getItem('library-store-v1')).state.posts };
  }, { firefox, chromiumHtml });
  assert.equal(store.first.added, 3);
  assert.equal(store.second.added, 2);
  assert.deepEqual(store.again.map(x => x.added), [0, 0]);
  assert.equal(store.before, store.after);
  assert.deepEqual(store.persisted, JSON.parse(store.before));
  report('actual Zustand import/persist: 3 + 2 = 5; both reimports add 0; all curated fields including mixed-case tag unchanged');
  await unitContext.close();
  assert.deepEqual(apiRequests, [], 'Direct parser/store checks do not call the import workflow');

  phase = 'settings-initial';
  const { page, context } = await isolatedPage();
  await page.goto(`${base}/library/settings`);
  await page.getByText('Flask backend online — rich metadata enrichment available.', { exact: true }).waitFor();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('library-store-v1') || '{}').state?.migrated === true);
  const input = page.getByLabel('Import bookmarks HTML');
  const status = page.getByRole('status');
  const persisted = () => page.evaluate(() => JSON.parse(localStorage.getItem('library-store-v1')).state.posts);
  async function saved(count) {
    await page.getByRole('status', { name: 'SQLite save status', exact: true })
      .filter({ hasText: /^Library saved to SQLite$/ }).waitFor();
    await page.waitForFunction(count => {
      const state = JSON.parse(localStorage.getItem('library-store-v1') || '{}').state;
      return state?.posts.length === count && Object.keys(state.pending).length === 0;
    }, count);
    await page.waitForLoadState('networkidle');
    const local = await persisted();
    const remote = await page.evaluate(async () => {
      const response = await fetch('/api/library');
      if (!response.ok) throw new Error(`Library read failed: ${response.status}`);
      return response.json();
    });
    assert.deepEqual(sorted(remote.posts), sorted(local), 'SQLite API matches every cached record field');
    assert.deepEqual(remote.deletedUrls, []);
    return local;
  }
  async function classified(count) {
    await page.waitForFunction(count => {
      const posts = JSON.parse(localStorage.getItem('library-store-v1')).state.posts;
      return posts.length === count && posts.every(p => p.categoryMode === 'automatic'
        && p.categoryReview === false && p.metadataStatus === 'partial'
        && window.__c2EnrichmentStarts?.[p.url] !== undefined
        && p.updatedAt !== window.__c2EnrichmentStarts[p.url]);
    }, count);
    const posts = await saved(count);
    assert.deepEqual(posts.map(p => p.categories), expectedCategories.slice(0, count).map(category => [category]));
    assertClassifications(count);
    return posts;
  }
  await saved(0);
  phase = 'firefox-import';
  await input.setInputFiles(fixture('firefox'));
  await status.filter({ hasText: '3 new, 0 already present, 1 duplicate entries in this file, 1 unsupported-scheme' }).waitFor();
  snapshots.firefox = await classified(3);
  phase = 'chromium-import';
  await input.setInputFiles(fixture('chromium'));
  await status.filter({ hasText: '2 new, 1 already present' }).waitFor();
  const initial = snapshots.initial = await classified(5);
  assert.equal(initial.length, 5);
  assert.deepEqual(initial.map(p => [p.url, p.title]), expected);
  assert.ok(initial.every(p => p.source === 'browser'));
  assert.deepEqual(initial.slice(0, 3), snapshots.firefox, 'Overlapping Chromium import leaves all Firefox records unchanged');
  report('accepted-build Settings UI: Firefox 3, Chromium +2 = 5; nested links, URLs/titles and browser origin correct; exact C5 automatic categories persisted');

  phase = 'curation';
  // Exercise existing curation controls without changing that UI in this slice.
  await page.goto(`${base}/library/item/${initial[0].id}`);
  const detail = page.getByRole('dialog', { name: 'Saved post detail' });
  await detail.getByRole('button', { name: 'Favorite', exact: true }).click();
  await detail.getByRole('button', { name: 'Archived', exact: true }).click();
  // Remove the accepted automatic topic before making an intentional manual other choice.
  await detail.getByRole('button', { name: expectedCategories[0], exact: true }).click();
  await detail.getByRole('button', { name: 'other', exact: true }).click();
  await detail.getByPlaceholder('add tag ⏎').fill('MixedCase');
  await detail.getByPlaceholder('add tag ⏎').press('Enter');
  await detail.getByPlaceholder('Your notes…').fill('First UI note');
  await saved(5);
  await detail.getByRole('button', { name: 'Close', exact: true }).click();
  await page.goto(`${base}/library/item/${initial[1].id}`);
  await detail.getByPlaceholder('Your notes…').fill('Second UI note');
  await saved(5);
  await detail.getByRole('button', { name: 'Close', exact: true }).click();
  const curated = snapshots.curated = await saved(5);
  assert.equal(curated[0].favorite, true);
  assert.equal(curated[0].status, 'archived');
  assert.deepEqual(curated[0].categories, ['other']);
  assert.equal(curated[0].categoryMode, 'manual');
  assert.equal(curated[0].categoryReview, false);
  assert.deepEqual(curated[0].tags, ['mixedcase']); // existing tag UI lowercases entry
  assert.equal(curated[0].userNotes, 'First UI note');
  assert.equal(curated[1].userNotes, 'Second UI note');
  assert.deepEqual(curated, initial.map((post, index) => index === 0 ? {
    ...post, favorite: true, status: 'archived', categories: ['other'], categoryMode: 'manual',
    categoryReview: false, tags: ['mixedcase'], userNotes: 'First UI note', updatedAt: curated[0].updatedAt,
  } : index === 1 ? { ...post, userNotes: 'Second UI note', updatedAt: curated[1].updatedAt } : post),
  'Only the two intentional curation edits and their update timestamps may change');
  phase = 'reimport';
  await page.goto(`${base}/library/settings`);
  await input.setInputFiles(fixture('firefox'));
  await status.filter({ hasText: '0 new, 3 already present' }).waitFor();
  assert.deepEqual(await saved(5), curated);
  assertClassifications(5);
  await input.setInputFiles(fixture('chromium'));
  await status.filter({ hasText: '0 new, 3 already present, 0 duplicate' }).waitFor();
  assert.deepEqual(await saved(5), curated);
  assertClassifications(5);
  // Same-file reselection also fires after the input value is cleared.
  await input.setInputFiles(fixture('chromium'));
  await status.filter({ hasText: '0 new, 3 already present, 0 duplicate' }).waitFor();
  assert.deepEqual(snapshots.reimport = await saved(5), curated);
  assertClassifications(5);
  phase = 'reload';
  await page.reload();
  await input.waitFor({ state: 'attached' });
  assert.deepEqual(snapshots.reload = await saved(5), curated);
  report('UI curation and both reimports/reload: still 5; notes, manual other, tag, favorite and archive preserved');

  phase = 'invalid';
  const beforeInvalidRequests = apiRequests.length;
  for (const [raw, pattern] of invalid) {
    const before = await page.evaluate(() => localStorage.getItem('library-store-v1'));
    await input.setInputFiles({ name: 'invalid.html', mimeType: 'text/html', buffer: Buffer.from(raw) });
    await status.filter({ hasText: pattern }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('library-store-v1')), before);
  }
  await page.waitForLoadState('networkidle');
  assert.equal(apiRequests.length, beforeInvalidRequests, 'Invalid files issue no API requests or writes');
  report('Settings UI: 8 empty/malformed/unsupported-only cases report controlled errors; persisted state unchanged');
  assertClassifications(5);
  assert.deepEqual(classificationRequests().map(r => r.phase).sort(),
    ['firefox-import', 'firefox-import', 'firefox-import', 'chromium-import', 'chromium-import'].sort());
  const enrichment = apiRequests.filter(r => r.path === '/api/enrich');
  assert.deepEqual(enrichment.map(r => r.body).sort((a, b) => a.url.localeCompare(b.url)),
    expected.map(([url]) => ({ url })).sort((a, b) => a.url.localeCompare(b.url)));
  assert.ok(enrichment.every(r => r.method === 'POST' && ['firefox-import', 'chromium-import'].includes(r.phase)));
  for (const request of apiRequests.filter(r => r.path === '/api/library' && r.method === 'POST')) {
    assert.deepEqual(Object.keys(request.body).sort(), ['deletedUrls', 'posts']);
    assert.deepEqual(request.body.deletedUrls, []);
    assert.ok(request.body.posts.every(p => expected.some(([url]) => url === p.url)));
    assert.ok(!['reimport', 'reload', 'invalid'].includes(request.phase), 'Reimport/reload/invalid files cause no writes');
  }
  assert.ok(apiRequests.every(r => allowedApis.has(`${r.method} ${r.path}`)));
  assert.deepEqual(denied, []);
  assert.deepEqual(errors, []);
  report('exactly five keyword-only classification and five synthetic enrichment calls for new records; no reimport calls, unrelated writes, forbidden APIs or external access');
  await context.close();
} finally {
  await browser.close();
  const requestCounts = {};
  for (const r of apiRequests) {
    const key = `${r.method} ${r.path}`;
    requestCounts[key] = (requestCounts[key] || 0) + 1;
  }
  console.log('REQUEST_COUNTS ' + JSON.stringify(requestCounts));
  if (process.env.C2_EVIDENCE_DIR) await writeFile(join(process.env.C2_EVIDENCE_DIR, 'browser-results.json'),
    JSON.stringify({ snapshots, requestCounts, requests: apiRequests, denied, errors, browserClosed: true }, null, 2));
  console.log('CLEANUP isolated browser contexts/process closed');
}
