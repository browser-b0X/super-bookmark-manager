// Nested tags (v0.4.0 phase 6a, mockup Claude outputs/v040-review/phase6a/mockup-6): a tag can sit under several
// others and have other names; a search for a tag finds both; names and parents are checked before they're added;
// merging keeps both names and has Undo. Synthetic links only. Run from frontend/: node tests/nested-tags-test.mjs
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
  stdin: { contents: `export { useLibrary } from './src/store/library'; export * from './src/lib/tags'; export { parseQuery, matchesQuery } from './src/lib/librarySearch'; export { mergeById, mergeDeletions } from './src/lib/cacheMerge';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' },
});
const lib = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const tag = (name, parents = [], aliases = []) => ({ id: name, name, parents, aliases, updatedAt: '2026-10-20T10:00:00.000Z' });
const post = (id, tags) => ({ id, url: `https://example.org/${id}`, source: 'manual', platform: 'web', domain: 'example.org', status: 'inbox', title: id,
  categories: [], tags, projectIds: [], createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z', metadataStatus: 'none' });
const info = [tag('colour-bars', ['pattern', 'broadcast'], ['bars']), tag('smpte', ['colour-bars']), tag('pattern'), tag('loop-a', ['loop-b']), tag('loop-b', ['loop-a'])];
let failures = 0;
const check = (name, run) => { try { run(); console.log(`PASS ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}: ${e.message.split('\n').slice(0, 4).join(' | ')}`); } };

check('a tag finds its other names and every tag under it, under several parents', () => {
  const look = lib.tagLookup(info);
  assert.deepEqual(look.expand('pattern').sort(), ['bars', 'colour-bars', 'pattern', 'smpte']);
  assert.deepEqual(look.expand('broadcast').sort(), ['bars', 'broadcast', 'colour-bars', 'smpte'], 'the second parent too');
  assert.deepEqual(look.expand('bars').sort(), ['bars', 'colour-bars', 'smpte'], 'another name stands for its tag');
  assert.deepEqual(look.expand('loop-a').sort(), ['loop-a', 'loop-b'], 'tags that loop still end');
  const posts = [post('one', ['smpte']), post('two', ['bars']), post('three', ['walks'])];
  const found = q => posts.filter(p => lib.matchesQuery(p, lib.parseQuery(q), look)).map(p => p.id).join(' ');
  assert.equal(found('#pattern'), 'one two');
  assert.equal(found('-#broadcast'), 'three');
});
check('a name belongs to one tag; a tag of its own is merged, not renamed into another\'s name', () => {
  assert.equal(lib.aliasProblem(info, ['walks'], 'colour-bars', 'colorbars'), null);
  assert.match(lib.aliasProblem(info, [], 'colour-bars', 'pattern'), /is a tag of its own: merge it into #colour-bars instead/);
  assert.match(lib.aliasProblem(info, ['walks'], 'colour-bars', 'walks'), /is on links already/);
  assert.match(lib.aliasProblem(info, [], 'pattern', 'bars'), /already another name of #colour-bars/);
  assert.match(lib.aliasProblem(info, [], 'pattern', 'pattern'), /own name/);
});
check('a tag can\'t go under itself or one of its sub-tags', () => {
  assert.equal(lib.parentProblem(info, 'smpte', 'pattern'), null);
  assert.match(lib.parentProblem(info, 'colour-bars', 'smpte'), /under #colour-bars already/);
  assert.match(lib.parentProblem(info, 'pattern', 'pattern'), /itself/);
});
check('merging: links take the target, the source stays as another name, tags under it move', () => {
  const store = lib.useLibrary;
  store.setState({ posts: [post('a', ['colorbars', 'video']), post('b', ['colour-bars']), post('c', ['walks'])], pending: {},
    tagInfo: [tag('colour-bars', ['pattern'], ['bars']), tag('colorbars', ['broadcast'], ['cbars']), tag('tiny', ['colorbars'])], deletedTags: {} });
  const merge = store.getState().mergeTag('colorbars', 'colour-bars');
  const s = store.getState();
  const by = Object.fromEntries(s.posts.map(p => [p.id, p]));
  assert.deepEqual(by.a.tags, ['colour-bars', 'video']);
  const target = s.tagInfo.find(t => t.name === 'colour-bars');
  assert.deepEqual([target.aliases, target.parents], [['bars', 'colorbars', 'cbars'], ['pattern', 'broadcast']]);
  assert.deepEqual(s.tagInfo.find(t => t.name === 'tiny').parents, ['colour-bars']);
  assert.equal(s.tagInfo.some(t => t.name === 'colorbars'), false);
  assert.ok(s.deletedTags.colorbars, 'the deletion reaches other browsers');
  assert.deepEqual(merge.links.map(l => l.id), ['a']);
  for (const until = Date.now() + 3; Date.now() < until;) { /* a later moment */ }
  const result = store.getState().undoTagMerge(merge);
  assert.deepEqual(result, { restored: 1, skipped: 0 });
  const after = store.getState();
  assert.deepEqual(after.posts.find(p => p.id === 'a').tags, ['colorbars', 'video']);
  assert.deepEqual(after.tagInfo.find(t => t.name === 'colorbars').aliases, ['cbars'], 'the source is back');
  assert.deepEqual(after.tagInfo.find(t => t.name === 'colour-bars').aliases, ['bars']);
  assert.deepEqual(after.tagInfo.find(t => t.name === 'tiny').parents, ['colorbars']);
  assert.equal(after.deletedTags.colorbars, undefined);
});
check('a tag called "constructor" keeps its record through merges between tabs', () => {
  const kept = tag('constructor', ['pattern']);
  assert.deepEqual(lib.mergeById([kept], [], lib.mergeDeletions({}, {})).map(t => t.name), ['constructor'], 'not taken for a deletion');
  assert.deepEqual(Object.keys(lib.mergeDeletions({ constructor: new Date().toISOString() }, {})), ['constructor']);
});
check('Undo of a merge leaves alone tag records changed since', () => {
  const store = lib.useLibrary;
  store.setState({ posts: [post('a', ['colorbars'])], pending: {}, tagInfo: [tag('colour-bars', [], ['bars'])], deletedTags: {} });
  const merge = store.getState().mergeTag('colorbars', 'colour-bars');
  for (const until = Date.now() + 3; Date.now() < until;) { /* a later moment */ }
  store.getState().setTagInfo('colour-bars', { parents: ['pattern'] });          // changed since the merge
  store.getState().undoTagMerge(merge);
  const target = store.getState().tagInfo.find(t => t.name === 'colour-bars');
  assert.deepEqual(target.parents, ['pattern'], 'the later change stands');
  assert.deepEqual(store.getState().posts[0].tags, ['colorbars'], 'the link comes back');
});

check('renaming is merging into a new name: the new record is made, and removed again by Undo', () => {
  const store = lib.useLibrary;
  store.setState({ posts: [post('a', ['bred'])], pending: {}, tagInfo: [], deletedTags: {} });
  const merge = store.getState().mergeTag('bred', 'bread');
  assert.deepEqual(store.getState().posts[0].tags, ['bread']);
  assert.deepEqual(store.getState().tagInfo.map(t => [t.name, t.aliases]), [['bread', ['bred']]]);
  for (const until = Date.now() + 3; Date.now() < until;) { /* a later moment */ }
  store.getState().undoTagMerge(merge);
  assert.deepEqual(store.getState().tagInfo, []);
  assert.ok(store.getState().deletedTags.bread);
});

if (failures) { console.error(`FAILED ${failures}`); process.exit(1); }
console.log('ALL PASS');
process.exit(0);   // the store's timers would keep Node running
