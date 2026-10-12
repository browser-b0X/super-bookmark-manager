// The browser cache for big libraries (IndexedDB), in Node with a small stand-in IndexedDB whose
// reads answer late, as a real one does with a big cache. From the pre-release review: a change
// made while the cache was still being read wrote the store's empty starting library over it,
// and other tabs read that cache. Synthetic links only.
// Run from frontend/: node tests/library-cache-test.mjs
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

// Stand-in IndexedDB: one object store; a read answers after READ_MS, a write after a tick.
const READ_MS = 300;
const kv = new Map();
const fakeDb = {
  transaction() {
    const tx = { oncomplete: null, onerror: null, onabort: null };
    const request = (ms, work) => {
      const r = { result: undefined };
      setTimeout(() => { r.result = work(); tx.oncomplete?.(); }, ms);
      return r;
    };
    tx.objectStore = () => ({
      get: key => request(READ_MS, () => kv.get(key)),
      put: (value, key) => request(0, () => { kv.set(key, value); }),
      delete: key => request(0, () => { kv.delete(key); }),
    });
    return tx;
  },
};
globalThis.indexedDB = { open() { const r = {}; setTimeout(() => { r.result = fakeDb; r.onsuccess?.(); }, 0); return r; } };

// A big library already in the cache: localStorage holds only the marker that says where it is.
const KEY = 'library-store-v1';
const at = new Date('2026-10-01T10:00:00Z').toISOString();
const link = i => ({ id: `c-${i}`, url: `https://cache${i}.example.invalid/`, source: 'browser', platform: 'web', domain: `cache${i}.example.invalid`,
  status: 'reference', createdAt: at, updatedAt: at, categories: ['other'], tags: [], projectIds: [], title: `Cached ${i}` });
kv.set(KEY, JSON.stringify({ state: { posts: Array.from({ length: 50 }, (_, i) => link(i)), pending: {}, deletedUrls: [] }, version: 6 }));
memory.set(KEY, '{"sbmStorage":"indexeddb"}');

const out = await build({
  stdin: { contents: `export { useLibrary } from './src/store/library';`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' },
});
// Creating the store starts reading the cache.
const { useLibrary } = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cachedPosts = () => JSON.parse(kv.get(KEY)).state.posts.length;
const failures = [];
const check = async (name, run) => {
  try { await run(); console.log('PASS', name); } catch (error) { failures.push(name); console.error('FAIL', name, '\n ', error.message.split('\n').slice(0, 6).join('\n  ')); }
};

await check('a change while the cache is still being read leaves the cached library alone', async () => {
  assert.equal(useLibrary.persist.hasHydrated(), false, 'the cache is still being read');
  useLibrary.setState({ syncRev: 1 });          // in the app: a sync result, a status note, an import…
  for (let i = 0; i < 40 && !useLibrary.persist.hasHydrated(); i++) await sleep(25);
  assert.equal(useLibrary.getState().posts.length, 50, 'the library was read');
  await sleep(1600);                            // big-cache writes are gathered for a second
  assert.equal(cachedPosts(), 50, 'the cache still holds the library, not the empty starting one');
});

await check('once it has been read, changes are written to the cache as usual', async () => {
  useLibrary.setState(s => ({ posts: [...s.posts, link(50)] }));
  await sleep(1600);
  assert.equal(cachedPosts(), 51);
});

await check('a link saved while the cache of a restored library is still being read is kept', async () => {
  // Another page load (a fresh copy of the store) over a cache that holds a restored library.
  kv.set(KEY, JSON.stringify({ state: { posts: [link(0)], pending: {}, deletedUrls: [], syncRev: 7, syncEpoch: 7 }, version: 6 }));
  memory.set(KEY, '{"sbmStorage":"indexeddb"}');
  const page = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text + '\n// another page load').toString('base64'));
  const store = page.useLibrary;
  assert.equal(store.persist.hasHydrated(), false, 'the cache is still being read');
  const saved = link(99);                       // in the app: the Save window adds a link at once
  store.setState(s => ({ posts: [...s.posts, saved], pending: { ...s.pending, [saved.url]: saved } }));
  for (let i = 0; i < 40 && !store.persist.hasHydrated(); i++) await sleep(25);
  assert.deepEqual(store.getState().posts.map(p => p.id).sort(), ['c-0', 'c-99']);
  assert.deepEqual(Object.keys(store.getState().pending), [saved.url]);
  assert.equal(store.getState().syncEpoch, 7);
});

if (failures.length) { console.error(`FAILED ${failures.length}: ${failures.join('; ')}`); process.exit(1); }
console.log('ALL PASS');
process.exit(0);   // the store keeps timers running
