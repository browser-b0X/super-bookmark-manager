// The "reviewed" lock (v0.4.0 phase 6a, mockup Claude outputs/v040-review/phase6a/mockup-4): a link the owner marked
// Reviewed is left alone by Tidy up with AI (also when picked by hand, and when marked during a run), by automatic
// shelves, automatic preview retries and refreshes; the owner can still edit it. Synthetic links only.
// Run from frontend/: node tests/reviewed-lock-test.mjs
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
globalThis.document = { addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, visibilityState: 'visible', documentElement: { dataset: {}, style: { setProperty() {} } },
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, innerHTML: '', value: '', textContent: '' }) };
globalThis.innerWidth = 1400;

const out = await build({
  stdin: {
    contents: `
      export { useLibrary } from './src/store/library';
      export { linksInScope, meaningful } from './src/lib/aiTidy';
      export { needsEnrichment, isStale } from './src/lib/metadataEnrichment';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' },
});
const lib = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const post = (id, changes = {}) => ({ id, url: `https://example.org/${id}`, source: 'import', platform: 'web', domain: 'example.org',
  status: 'inbox', title: id, categories: ['other'], categoryMode: 'automatic', categoryReview: true, tags: [], projectIds: [],
  createdAt: '2026-01-01T10:00:00Z', updatedAt: '2026-01-01T10:00:00Z', metadataStatus: 'enriched', enrichedAt: '2026-01-01T10:00:00Z', ...changes });
let failures = 0;
const check = (name, run) => { try { run(); console.log(`PASS ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}: ${e.message.split('\n').slice(0, 4).join(' | ')}`); } };

const open = post('open');
const locked = post('locked', { reviewed: true });

check('Tidy up with AI leaves reviewed links out, also when picked by hand', () => {
  assert.deepEqual(lib.linksInScope([open, locked], 'unsorted').map(p => p.id), ['open']);
  assert.deepEqual(lib.linksInScope([open, locked], 'all').map(p => p.id), ['open']);
  assert.deepEqual(lib.linksInScope([open, locked], 'selected', ['open', 'locked']).map(p => p.id), ['open']);
});
check('a suggestion for a link marked Reviewed during the run is not applied', () => {
  const suggestion = { id: 'locked', shelf: 'travel', tags: ['walks'] };
  assert.ok(lib.meaningful(open, { ...suggestion, id: 'open' }, ['shelf', 'tags']), 'an open link takes it');
  assert.equal(lib.meaningful(locked, suggestion, ['shelf', 'tags']), null);
});
check('no automatic preview retries or refreshes for reviewed links (a new link still gets its first preview)', () => {
  const now = Date.parse('2026-10-25T10:00:00Z');
  const failed = { metadataStatus: 'failed', metadataRetryAt: '2026-10-01T00:00:00Z' };
  assert.equal(lib.needsEnrichment(post('a', failed), now), true);
  assert.equal(lib.needsEnrichment(post('b', { ...failed, reviewed: true }), now), false);
  assert.equal(lib.needsEnrichment(post('c', { metadataStatus: 'pending', reviewed: true }), now), true);
  assert.equal(lib.isStale(post('d'), now), true, 'an old preview is refreshed when looked at');
  assert.equal(lib.isStale(post('e', { reviewed: true }), now), false);
});
check('automatic shelves leave reviewed links alone; the owner can still edit them', () => {
  lib.useLibrary.setState({ posts: [open, locked], pending: {} });
  const shelves = lib.useLibrary.getState().categories.map(c => c.name);
  const target = shelves.find(name => name !== 'other' && name !== 'uncategorized');
  lib.useLibrary.getState().applyAutomaticCategory('open', target);
  lib.useLibrary.getState().applyAutomaticCategory('locked', target);
  const byId = Object.fromEntries(lib.useLibrary.getState().posts.map(p => [p.id, p]));
  assert.deepEqual(byId.open.categories, [target]);
  assert.deepEqual(byId.locked.categories, ['other']);
  lib.useLibrary.getState().updatePost('locked', { categories: [target] });
  assert.deepEqual(lib.useLibrary.getState().posts.find(p => p.id === 'locked').categories, [target], 'the owner\'s own change goes through');
});

if (failures) { console.error(`FAILED ${failures}`); process.exit(1); }
console.log('ALL PASS');
process.exit(0);   // the store's timers would keep Node running
