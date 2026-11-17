// Bulk edit (v0.4.0 phase 6a, mockup Claude outputs/v040-review/phase6a/mockup-5): tags and shelves added, removed
// or replaced and the status set on many links at once, in one write; Undo puts back only links nobody changed
// since. Synthetic links only. Run from frontend/: node tests/bulk-edit-test.mjs
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
  stdin: { contents: `export { useLibrary } from './src/store/library'; export { editPost, cleanTag } from './src/lib/bulkEdit';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' },
});
const lib = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const post = (id, changes = {}) => ({ id, url: `https://example.org/${id}`, source: 'manual', platform: 'web', domain: 'example.org',
  status: 'inbox', title: id, categories: [], tags: [], projectIds: [], createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z',
  metadataStatus: 'none', ...changes });
let failures = 0;
const check = (name, run) => { try { run(); console.log(`PASS ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}: ${e.message.split('\n').slice(0, 4).join(' | ')}`); } };

check('tags: add, remove, replace with; nothing to change is nothing', () => {
  const p = post('a', { tags: ['bread', 'rye'] });
  assert.deepEqual(lib.editPost(p, { tags: { mode: 'add', values: ['rye', 'to-bake'] } }), { tags: ['bread', 'rye', 'to-bake'] });
  assert.deepEqual(lib.editPost(p, { tags: { mode: 'remove', values: ['rye'] } }), { tags: ['bread'] });
  assert.deepEqual(lib.editPost(p, { tags: { mode: 'replace', values: ['walks'] } }), { tags: ['walks'] });
  assert.deepEqual(lib.editPost(p, { tags: { mode: 'replace', values: [] } }), { tags: [] }, 'replace with nothing empties');
  assert.equal(lib.editPost(p, { tags: { mode: 'add', values: ['bread'] } }), null);
  assert.equal(lib.editPost(p, { tags: { mode: 'remove', values: ['walks'] } }), null);
  assert.equal(lib.cleanTag(' #Slow Bread '), 'slow-bread');
});
check('shelves: adding a real shelf takes the link out of other/uncategorized; the owner chose it', () => {
  const p = post('b', { categories: ['other'], categoryMode: 'automatic', categoryReview: true });
  assert.deepEqual(lib.editPost(p, { shelves: { mode: 'add', values: ['travel'] } }), { categories: ['travel'], categoryMode: 'manual', categoryReview: false });
  assert.deepEqual(lib.editPost(post('c', { categories: ['food-drink'] }), { shelves: { mode: 'add', values: ['travel'] } }).categories, ['food-drink', 'travel']);
  assert.deepEqual(lib.editPost(post('d', { categories: ['food-drink', 'travel'] }), { shelves: { mode: 'remove', values: ['travel'] } }).categories, ['food-drink']);
  assert.deepEqual(lib.editPost(post('e', { categories: ['food-drink', 'travel'] }), { shelves: { mode: 'replace', values: ['walks'] } }).categories, ['walks']);
});
check('status is set only where it differs', () => {
  assert.deepEqual(lib.editPost(post('f'), { status: 'reference' }), { status: 'reference' });
  assert.equal(lib.editPost(post('g', { status: 'reference' }), { status: 'reference' }), null);
});
check('one write for the selection, and Undo leaves links changed since alone', () => {
  const store = lib.useLibrary;
  store.setState({ posts: [post('x', { tags: ['bread'] }), post('y', { tags: ['rye'] }), post('z', { tags: ['walks'] })], pending: {} });
  const records = store.getState().bulkEdit(['x', 'y', 'z'], { tags: { mode: 'add', values: ['bread'] }, status: 'reference' });
  assert.equal(records.length, 3, 'x only changes its status, but it changes');
  const by = () => Object.fromEntries(store.getState().posts.map(p => [p.id, p]));
  assert.deepEqual(by().y.tags, ['rye', 'bread']);
  assert.equal(by().z.status, 'reference');
  for (const until = Date.now() + 3; Date.now() < until;) { /* a later moment: times are kept to the millisecond */ }
  store.getState().updatePost('z', { userNotes: 'mine' });          // the owner changes z since
  const result = store.getState().undoEdit(records);
  assert.deepEqual(result, { restored: 2, skipped: 1 });
  assert.deepEqual([by().x.status, by().y.tags], ['inbox', ['rye']]);
  assert.equal(by().z.status, 'reference', 'changed since: left as it is');
  assert.deepEqual(store.getState().bulkEdit(['x'], { tags: { mode: 'remove', values: ['nothing'] } }), [], 'nothing to change: no record');
});

if (failures) { console.error(`FAILED ${failures}`); process.exit(1); }
console.log('ALL PASS');
process.exit(0);   // the store's timers would keep Node running
