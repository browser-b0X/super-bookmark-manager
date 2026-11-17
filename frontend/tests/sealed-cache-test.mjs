// The browser's copy of the library in the installed app: sealed with a key only the app's own pages get, so a page of
// another program at the app's address reads nothing (lib/cacheSeal). In Node with a stand-in browser; each "page" gets
// its own copy of the modules, as a page load does, and the key comes from its meta tag. Synthetic links only.
// Run from frontend/: node tests/sealed-cache-test.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const NAME = 'library-store-v1';
const SECRET = 'Rye loaf only the owner saved';
const KEY = 'ab'.repeat(32);
const memory = new Map();
const kv = new Map();
globalThis.localStorage = { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), removeItem: k => memory.delete(k) };
const events = new EventTarget();
globalThis.window = globalThis;
globalThis.addEventListener = events.addEventListener.bind(events);
globalThis.removeEventListener = events.removeEventListener.bind(events);
globalThis.innerWidth = 1400;
const fakeDb = {
  transaction() {
    const tx = { oncomplete: null, onerror: null, onabort: null };
    const request = work => { const r = { result: undefined }; setTimeout(() => { r.result = work(); tx.oncomplete?.(); }, 0); return r; };
    tx.objectStore = () => ({
      get: key => request(() => kv.get(key)),
      put: (value, key) => request(() => { kv.set(key, value); }),
      delete: key => request(() => { kv.delete(key); }),
    });
    return tx;
  },
};
globalThis.indexedDB = { open() { const r = {}; setTimeout(() => { r.result = fakeDb; r.onsuccess?.(); }, 0); return r; } };

const out = await build({
  stdin: { contents: `export { useLibrary } from './src/store/library'; export { useStorageHealth } from './src/lib/libraryStorage'; export { usePrefs } from './src/store/prefs';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', define: { 'import.meta.env.DEV': 'false' },
});
let copy = 0;
const page = (key, made = false) => {
  globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible',
    querySelector: selector => (key && selector.includes('sbm-cache-key') ? { content: key } : made && selector.includes('sbm-cache-new') ? { content: '1' } : null) };
  return import('data:text/javascript;base64,' + Buffer.from(`${out.outputFiles[0].text}\n// page ${++copy}`).toString('base64'));
};
const at = new Date('2026-10-01T10:00:00Z').toISOString();
const link = (i, title = `Cached ${i}`) => ({ id: `c-${i}`, url: `https://cache${i}.example.invalid/`, source: 'browser', platform: 'web',
  domain: `cache${i}.example.invalid`, status: 'reference', createdAt: at, updatedAt: at, categories: ['other'], tags: [], projectIds: [], title });
const settle = () => new Promise(resolve => setTimeout(resolve, 40));
// With nothing in localStorage the store first looks in IndexedDB, and drops writes until it has.
const ready = async (key, made) => { const loaded = await page(key, made); await settle(); return loaded; };
const titles = store => store.getState().posts.map(post => post.title);
const stored = () => memory.get(NAME);
const reset = () => { memory.clear(); kv.clear(); };

async function test(name, run) {
  reset();
  await run();
  console.log(`PASS ${name}`);
}

await test('what the store keeps is unreadable without the key', async () => {
  const { useLibrary } = await ready(KEY);
  useLibrary.setState({ posts: [link(1, SECRET)] });
  assert.match(stored(), /^sbm-sealed-1:/);
  assert.ok(!stored().includes(SECRET) && !stored().includes('cache1.example'), 'nothing of the link shows');
  assert.ok(!Buffer.from(stored().slice(13), 'base64').toString('latin1').includes(SECRET), 'nor once decoded');
});

await test('the next page with the key has it in its first paint, as before', async () => {
  (await ready(KEY)).useLibrary.setState({ posts: [link(1, SECRET)] });
  const { useLibrary } = await page(KEY);
  assert.deepEqual(titles(useLibrary), [SECRET], 'read at once, not a moment later');
});

await test('a page without the key, or with another, gets nothing and breaks nothing', async () => {
  (await ready(KEY)).useLibrary.setState({ posts: [link(1, SECRET)] });
  for (const key of ['', 'cd'.repeat(32)]) {
    const { useLibrary } = await page(key);
    await settle();
    assert.deepEqual(titles(useLibrary), []);
  }
});

await test('a copy changed since it was sealed is not believed', async () => {
  (await ready(KEY)).useLibrary.setState({ posts: [link(1, SECRET)] });
  const text = stored();
  const flipped = text.at(-6) === 'A' ? 'B' : 'A';
  memory.set(NAME, text.slice(0, -6) + flipped + text.slice(-5));
  const { useLibrary } = await page(KEY);
  await settle();
  assert.deepEqual(titles(useLibrary), []);
});

await test("another cache's sealed copy can't stand in for this one", async () => {
  (await ready(KEY)).useLibrary.setState({ posts: [link(1, SECRET)] });
  const { sealText } = await import('data:text/javascript;base64,' + Buffer.from(`${(await build({
    stdin: { contents: `export { sealText } from './src/lib/cacheSeal';`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' })).outputFiles[0].text}`).toString('base64'));
  memory.set(NAME, sealText('prefs-store-v1', JSON.stringify({ state: { posts: [link(2, 'Passed off')] }, version: 6 })));
  const { useLibrary } = await page(KEY);
  await settle();
  assert.deepEqual(titles(useLibrary), []);
});

await test('the old plain cache is read in the run that made the key, and sealed at once', async () => {
  memory.set(NAME, JSON.stringify({ state: { posts: [link(1, SECRET)], pending: {}, deletedUrls: [] }, version: 6 }));
  const { useLibrary } = await page(KEY, true);
  assert.deepEqual(titles(useLibrary), [SECRET]);
  await settle();
  assert.match(stored(), /^sbm-sealed-1:/);
  assert.ok(!stored().includes(SECRET));
});

await test('after that a plain copy is planted, and counts for nothing: not its links, not its unsaved edits', async () => {
  const planted = { state: { posts: [link(1, 'Planted')], pending: { 'https://planted.example.invalid/': link(2, 'Planted') }, deletedUrls: [], syncRev: 9999 }, version: 6 };
  memory.set(NAME, JSON.stringify(planted));
  const { useLibrary } = await page(KEY);
  await settle();
  assert.deepEqual(titles(useLibrary), []);
  assert.deepEqual(useLibrary.getState().pending, {});
  assert.notEqual(useLibrary.getState().syncRev, 9999);
  kv.set(NAME, JSON.stringify(planted));
  memory.set(NAME, '{"sbmStorage":"indexeddb"}');
  const big = await page(KEY);
  await settle();
  assert.deepEqual(titles(big.useLibrary), [], 'nor in IndexedDB');
});

for (const [name, made] of [['a tab', false], ['a tab from the run that made the key, left open after it', true]]) {
  await test(`a plain copy planted while ${name} is open changes nothing, and isn't sealed`, async () => {
    const { useLibrary } = await ready(KEY, made);
    useLibrary.setState({ posts: [link(1, SECRET)] });
    const planted = JSON.stringify({ state: { posts: [link(2, 'Planted')], pending: { 'https://planted.example.invalid/': link(2, 'Planted') } }, version: 6 });
    memory.set(NAME, planted);
    await useLibrary.persist.rehydrate();
    await settle();
    assert.deepEqual(titles(useLibrary), [SECRET]);
    assert.deepEqual(useLibrary.getState().pending, {});
    assert.equal(stored(), planted);
  });
}

await test('whatever else is planted in IndexedDB breaks nothing: the page still finishes loading', async () => {
  for (const value of [null, 7, {}, [], true]) {
    memory.set(NAME, '{"sbmStorage":"indexeddb"}');
    kv.set(NAME, value);
    const { useLibrary } = await page(KEY);
    await settle();
    assert.equal(useLibrary.persist.hasHydrated(), true, String(value));
    assert.deepEqual(titles(useLibrary), []);
  }
});

await test('settings that start things by themselves are sealed, and a planted one counts for nothing', async () => {
  const NAME_PREFS = 'prefs-store-v1';
  const { usePrefs } = await ready(KEY);
  usePrefs.getState().setAiKeepSorting(true);
  assert.match(memory.get(NAME_PREFS), /^sbm-sealed-1:/);
  assert.equal((await page(KEY)).usePrefs.getState().aiKeepSorting, true, 'kept, and read at once');
  memory.set(NAME_PREFS, JSON.stringify({ state: { aiKeepSorting: true, theme: 'light' }, version: 0 }));
  assert.equal((await page(KEY)).usePrefs.getState().aiKeepSorting, false);
  memory.set(NAME_PREFS, JSON.stringify({ state: { theme: 'light' }, version: 0 }));
  const upgraded = await page(KEY, true);
  assert.equal(upgraded.usePrefs.getState().theme, 'light', 'the old settings, in the run that made the key');
  assert.match(memory.get(NAME_PREFS), /^sbm-sealed-1:/);
});

await test('a big library is sealed in IndexedDB too, and a plain one there is sealed once read', async () => {
  const posts = Array.from({ length: 4000 }, (_, i) => ({ ...link(i, `${SECRET} ${i}`), notes: 'x'.repeat(600) }));
  const big = await ready(KEY);
  big.useLibrary.setState({ posts });
  await settle();
  await settle();
  assert.equal(big.useStorageHealth.getState().backend, 'indexeddb');
  assert.equal(stored(), '{"sbmStorage":"indexeddb"}', 'only the marker in localStorage');
  const value = kv.get(NAME);
  assert.ok(value instanceof Uint8Array);
  assert.ok(!Buffer.from(value).toString('latin1').includes(SECRET));
  const again = await page(KEY);
  await settle();
  assert.equal(again.useLibrary.getState().posts.length, 4000);

  kv.set(NAME, JSON.stringify({ state: { posts, pending: {}, deletedUrls: [] }, version: 6 }));
  const upgraded = await page(KEY, true);
  await settle();
  await settle();
  assert.equal(upgraded.useLibrary.getState().posts.length, 4000);
  assert.ok(kv.get(NAME) instanceof Uint8Array, 'no plain copy left');
});

await test('a source run has no key and keeps plain text as it always has', async () => {
  (await ready('')).useLibrary.setState({ posts: [link(1, SECRET)] });
  assert.ok(stored().includes(SECRET));
  const { useLibrary } = await page('');
  assert.deepEqual(titles(useLibrary), [SECRET]);
});

console.log('sealed-cache-test passed');
process.exit(0);   // the store keeps timers running
