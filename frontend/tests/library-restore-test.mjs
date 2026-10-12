// The browser's side of "Restore backup", in Node with a stand-in /api/library. Synthetic links only.
// A restore replaces the library on the server; the browser's own copy (and any unsaved edit to a
// link of the replaced library) must not merge back into it. Found after a fresh install: restore
// left the library empty, and the old design needed a fresh browser profile for this reason.
// Run from frontend/: node tests/library-restore-test.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const memory = new Map();
globalThis.localStorage = { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), removeItem: k => memory.delete(k), clear: () => memory.clear() };
const events = new EventTarget();
globalThis.window = globalThis;
globalThis.addEventListener = events.addEventListener.bind(events);
globalThis.removeEventListener = events.removeEventListener.bind(events);
globalThis.document = { addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, visibilityState: 'visible', documentElement: { dataset: {}, style: { setProperty() {} } } };
globalThis.innerWidth = 1400;

const at = '2026-10-01T10:00:00Z';
const link = (name, extra = {}) => ({ id: `r-${name}`, url: `https://${name}.example.invalid/`, source: 'browser', platform: 'web', domain: `${name}.example.invalid`,
  status: 'reference', createdAt: at, updatedAt: at, metadataStatus: 'partial', categories: ['other'], tags: [], projectIds: [], title: name, ...extra });

// The stand-in server: one library; a restore swaps it and moves the epoch on.
const server = { posts: [], deletedUrls: [], categories: ['technology', 'other', 'uncategorized'], rev: 1, epoch: 0 };
const writes = [];
const snapshot = () => ({ posts: server.posts, deletedUrls: server.deletedUrls, legacyRows: [], categories: server.categories, rev: server.rev, epoch: server.epoch });
globalThis.fetch = async (url, options = {}) => {
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (!String(url).startsWith('/api/library')) return json({}, 404);
  if ((options.method ?? 'GET') === 'GET') { const answer = snapshot(); await after('read'); return json(answer); }
  await after('write');
  const body = JSON.parse(options.body);
  if ((body.epoch ?? 0) !== server.epoch) {
    return json({ ok: false, code: 'library_replaced', error: 'This library was replaced by a restore.' }, 409);
  }
  writes.push(body.posts.map(p => p.title));
  for (const post of body.posts) server.posts = [...server.posts.filter(p => p.url !== post.url), post];
  server.rev += 1;
  return json({ ok: true, ...snapshot() });
};
const restoreOnServer = (posts, categories) => { server.posts = posts; server.categories = categories; server.rev += 1; server.epoch = server.rev; };
// Something that happens on the server right after it reads this tab's next answer (or receives its next write);
// the answer waits for the promise a hook returns.
const hooks = { read: null, write: null };
const after = kind => { const run = hooks[kind]; hooks[kind] = null; return run?.(); };

const out = await build({
  stdin: {
    contents: `export { useLibrary } from './src/store/library';\nexport { syncLibrary, syncRestoredLibrary } from './src/lib/libraryPersistence';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' },
});
const { useLibrary, syncLibrary, syncRestoredLibrary } = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const fresh = useLibrary.getState();
const titles = () => useLibrary.getState().posts.map(p => p.title).sort();
const failures = [];
const check = async (name, run) => {
  useLibrary.setState({ ...fresh, posts: [], pending: {}, deletedUrls: [], rejected: {}, purgeUrls: [], undeleteUrls: [], imports: [], syncRev: 0, syncEpoch: undefined }, false);
  Object.assign(server, { posts: [link('a'), link('b')], deletedUrls: [], categories: ['technology', 'other', 'uncategorized'], rev: 1, epoch: 0 });
  writes.length = 0;
  hooks.read = hooks.write = null;
  try { await run(); console.log('PASS', name); } catch (error) { failures.push(name); console.error('FAIL', name, '\n ', error.message.split('\n').slice(0, 6).join('\n  ')); }
};

await check('after a restore, this browser takes the restored library whole (the old links do not stay)', async () => {
  assert.equal(await syncLibrary(), true);
  assert.deepEqual(titles(), ['a', 'b']);
  assert.equal(useLibrary.getState().syncEpoch, 0);
  restoreOnServer([link('c'), link('d')], ['travel', 'technology', 'other', 'uncategorized']);
  assert.equal(await syncLibrary(), true);
  assert.deepEqual(titles(), ['c', 'd']);
  assert.equal(useLibrary.getState().syncEpoch, server.epoch);
});

await check('an unsaved edit to a link of the replaced library is dropped, not written into the restored one', async () => {
  await syncLibrary();
  restoreOnServer([link('c')], ['technology', 'other', 'uncategorized']);
  const edited = { ...link('a'), title: 'edited a', updatedAt: '2026-10-02T10:00:00Z' };
  useLibrary.setState(s => ({ posts: s.posts.map(p => (p.id === 'r-a' ? edited : p)), pending: { [edited.url]: edited } }));
  assert.equal(await syncLibrary(), true);
  assert.deepEqual(writes, [], 'nothing from the old library was written');
  assert.deepEqual(titles(), ['c']);
  assert.deepEqual(useLibrary.getState().pending, {});
  assert.deepEqual(server.posts.map(p => p.title), ['c']);
});

await check('the shelves are the restored library\'s, keeping the colours of shelves already known here', async () => {
  await syncLibrary();
  const before = new Map(useLibrary.getState().categories.map(c => [c.name, c.color]));
  restoreOnServer([link('c', { categories: ['travel'] })], ['travel', 'garden', 'other', 'uncategorized']);
  await syncLibrary();
  const shelves = useLibrary.getState().categories;
  assert.deepEqual(shelves.map(c => c.name).sort(), ['garden', 'other', 'travel', 'uncategorized']);
  assert.equal(shelves.find(c => c.name === 'travel').color, before.get('travel'));
  assert.ok(shelves.every(c => typeof c.color === 'string' && c.color));
});

await check('saves after a restore go through as usual (with the new epoch)', async () => {
  await syncLibrary();
  restoreOnServer([link('c')], ['technology', 'other', 'uncategorized']);
  await syncLibrary();
  const added = link('e', { title: 'e' });
  useLibrary.setState(s => ({ posts: [...s.posts, added], pending: { [added.url]: added } }));
  assert.equal(await syncLibrary(), true);
  assert.deepEqual(writes, [['e']]);
  assert.deepEqual(server.posts.map(p => p.title).sort(), ['c', 'e']);
});

await check('another tab\'s cache from the restored library wins over this tab\'s copy of the old one (and its unsaved edits)', async () => {
  const merge = useLibrary.persist.getOptions().merge;
  const old = { ...useLibrary.getState(), posts: [link('a')], pending: { 'https://a.example.invalid/': link('a', { title: 'edited a' }) }, syncEpoch: 0 };
  const restored = { posts: [link('c')], pending: {}, syncEpoch: 9, syncRev: 9 };
  const taken = merge(restored, old);
  assert.deepEqual(taken.posts.map(p => p.title), ['c']);
  assert.deepEqual(taken.pending, {});
  // A late write from a tab still on the old library doesn't pull a restored tab back.
  const kept = merge({ posts: [link('a')], pending: {}, syncEpoch: 0 }, { ...useLibrary.getState(), posts: [link('c')], pending: {}, syncEpoch: 9 });
  assert.deepEqual(kept.posts.map(p => p.title), ['c']);
  assert.equal(kept.syncEpoch, 9);
});

await check('a restore that lands between this tab\'s read and its save is refused by SQLite, and the tab takes the restored library', async () => {
  await syncLibrary();
  const edited = { ...link('a'), title: 'edited a', updatedAt: '2026-10-02T10:00:00Z' };
  useLibrary.setState(s => ({ posts: s.posts.map(p => (p.id === 'r-a' ? edited : p)), pending: { [edited.url]: edited } }));
  hooks.read = () => restoreOnServer([link('c')], ['technology', 'other', 'uncategorized']);
  assert.equal(await syncLibrary(), true);
  assert.deepEqual(writes, [], 'the edit was refused, not written');
  assert.deepEqual(titles(), ['c']);
  assert.deepEqual(useLibrary.getState().pending, {});
  assert.equal(useLibrary.getState().syncEpoch, server.epoch);
});

await check('before any restore, a cache from an older version (no epoch yet) keeps and saves its unsaved edits', async () => {
  const edited = { ...link('a'), title: 'edited a', updatedAt: '2026-10-02T10:00:00Z' };
  useLibrary.setState({ posts: [edited, link('b')], pending: { [edited.url]: edited }, syncRev: 1 });
  assert.equal(await syncLibrary(), true);
  assert.deepEqual(writes, [['edited a']]);
  assert.deepEqual(titles(), ['b', 'edited a']);
  assert.equal(useLibrary.getState().syncEpoch, 0);
});

await check('a cache that never read an epoch, opened after a restore elsewhere, takes the restored library', async () => {
  useLibrary.setState({ posts: [link('a'), link('old')], pending: { [link('old').url]: link('old') }, syncRev: 1 });
  restoreOnServer([link('c')], ['technology', 'other', 'uncategorized']);
  assert.equal(await syncLibrary(), true);
  assert.deepEqual(writes, []);
  assert.deepEqual(titles(), ['c']);
});

await check('after restoring here, this tab ends up with the restored library even if a sync was already reading', async () => {
  await syncLibrary();
  let epoch, release;
  const gate = new Promise(resolve => { release = resolve; });
  // A sync reads the library, the restore lands, and only then does that (old) answer arrive.
  hooks.read = () => { restoreOnServer([link('c')], ['technology', 'other', 'uncategorized']); epoch = server.epoch; return gate; };
  const running = syncLibrary();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(epoch > 0, 'the restore landed while that sync was reading');
  const restoring = syncRestoredLibrary(epoch);
  release();
  assert.equal(await restoring, true);
  assert.deepEqual(titles(), ['c']);
  assert.equal(await running, true);
});

if (failures.length) { console.error(`FAILED ${failures.length}: ${failures.join('; ')}`); process.exit(1); }
console.log('ALL PASS');
process.exit(0);   // the store keeps timers running
