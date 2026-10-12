// The library store and search in Node, synthetic links only: duplicates, undo,
// shelves, syncing refused writes and re-added links, search operators.
// Run from frontend/: node tests/library-store-test.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Just enough of a browser for the store.
const memory = new Map();
globalThis.localStorage = { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), removeItem: k => memory.delete(k), clear: () => memory.clear() };
const events = new EventTarget();
globalThis.window = globalThis;
globalThis.addEventListener = events.addEventListener.bind(events);
globalThis.removeEventListener = events.removeEventListener.bind(events);
globalThis.document = { addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, visibilityState: 'visible', documentElement: { dataset: {}, style: { setProperty() {} } } };
globalThis.innerWidth = 1400;

const out = await build({
  stdin: {
    contents: `
      export { useLibrary, findSavedByUrl, touchedSinceImport, updatePostInBackground, applyAutomaticCategoryInBackground } from './src/store/library';
      export { syncLibrary, startLibraryPersistence } from './src/lib/libraryPersistence';
      export { parseWhatsAppChat } from './src/lib/whatsapp';
      export { bookmarkPost } from './src/lib/bookmarks';
      export { normalizeUrl, libraryUrl } from './src/lib/platform';
      export { parseQuery, matchesQuery } from './src/lib/librarySearch';
      export { fileName } from './src/lib/sharePage';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' },
});
const lib = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const { useLibrary, syncLibrary, libraryUrl } = lib;
const fresh = useLibrary.getState();
const reset = () => useLibrary.setState({ ...fresh, posts: [], pending: {}, deletedUrls: [], rejected: {}, purgeUrls: [], undeleteUrls: [], imports: [], syncRev: 0 }, false);
const check = async (name, run) => { reset(); await run(); console.log('PASS', name); };

await check('a WhatsApp link already saved from a browser updates it, never a second post', () => {
  const url = 'https://www.youtube.com/watch?v=abc123';
  const bookmark = lib.bookmarkPost(url, 'Great talk', undefined, ['Bookmarks bar']);
  useLibrary.getState().importPosts([bookmark]);
  useLibrary.getState().updatePost(bookmark.id, { userNotes: 'my note' });
  const chat = lib.parseWhatsAppChat(`12/10/2026, 21:41 - Me: watch this ${url}`, 'Me');
  assert.deepEqual(useLibrary.getState().importPosts(chat.posts), { added: 0, updated: 1, skipped: 0 });
  const same = useLibrary.getState().posts.filter(p => libraryUrl(p.url) === libraryUrl(url));
  assert.equal(same.length, 1);
  assert.equal(same[0].userNotes, 'my note');
});

await check('undoing an import keeps links the owner sorted (Keep and Later)', () => {
  const posts = [1, 2, 3].map(n => ({ ...lib.bookmarkPost(`https://a.example/${n}`, `Link ${n}`, undefined, []), importBatchId: 'batch-1', status: 'inbox' }));
  useLibrary.getState().importPosts(posts);
  const [one, two] = useLibrary.getState().posts;
  useLibrary.getState().updatePost(one.id, { status: 'reference' });     // Keep on the Home deck
  useLibrary.getState().updatePost(two.id, { status: 'to-review' });     // Later
  assert.deepEqual(useLibrary.getState().undoImport('batch-1', false), { removed: 1, kept: 2 });
});

await check('a shelf added with a renamed shelf\'s old name gets an id of its own', () => {
  const knitting = useLibrary.getState().addCategory('knitting');
  useLibrary.getState().renameCategory(knitting.id, 'yarn');
  const again = useLibrary.getState().addCategory('knitting');
  assert.ok(again, 'the old name is free again');
  assert.notEqual(again.id, knitting.id);
  const ids = useLibrary.getState().categories.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length, 'shelf ids are unique');
});

await check('links that differ only by a web app route are different links', () => {
  assert.notEqual(lib.normalizeUrl('https://app.example.com/#/invoice/1001'), lib.normalizeUrl('https://app.example.com/#/invoice/2002'));
  assert.equal(lib.normalizeUrl('https://example.com/page#section'), lib.normalizeUrl('https://example.com/page'));
  useLibrary.getState().addByUrl('https://app.example.com/#/invoice/1001');
  assert.equal(lib.findSavedByUrl(useLibrary.getState().posts, 'https://app.example.com/#/invoice/2002'), undefined);
});

await check('search: site: matches the site and its subdomains only; "-" excludes', () => {
  const at = (domain, extra = {}) => ({ ...lib.bookmarkPost(`https://${domain}/x`, domain, undefined, []), domain, ...extra });
  const q = lib.parseQuery('site:x.com');
  assert.equal(lib.matchesQuery(at('x.com'), q), true);
  assert.equal(lib.matchesQuery(at('mobile.x.com'), q), true);
  assert.equal(lib.matchesQuery(at('netflix.com'), q), false);
  assert.equal(lib.matchesQuery(at('en.wikipedia.org'), lib.parseQuery('site:wikipedia')), true);
  const hide = lib.parseQuery('-site:x.com -is:archived');
  assert.equal(lib.matchesQuery(at('x.com'), hide), false);
  assert.equal(lib.matchesQuery(at('example.org', { status: 'archived' }), hide), false);
  assert.equal(lib.matchesQuery(at('example.org'), hide), true);
});

await check('a shared page is named after the local day it says it was shared', () => {
  const late = new Date(2026, 9, 8, 23, 30);          // 23:30 local time
  assert.match(lib.fileName('Travel', late), /^travel-2026-10-08\.html$/);
});

await check('a refused write shows what SQLite holds; a link added back elsewhere is shown again', async () => {
  const url = 'https://example.org/note';
  const mine = { ...lib.bookmarkPost(url, 'Note', undefined, []), userNotes: 'older note' };
  useLibrary.setState({ posts: [mine], pending: { [libraryUrl(url)]: mine }, syncRev: 5, deletedUrls: ['https://example.org/back'] });
  const sqlite = { ...mine, userNotes: 'newer note from another browser', updatedAt: '2030-01-01T00:00:00.000Z' };
  const back = { ...lib.bookmarkPost('https://example.org/back', 'Back', undefined, []), updatedAt: '2030-01-01T00:00:00.000Z' };
  globalThis.fetch = async (_url, init) => ({
    ok: true, status: 200,
    json: async () => init?.method === 'POST'
      ? { ok: true, posts: [sqlite, back], deletedUrls: [], legacyRows: [], categories: [], rev: 7, since: 5,
          rejected: [{ url, id: mine.id, reason: 'stale' }] }
      : { ok: true, posts: [], deletedUrls: [], legacyRows: [], categories: [], rev: 7, since: 5 },
  });
  assert.equal(await syncLibrary(), true);
  const state = useLibrary.getState();
  assert.equal(state.posts.find(p => libraryUrl(p.url) === libraryUrl(url)).userNotes, 'newer note from another browser');
  assert.ok(state.posts.some(p => p.url === back.url), 'added back in another browser: no longer hidden here');
  assert.ok(!state.deletedUrls.includes('https://example.org/back'));
});
await check('background changes are applied together; one worked out when applied keeps an edit made meanwhile', async () => {
  const a = lib.bookmarkPost('https://example.org/a', 'A', undefined, []);
  const b = lib.bookmarkPost('https://example.org/b', 'B', undefined, []);
  useLibrary.setState({ posts: [a, b], pending: {} });
  const done = Promise.all([
    lib.updatePostInBackground(a.id, { metadataStatus: 'enriched', description: 'from the page' }),
    lib.updatePostInBackground(b.id, post => ({ title: post.title === 'B' ? 'Fetched title' : post.title })),
    lib.updatePostInBackground(b.id, { metadataStatus: 'enriched' }),
  ]);
  assert.equal(useLibrary.getState().posts.find(p => p.id === a.id).description, undefined, 'not applied yet');
  useLibrary.getState().updatePost(b.id, { title: 'My title' });       // the owner's edit lands at once
  let changes = 0;
  const stop = useLibrary.subscribe((state, previous) => { if (state.posts !== previous.posts) changes++; });
  await done;
  stop();
  const state = useLibrary.getState();
  assert.equal(changes, 1, 'one change to the library for all three');
  assert.equal(state.posts.find(p => p.id === a.id).description, 'from the page');
  assert.equal(state.posts.find(p => p.id === b.id).title, 'My title');
  assert.equal(state.posts.find(p => p.id === b.id).metadataStatus, 'enriched');
  assert.deepEqual(Object.keys(state.pending).sort(), [libraryUrl(a.url), libraryUrl(b.url)].sort());
});

await check('an automatic shelf from the background never overrides a shelf the owner chose meanwhile', async () => {
  const post = { ...lib.bookmarkPost('https://example.org/cake', 'Cake', undefined, []), categories: [] };
  useLibrary.setState({ posts: [post], pending: {} });
  const done = lib.applyAutomaticCategoryInBackground(post.id, 'food-drink');
  useLibrary.getState().updatePost(post.id, { categories: ['travel'] });
  await done;
  const now = useLibrary.getState().posts[0];
  assert.deepEqual([now.categories, now.categoryMode], [['travel'], 'manual']);
});

await check('applying AI suggestions marks the links that run checked, also ones left in "other"', () => {
  const x = { ...lib.bookmarkPost('https://example.org/x', 'X', undefined, []), categories: ['other'], categoryMode: 'automatic', categoryReview: true };
  const y = { ...x, id: 'y-id', url: 'https://example.org/y', title: 'Y' };
  useLibrary.setState({ posts: [x, y], pending: {} });
  const n = useLibrary.getState().applyAiSuggestions([{ id: x.id, shelf: 'travel' }], [x.id, y.id]).length;
  const [px, py] = useLibrary.getState().posts;
  assert.equal(n, 1, 'one link changed');
  assert.deepEqual([px.categories, px.categoryMode], [['travel'], 'manual']);
  assert.ok(px.aiCheckedAt && py.aiCheckedAt, 'both checked');
  assert.deepEqual(py.categories, ['other'], 'left where it was');
  assert.ok(libraryUrl(py.url) in useLibrary.getState().pending, 'the mark is saved too');
});

await check('sorting in the background keeps shelves automatic and records each change; undo leaves the owner\'s later edits', () => {
  const x = { ...lib.bookmarkPost('https://example.org/bx', 'caption #food on Instagram', undefined, []), categories: ['other'], categoryMode: 'automatic', categoryReview: true, tags: ['old'] };
  const y = { ...x, id: 'by-id', url: 'https://example.org/by', title: 'Y', tags: [] };
  const z = { ...x, id: 'bz-id', url: 'https://example.org/bz', title: 'Z', tags: [] };
  useLibrary.setState({ posts: [x, y, z], pending: {} });
  const changes = useLibrary.getState().applyAiSuggestions([
    { id: x.id, shelf: 'travel', tags: ['lisbon'], title: 'A slow week in Lisbon', summary: 'Where to eat.' },
    { id: y.id, shelf: 'travel' },
  ], [x.id, y.id, z.id], { automatic: true });
  const [px, py, pz] = useLibrary.getState().posts;
  assert.deepEqual([px.categories, px.categoryMode, px.categoryReview], [['travel'], 'automatic', false]);
  assert.deepEqual([px.tags, px.title, px.originalTitle, px.fieldSources?.title, px.aiSummary],
    [['old', 'lisbon'], 'A slow week in Lisbon', 'caption #food on Instagram', 'ai', 'Where to eat.']);
  assert.equal(changes.length, 3, 'two filed, and the third only marked as checked');
  const cx = changes.find(c => c.id === x.id);
  assert.deepEqual(cx.before.categories, ['other']);
  assert.equal(cx.before.originalTitle, undefined);
  assert.deepEqual(Object.keys(changes.find(c => c.id === z.id).after), ['aiCheckedAt']);
  // The owner moves Y somewhere else afterwards; the undo leaves that alone.
  useLibrary.getState().updatePost(py.id, { categories: ['food-drink'] });
  const restored = useLibrary.getState().restoreAiChanges(changes);
  const [ux, uy, uz] = useLibrary.getState().posts;
  assert.equal(restored, 3);
  assert.deepEqual([ux.categories, ux.categoryMode, ux.categoryReview, ux.tags, ux.title], [['other'], 'automatic', true, ['old'], 'caption #food on Instagram']);
  assert.ok(!('originalTitle' in ux) && !('aiSummary' in ux) && !ux.aiCheckedAt, 'fields the AI added are gone again');
  assert.deepEqual(ux.fieldSources, x.fieldSources, 'where the title came from is put back');
  assert.deepEqual(uy.categories, ['food-drink'], "the owner's own choice stays");
  assert.ok(!uz.aiCheckedAt, 'checked marks are undone too: those links can be asked about again');
  assert.equal(pz.categories[0], 'other');
});

await check('putting many links on one more shelf is a single write', () => {
  const posts = Array.from({ length: 50 }, (_, i) => ({ ...lib.bookmarkPost(`https://example.org/s${i}`, `S${i}`, undefined, []),
    categories: i % 2 ? ['uncategorized'] : ['travel'] }));
  useLibrary.setState({ posts, pending: {} });
  let changes = 0;
  const stop = useLibrary.subscribe((state, previous) => { if (state.posts !== previous.posts) changes++; });
  const n = useLibrary.getState().addToShelf(posts.map(p => p.id), 'technology');
  stop();
  assert.deepEqual([changes, n], [1, 50]);
  const state = useLibrary.getState();
  assert.ok(state.posts.every(p => p.categories.includes('technology') && !p.categories.includes('uncategorized') && p.categoryMode === 'manual'));
  assert.ok(state.posts.filter((_, i) => i % 2 === 0).every(p => p.categories.includes('travel')), 'their other shelves stay');
});

await check('filing links takes them out of "other" and "uncategorized", and Undo puts their shelves back', () => {
  const posts = [['other'], ['uncategorized'], ['technology', 'other'], ['travel'], ['other']].map((categories, i) =>
    ({ ...lib.bookmarkPost(`https://example.org/f${i}`, `F${i}`, undefined, []), categories, categoryMode: 'automatic', categoryReview: i === 0 }));
  useLibrary.setState({ posts, pending: {} });
  const before = useLibrary.getState().posts.map(p => ({ id: p.id, categories: p.categories, categoryMode: p.categoryMode, categoryReview: p.categoryReview }));
  const n = useLibrary.getState().addToShelf(posts.slice(0, 4).map(p => p.id), 'technology');
  assert.equal(n, 4, 'the one already on technology but still in "other" is tidied too');
  assert.deepEqual(useLibrary.getState().posts.map(p => p.categories), [['technology'], ['technology'], ['technology'], ['travel', 'technology'], ['other']]);
  assert.ok(useLibrary.getState().posts.slice(0, 4).every(p => p.categoryMode === 'manual' && p.categoryReview === false));
  assert.equal(useLibrary.getState().addToShelf([posts[0].id], 'technology'), 0, 'nothing left to change');
  // Moving into "other" itself keeps it (only "uncategorized" goes).
  useLibrary.getState().addToShelf([posts[1].id], 'other');
  assert.deepEqual(useLibrary.getState().posts[1].categories, ['technology', 'other']);
  useLibrary.getState().restoreCategories(before);
  assert.deepEqual(useLibrary.getState().posts.map(p => ({ id: p.id, categories: p.categories, categoryMode: p.categoryMode, categoryReview: p.categoryReview })), before);
});

await check('moving links from one shelf to another takes them off the first only, and Undo puts them back', () => {
  const posts = [['technology'], ['technology', 'travel'], ['travel'], ['technology', 'arts-culture'], ['technology', 'other']].map((categories, i) =>
    ({ ...lib.bookmarkPost(`https://example.org/m${i}`, `M${i}`, undefined, []), categories, categoryMode: 'automatic', categoryReview: false }));
  useLibrary.setState({ posts, pending: {} });
  const before = useLibrary.getState().posts.map(p => ({ id: p.id, categories: p.categories, categoryMode: p.categoryMode, categoryReview: p.categoryReview }));
  const n = useLibrary.getState().moveToShelf(posts.map(p => p.id), 'technology', 'arts-culture');
  assert.equal(n, 4, 'only the links on technology move');
  assert.deepEqual(useLibrary.getState().posts.map(p => p.categories),
    [['arts-culture'], ['travel', 'arts-culture'], ['travel'], ['arts-culture'], ['arts-culture']]);
  assert.ok([0, 1, 3, 4].every(i => useLibrary.getState().posts[i].categoryMode === 'manual'));
  assert.equal(useLibrary.getState().posts[2].categoryMode, 'automatic', 'a link that wasn\'t on technology is untouched');
  assert.equal(useLibrary.getState().moveToShelf([posts[0].id], 'technology', 'arts-culture'), 0, 'nothing left on technology');
  assert.equal(useLibrary.getState().moveToShelf([posts[2].id], 'travel', 'travel'), 0, 'a move to the same shelf changes nothing');
  useLibrary.getState().restoreCategories(before);
  assert.deepEqual(useLibrary.getState().posts.map(p => ({ id: p.id, categories: p.categories, categoryMode: p.categoryMode, categoryReview: p.categoryReview })), before);
});

await check('importing links that are already saved copies nothing and leaves nothing to save', () => {
  const posts = Array.from({ length: 20 }, (_, i) => lib.bookmarkPost(`https://example.org/i${i}`, `I${i}`, undefined, ['Bar']));
  useLibrary.setState({ posts, pending: {} });
  const before = useLibrary.getState().posts;
  const result = useLibrary.getState().importPosts(posts.map(p => ({ ...p })));
  assert.deepEqual([result.added, result.updated], [0, 20]);
  assert.ok(useLibrary.getState().posts.every((p, i) => p === before[i]), 'the same objects as before');
  assert.deepEqual(useLibrary.getState().pending, {});
});

await check('saving to SQLite is not put off while changes keep arriving', async () => {
  const post = lib.bookmarkPost('https://example.org/busy', 'Busy', undefined, []);
  useLibrary.setState({ posts: [post], pending: {}, syncRev: 0 });
  const saves = [];
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') saves.push(Date.now());
    const body = init?.method === 'POST' ? JSON.parse(init.body) : { posts: [post] };
    return { ok: true, status: 200, json: async () => ({ ok: true, posts: body.posts, deletedUrls: [], legacyRows: [], categories: [], rev: saves.length + 1 }) };
  };
  const stop = lib.startLibraryPersistence();
  await new Promise(resolve => setTimeout(resolve, 300));
  const started = Date.now();
  // A change every 100 ms for 2.5 s: a plain 300 ms debounce would wait until they stop.
  for (let i = 0; i < 25; i++) {
    useLibrary.getState().updatePost(post.id, { userNotes: `note ${i}` });
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  stop();
  assert.ok(saves.length >= 1, 'saved while the changes kept coming');
  assert.ok(saves[0] - started < 1900, `first save after ${saves[0] - started} ms`);
});
console.log('ALL PASS');
process.exit(0);   // the store's save timers would keep Node waiting
