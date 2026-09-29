// Run after npm run build. Uses preinstalled Playwright and a new browser profile.
// All browser requests are fulfilled/aborted here: no server, DB, or network I/O.
// C3_PLAYWRIGHT_MODULE and C3_BROWSER_CHANNEL select installed test tooling.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.C3_PLAYWRIGHT_MODULE || 'playwright');
const fixturePath = name => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const raw = await readFile(fixturePath('telegram-saved-messages.json'), 'utf8');
const fixture = JSON.parse(raw);
const bookmarks = await Promise.all(['firefox', 'chromium'].map(name => readFile(fixturePath(`bookmarks-${name}.html`), 'utf8')));
const expectedUrls = ['https://example.invalid/travel', 'https://example.invalid/programming#typescript',
  'https://example.invalid/reference', 'http://example.invalid/no-metadata'];
const wrap = messages => JSON.stringify({ type: 'saved_messages', messages });
const msg = patch => ({ id: 1, type: 'message', text: '', ...patch });
const invalid = [
  ['', /empty/], ['{', /not valid JSON/], ['null', /Unsupported export/], ['[]', /Unsupported export/],
  ['{}', /Unsupported export/], ['{"messages":{}}', /Unsupported export/], ['{"messages":[null]}', /Malformed/],
  ['{"messages":[]}', /No messages/], ['{"chats":{"list":[]}}', /Unsupported export/],
  [JSON.stringify({ type: 'personal_chat', messages: [msg({})] }), /Unsupported export/],
  [wrap([msg({ text: null })]), /Malformed/], [wrap([msg({ text: [null] })]), /Malformed/],
  [wrap([msg({ text_entities: {} })]), /Malformed/], [wrap([msg({ text_entities: [null] })]), /Malformed/],
  [wrap([msg({ text: [{ type: 'text_link', text: 'missing target' }] })]), /Malformed/],
  [wrap([msg({ date: {} })]), /Malformed/], [wrap([msg({ id: {} })]), /Malformed/],
  [wrap([fixture.messages[0], null]), /Malformed/],
];
const bundle = await build({
  stdin: { contents: 'export { parseTelegramExport } from "./src/lib/telegram"; export { parseBookmarkHtml } from "./src/lib/bookmarks"; export { useLibrary } from "./src/store/library"; export { normalizeUrl } from "./src/lib/platform";',
    resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, write: false, format: 'iife', globalName: 'c3', define: { 'process.env.NODE_ENV': '"test"' },
});
const origin = 'http://c3-fixture.invalid';
const browser = await chromium.launch({ headless: true, channel: process.env.C3_BROWSER_CHANNEL || undefined });
const errors = [], denied = [], apis = [];
async function isolatedPage(unit = false) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1365, height: 900 } });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { denied.push(url.href); return route.abort(); }
    if (url.pathname.startsWith('/api/')) {
      apis.push(url.pathname);
      const data = { '/api/stats': { total: 0 }, '/api/posts': [], '/api/categories': [] };
      if (!(url.pathname in data)) { denied.push(url.pathname); return route.abort(); }
      return route.fulfill({ json: data[url.pathname] });
    }
    if (unit) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>C3 synthetic unit harness</title>' });
    if (url.pathname.startsWith('/assets/') && /^\/assets\/[\w.-]+$/.test(url.pathname)) {
      return route.fulfill({ contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css',
        body: await readFile(new URL(`../dist${url.pathname}`, import.meta.url)) });
    }
    return route.fulfill({ contentType: 'text/html', body: await readFile(new URL('../dist/index.html', import.meta.url)) });
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${origin}/library/settings`);
  return { context, page };
}
const pass = text => console.log(`PASS ${text}`);
try {
  const { context: unitContext, page: unit } = await isolatedPage(true);
  await unit.addScriptTag({ content: bundle.outputFiles[0].text });
  const parse = text => unit.evaluate(text => c3.parseTelegramExport(text), text);
  const parsed = await parse(raw);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.posts.map(p => p.url), expectedUrls);
  assert.equal(new Set(parsed.posts.map(p => p.id)).size, 4);
  assert.equal(parsed.messages, 5); assert.equal(parsed.skipped, 1); assert.equal(parsed.duplicates, 1);
  assert.equal(parsed.unsupported, 0);
  assert.equal(parsed.posts[0].sourceMessageId, '97001');
  assert.equal(parsed.posts[1].sourceMessageId, '97001');
  assert.ok(parsed.posts.every(p => p.source === 'telegram' && /^tg-json-[\w-]+$/.test(p.id)));
  for (const [i, messageIndex] of [0, 0, 1, 2].entries()) {
    const m = fixture.messages[messageIndex];
    const text = typeof m.text === 'string' ? m.text : m.text.map(p => typeof p === 'string' ? p : p.text).join('');
    assert.equal(parsed.posts[i].excerpt, text);
    assert.equal(parsed.posts[i].createdAt, m.date);
    assert.deepEqual(parsed.posts[i].telegramMessage, { id: String(m.id), date: m.date, text });
  }
  pass('fixture: 5 messages → 4 distinct links; two links share message 97001 but have distinct IDs; 1 duplicate, 1 linkless; labeled target and full source metadata retained');
  for (const [raw, pattern] of invalid) {
    const result = await parse(raw);
    assert.match(result.errors.join(' '), pattern);
    assert.equal(result.posts.length, 0);
  }
  const inline = await parse(wrap([msg({ text: ['Label ', { type: 'text_link', text: 'https://example.invalid/label-only', href: expectedUrls[2] }] })]));
  assert.deepEqual(inline.posts.map(p => p.url), [expectedUrls[2]]);
  const plain = await parse(wrap([msg({ text: '(https://example.invalid/one) https://example.invalid/Foo_(bar).' })]));
  assert.deepEqual(plain.posts.map(p => p.url), ['https://example.invalid/one', 'https://example.invalid/Foo_(bar)']);
  const unsupported = await parse(wrap([msg({ text_entities: [
    { type: 'text_link', text: 'file', href: 'file:///synthetic-only' },
    { type: 'text_link', text: 'bad', href: 'not-a-url' },
    { type: 'link', text: expectedUrls[0] },
  ] })]));
  assert.equal(unsupported.posts.length, 1); assert.equal(unsupported.unsupported, 2);
  const longText = 'Synthetic full message. '.repeat(30) + expectedUrls[0];
  assert.equal((await parse(wrap([msg({ text: longText })]))).posts[0].excerpt, longText);
  const many = await parse(wrap(Array.from({ length: 205 }, (_, i) => msg({ id: i, text: `https://example.invalid/item-${i}` }))));
  assert.equal(many.posts.length, 205); assert.equal(many.messages, 205);
  pass('18 malformed/unsupported structures controlled; inline entities and plain links supported; full >500-character text and all 205 links retained without item truncation');

  const storeResult = await unit.evaluate(({ raw, bookmarks }) => {
    const store = c3.useLibrary;
    const tg = () => store.getState().importPosts(c3.parseTelegramExport(raw).posts);
    const bm = () => bookmarks.map(text => store.getState().importPosts(c3.parseBookmarkHtml(text).posts));
    const bookResults = bm();
    const overlap = store.getState().posts.find(p => p.url.includes('programming'));
    store.getState().updatePost(overlap.id, { title: 'Curated bookmark title', categories: ['other'], tags: ['MixedCase'], userNotes: 'Bookmark note', favorite: true, status: 'archived' });
    const tgResult = tg();
    const travel = store.getState().posts.find(p => p.url.endsWith('/travel'));
    store.getState().updatePost(travel.id, { categories: ['technology'], userNotes: 'Telegram note', pinned: true, status: 'reference' });
    const before = JSON.stringify(store.getState().posts);
    const reimports = [...bm(), tg(), tg()];
    const after = JSON.stringify(store.getState().posts);
    const persisted = JSON.parse(localStorage.getItem('library-store-v1')).state.posts;
    // Reversed source order also needs the same eight-record library.
    store.setState({ posts: [] });
    tg(); bm();
    const reverseCount = store.getState().posts.length;
    // Reimport a previously curated item created by the old Telegram importer.
    const legacy = { ...travel, id: 'tg-97001', canonicalUrl: c3.normalizeUrl(overlap.url), url: overlap.url,
      sourceMessageId: 'old-message', telegramMessage: undefined, userNotes: 'Legacy note' };
    store.setState({ posts: [legacy] });
    tg();
    const legacyPosts = store.getState().posts;
    bm();
    return { bookResults, tgResult, before, after, reimports, persisted, reverseCount, legacy: legacyPosts, legacyCombinedCount: store.getState().posts.length };
  }, { raw, bookmarks });
  assert.deepEqual(storeResult.bookResults.map(r => r.added), [3, 2]);
  assert.equal(storeResult.tgResult.added, 3); assert.equal(storeResult.tgResult.updated, 1);
  assert.equal(storeResult.persisted.length, 8); assert.equal(storeResult.reverseCount, 8);
  assert.equal(storeResult.before, storeResult.after); assert.ok(storeResult.reimports.every(r => r.added === 0));
  const shared = storeResult.persisted.find(p => p.url === expectedUrls[1]);
  assert.equal(shared.source, 'browser'); assert.equal(shared.title, 'Curated bookmark title');
  assert.deepEqual(shared.telegramMessage, parsed.posts[1].telegramMessage);
  assert.deepEqual(shared.tags, ['MixedCase']); assert.equal(shared.userNotes, 'Bookmark note');
  assert.equal(storeResult.legacy.length, 4);
  assert.equal(storeResult.legacyCombinedCount, 8);
  assert.equal(storeResult.legacy.find(p => p.url === expectedUrls[1]).id, 'tg-97001');
  assert.equal(storeResult.legacy.find(p => p.url === expectedUrls[1]).userNotes, 'Legacy note');
  pass('actual store: 5 bookmarks + 4 Telegram - 1 overlap = 8 in both import orders; reimports still 8; curation/provenance and legacy item identity preserved');
  await unitContext.close();

  const { context, page } = await isolatedPage();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('library-store-v1') || '{}').state?.migrated === true);
  const readPosts = () => page.evaluate(() => JSON.parse(localStorage.getItem('library-store-v1')).state.posts);
  const telegramInput = page.getByLabel('Import Telegram JSON');
  const result = page.getByRole('status', { name: 'Telegram import result' });
  const bookmarkInput = page.getByLabel('Import bookmarks HTML');
  for (const name of ['firefox', 'chromium']) {
    await bookmarkInput.setInputFiles(fixturePath(`bookmarks-${name}.html`));
    await page.getByRole('status').filter({ hasText: name === 'firefox' ? '3 new, 0 already present' : '2 new, 1 already present' }).waitFor();
  }
  assert.equal((await readPosts()).length, 5);
  await telegramInput.setInputFiles(fixturePath('telegram-saved-messages.json'));
  await result.filter({ hasText: '3 new, 1 already present; 5 messages checked, 1 without eligible links, 1 duplicate URLs' }).waitFor();
  const initial = await readPosts(); assert.equal(initial.length, 8);
  assert.equal(initial.filter(p => p.source === 'telegram').length, 3);
  assert.equal(initial.filter(p => p.telegramMessage).length, 4);
  const travel = initial.find(p => p.url === expectedUrls[0]);
  await page.goto(`${origin}/library/item/${travel.id}`);
  const dialog = page.getByRole('dialog', { name: 'Saved post detail' });
  await dialog.getByRole('button', { name: 'Favorite', exact: true }).click();
  await dialog.getByRole('button', { name: 'Archived', exact: true }).click();
  await dialog.getByRole('button', { name: 'other', exact: true }).click();
  await dialog.getByPlaceholder('Your notes…').fill('UI Telegram note');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  const curated = await readPosts();
  const curatedTravel = curated.find(p => p.id === travel.id);
  assert.equal(curatedTravel.favorite, true); assert.equal(curatedTravel.status, 'archived');
  assert.deepEqual(curatedTravel.categories, ['other']); assert.equal(curatedTravel.userNotes, 'UI Telegram note');
  await page.goto(`${origin}/library/settings`);
  for (const name of ['firefox', 'chromium']) {
    await bookmarkInput.setInputFiles(fixturePath(`bookmarks-${name}.html`));
    await page.getByRole('status').filter({ hasText: '0 new, 3 already present' }).waitFor();
  }
  for (let i = 0; i < 2; i++) {
    await telegramInput.setInputFiles(fixturePath('telegram-saved-messages.json'));
    await result.filter({ hasText: '0 new, 4 already present' }).waitFor();
  }
  assert.deepEqual(await readPosts(), curated); assert.equal(curated.length, 8);
  await page.reload(); await telegramInput.waitFor({ state: 'attached' });
  assert.deepEqual(await readPosts(), curated);
  pass('fresh-built Settings/detail UI: 5 + 3 = 8; all file reimports, same-file reselection and reload retain 8 and curated fields');

  for (const [raw, pattern] of invalid) {
    const before = await page.evaluate(() => localStorage.getItem('library-store-v1'));
    await telegramInput.setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(raw) });
    await result.filter({ hasText: pattern }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('library-store-v1')), before);
  }
  const before = await page.evaluate(() => localStorage.getItem('library-store-v1'));
  await telegramInput.setInputFiles({ name: 'linkless.json', mimeType: 'application/json', buffer: Buffer.from(wrap([msg({ text: 'A note only' })])) });
  await result.filter({ hasText: '0 new, 0 already present; 1 messages checked, 1 without eligible links' }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('library-store-v1')), before);
  pass('Settings UI: all 18 invalid inputs plus linkless export leave serialized persisted state unchanged');
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  assert.ok(apis.every(p => ['/api/stats', '/api/posts', '/api/categories'].includes(p)));
  pass('all requests fulfilled from local fixtures/build; no network continuation, providers, DB, live Telegram, external images or uncaught browser errors');
  await context.close();
} finally {
  await browser.close();
  console.log('CLEANUP owned isolated browser closed; no server process or listener created');
}
