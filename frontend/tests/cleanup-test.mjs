// Clean up and undo (v0.4.0 phase 6c, mockups in Claude outputs/v040-review/phase6c/): removed links remembered with
// what they held (Bring back, imports keep them out at any address, a new link of the same post takes back what the
// old one had), the same post saved twice merged into one with Undo, and History, where any batch can be undone, not
// only the last. Synthetic links only. Run from frontend/: node tests/cleanup-test.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const memory = new Map();
globalThis.localStorage = { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), removeItem: k => memory.delete(k), clear: () => memory.clear() };
const events = new EventTarget();
globalThis.window = globalThis;
globalThis.addEventListener = events.addEventListener.bind(events);
globalThis.removeEventListener = events.removeEventListener.bind(events);
globalThis.document = { addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, visibilityState: 'visible', documentElement: { dataset: {}, style: { setProperty() {} } },
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, innerHTML: '', value: '', textContent: '' }) };
globalThis.innerWidth = 1400;

const out = await build({
  stdin: { contents: `export { useLibrary } from './src/store/library'; export * from './src/lib/duplicates'; export * from './src/lib/removedLinks';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' },
});
const lib = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const post = (id, url, changes = {}) => ({ id, url, source: 'manual', platform: 'web', domain: new URL(url).hostname, status: 'inbox', title: id,
  categories: ['uncategorized'], tags: [], projectIds: [], createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z', metadataStatus: 'none', ...changes });
const store = lib.useLibrary;
const fresh = (posts) => store.setState({ posts, pending: {}, deletedUrls: [], undeleteUrls: [], removed: [], deletedRemoved: {}, history: [], imports: [],
  tagInfo: [], deletedTags: {}, demo: false });
const later = () => { for (const until = Date.now() + 3; Date.now() < until;) { /* a later moment */ } };
let failures = 0;
const check = (name, run) => { try { run(); console.log(`PASS ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}: ${e.message.split('\n').slice(0, 4).join(' | ')}`); } };

const loaf = () => post('p1', 'https://x.com/bakehouse_kit/status/1001', { title: 'Shaping a batard', tags: ['bread'], userNotes: 'try at 75%',
  categories: ['food-drink'], categoryMode: 'manual', favorite: true, openCount: 3, createdAt: '2026-09-01T10:00:00Z' });

check('one key per post at any address; other links have none', () => {
  for (const url of ['https://twitter.com/bakehouse_kit/status/1001?s=20', 'https://mobile.twitter.com/Bakehouse_kit/status/1001/photo/1', 'https://x.com/bakehouse_kit/status/1001'])
    assert.equal(lib.postKey(url), 'x:1001', url);
  assert.equal(lib.postKey('https://youtu.be/dQw4w9WgXcQ'), lib.postKey('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3'));
  assert.equal(lib.postKey('https://old.reddit.com/r/a/comments/abc12/x/'), 'reddit:abc12');
  assert.equal(lib.postKey('https://example.org/walks'), null);
});

check('a removed link is remembered with what it held, and comes back as it was', () => {
  fresh([loaf(), post('p2', 'https://example.org/walks')]);
  const entry = store.getState().deletePosts(['p1']);
  let s = store.getState();
  assert.equal(s.posts.length, 1);
  assert.equal(s.removed.length, 1);
  assert.deepEqual(lib.whatItHad(s.removed[0].post), ['a note', '#bread', 'the shelf food-drink', 'a favourite', 'opened 3 times']);
  assert.equal(s.removed[0].key, 'x:1001');
  assert.ok(entry && s.history[0].text === 'Removed 1 link');
  const back = store.getState().bringBack([s.removed[0].id]);
  s = store.getState();
  assert.deepEqual(back, { restored: 1, skipped: 0 });
  const p = s.posts.find(x => x.id === 'p1');
  assert.deepEqual([p.tags, p.userNotes, p.categories, p.favorite, p.createdAt], [['bread'], 'try at 75%', ['food-drink'], true, '2026-09-01T10:00:00Z']);
  assert.equal(s.deletedUrls.length, 0, 'its deletion mark goes');
  assert.ok(s.undeleteUrls.includes('https://x.com/bakehouse_kit/status/1001'), 'SQLite is told to drop its deletion mark');
  assert.equal(s.removed.length, 0);
  assert.ok(s.deletedRemoved[lib.removedId('https://x.com/bakehouse_kit/status/1001')], 'the record is deleted in SQLite too');
});

check('an import keeps a removed post out at any address; other posts come in', () => {
  fresh([loaf()]);
  store.getState().deletePosts(['p1']);
  const result = store.getState().importPosts([post('t1', 'https://twitter.com/bakehouse_kit/status/1001?s=20'), post('t2', 'https://x.com/someone/status/2002')]);
  assert.deepEqual([result.added, result.skipped], [1, 1]);
  assert.deepEqual(store.getState().posts.map(p => p.id), ['t2']);
});

check('a new link of a removed post takes back what the old one had', () => {
  fresh([loaf()]);
  store.getState().deletePosts(['p1']);
  const added = store.getState().addByUrl('https://twitter.com/bakehouse_kit/status/1001?s=20');
  const record = lib.removedFor(added, store.getState().removed);
  assert.ok(record, 'found by the post, at another address');
  later();
  store.getState().reattachRemoved(record.id, added.id);
  const p = store.getState().posts.find(x => x.id === added.id);
  assert.deepEqual([p.tags, p.userNotes, p.categories, p.favorite, p.openCount, p.createdAt], [['bread'], 'try at 75%', ['food-drink'], true, 3, '2026-09-01T10:00:00Z']);
  assert.equal(p.title, 'Shaping a batard', 'its title too, while the new link has only the one made from its address');
  assert.equal(store.getState().removed.length, 0);
});

check('the same post saved twice: grouped, merged into the link chosen, the other remembered; Undo', () => {
  const other = post('p2', 'https://twitter.com/bakehouse_kit/status/1001?s=20', { title: 'Bakehouse Kit on X', tags: ['sourdough'], userNotes: 'from Ana',
    categories: ['uncategorized'], createdAt: '2026-08-01T10:00:00Z', pinned: true });
  fresh([loaf(), other, post('p3', 'https://example.org/walks')]);
  const groups = lib.findDuplicates(store.getState().posts);
  assert.deepEqual(groups.map(g => [g.key, g.posts.map(p => p.id)]), [['x:1001', ['p2', 'p1']]]);
  assert.equal(lib.keeperOf(groups[0].posts).id, 'p2', 'no saved copy: the one saved first');
  const merge = store.getState().mergeDuplicates('p1', ['p2']);
  let s = store.getState();
  const kept = s.posts.find(p => p.id === 'p1');
  assert.deepEqual([kept.title, kept.url, kept.tags, kept.categories, kept.userNotes, kept.createdAt, kept.pinned, kept.favorite],
    ['Shaping a batard', 'https://x.com/bakehouse_kit/status/1001', ['bread', 'sourdough'], ['food-drink'], 'try at 75%\n\nfrom Ana', '2026-08-01T10:00:00Z', true, true]);
  assert.equal(s.posts.some(p => p.id === 'p2'), false);
  assert.deepEqual(s.removed.map(r => [r.how, r.into]), [['merged', 'https://x.com/bakehouse_kit/status/1001']]);
  assert.equal(lib.removedFor(kept, s.removed), undefined, 'the kept link is not offered what it already holds');
  assert.equal(lib.findDuplicates(s.posts).length, 0);
  later();
  assert.deepEqual(store.getState().undoDuplicateMerge(merge), { restored: 2, skipped: 0 });
  s = store.getState();
  assert.deepEqual(s.posts.find(p => p.id === 'p1').tags, ['bread']);
  assert.equal(s.posts.find(p => p.id === 'p2').userNotes, 'from Ana');
  assert.equal(s.history.find(h => h.undo.kind === 'duplicates').undone.restored, 2, 'History shows it undone');
});

check('Undo of a merge leaves the kept link alone when it changed since, and still brings the other back', () => {
  fresh([loaf(), post('p2', 'https://twitter.com/bakehouse_kit/status/1001')]);
  const merge = store.getState().mergeDuplicates('p1', ['p2']);
  later();
  store.getState().updatePost('p1', { userNotes: 'changed after' });
  assert.deepEqual(store.getState().undoDuplicateMerge(merge), { restored: 1, skipped: 1 });
  assert.equal(store.getState().posts.find(p => p.id === 'p1').userNotes, 'changed after');
});

check('History: any batch can be undone, not only the last; each says what came back', () => {
  fresh([post('a', 'https://example.org/a', { tags: ['old'] }), post('b', 'https://example.org/b', { tags: ['old'] }), post('c', 'https://example.org/c')]);
  store.getState().bulkEdit(['a', 'b'], { tags: { mode: 'add', values: ['to-bake'] } });
  later();
  store.getState().mergeTag('old', 'archive');
  later();
  store.getState().deletePosts(['c']);
  let s = store.getState();
  assert.deepEqual(s.history.map(h => h.text), ['Removed 1 link', 'Merged #old into #archive', 'Bulk edit: added #to-bake']);
  // The oldest one: both links changed again since (the tag merge), so they are left as they are.
  const bulk = s.history[2];
  assert.deepEqual(store.getState().undoHistory(bulk.id), { restored: 0, skipped: 2 });
  // The tag merge, in the middle: its links are as it left them.
  assert.deepEqual(store.getState().undoHistory(s.history[1].id), { restored: 2, skipped: 0 });
  assert.deepEqual(store.getState().posts.find(p => p.id === 'a').tags, ['old', 'to-bake']);
  assert.deepEqual(store.getState().undoHistory(s.history[0].id), { restored: 1, skipped: 0 });
  assert.ok(store.getState().posts.some(p => p.id === 'c'));
  s = store.getState();
  assert.ok(s.history.every(h => h.undone), 'each is marked undone');
  assert.equal(store.getState().undoHistory(bulk.id), null, 'and not undone twice');
});

check('an Undo from the note marks its History entry undone', () => {
  fresh([post('a', 'https://example.org/a')]);
  const records = store.getState().bulkEdit(['a'], { status: 'reference' });
  later();
  store.getState().undoEdit(records);
  assert.equal(store.getState().history[0].undone.restored, 1);
});

check('at most the most recent removed links are kept; older records are deleted in SQLite too', () => {
  const many = Array.from({ length: lib.REMOVED_LIMIT + 5 }, (_, i) => post(`m${i}`, `https://example.org/m${i}`));
  fresh(many);
  store.getState().deletePosts(many.slice(0, 5).map(p => p.id));
  later();
  store.getState().deletePosts(many.slice(5).map(p => p.id));
  const s = store.getState();
  assert.equal(s.removed.length, lib.REMOVED_LIMIT);
  assert.equal(Object.keys(s.deletedRemoved).length, 5);
});

check('a removal bigger than what is remembered says so; marks and records stay within what SQLite takes', () => {
  const many = Array.from({ length: lib.REMOVED_LIMIT + 3 }, (_, i) => post(`m${i}`, `https://example.org/m${i}`));
  fresh(many);
  store.getState().deletePosts(many.map(p => p.id));
  const s = store.getState();
  assert.equal(s.history[0].text, `Removed ${lib.REMOVED_LIMIT + 3} links (${lib.REMOVED_LIMIT} can be brought back)`);
  assert.equal(s.history[0].undo.ids.length, lib.REMOVED_LIMIT);
  assert.equal(s.posts.length, 0, 'all of them are removed');
  const marks = Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`r-${String(i).padStart(16, '0')}`, `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00.000Z`]));
  assert.equal(Object.keys(lib.capMarks(marks)).length, lib.REMOVED_MARKS_LIMIT);
  const long = lib.rememberRemoved(post('n', 'https://example.org/n', { userNotes: 'наша заметка '.repeat(400), description: 'описание '.repeat(300) }), '2026-10-25T00:00:00.000Z');
  const stored = [...JSON.stringify(long.post)].reduce((n, ch) => n + (ch.charCodeAt(0) > 127 ? 6 : 1), 0);
  assert.ok(stored <= 20000, `the record fits SQLite's limit (${stored})`);
  assert.ok(long.post.userNotes.startsWith('наша заметка'), 'the start of the note is kept');
});
check('a record names its post by its address, not by the key it carries', () => {
  fresh([]);
  store.setState({ removed: [{ id: 'r-00000000000000aa', url: 'https://example.org/a', key: 'yt:dQw4w9WgXcQ', how: 'removed', removedAt: '2026-10-20T00:00:00.000Z',
    post: post('a', 'https://example.org/a') }] });
  const result = store.getState().importPosts([post('v', 'https://youtu.be/dQw4w9WgXcQ')]);
  assert.equal(result.added, 1, 'a crafted key does not keep that video out');
});

if (failures) { console.error(`FAILED ${failures}`); process.exit(1); }
console.log('ALL PASS');
process.exit(0);   // the store's timers would keep Node running
