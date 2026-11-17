// Creators (v0.4.0 phase 6b, mockups in Claude outputs/v040-review/phase6b/): who made a post, from what it already
// holds; matching by handle, then name, then another name, only when exactly one fits; what "Find creators" proposes;
// merging ("same person"), moving posts, and Undo that leaves alone what changed since. Synthetic data only.
// Run from frontend/: node tests/creators-test.mjs
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
  stdin: { contents: `export { useLibrary } from './src/store/library'; export * from './src/lib/creators'; export { parseQuery, matchesQuery } from './src/lib/librarySearch';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' },
});
const lib = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const post = (id, url, changes = {}) => ({ id, url, source: 'browser', platform: 'web', domain: new URL(url).hostname, status: 'inbox', title: id,
  categories: [], tags: [], projectIds: [], createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z', metadataStatus: 'none', ...changes });
const creator = (id, name, handles = [], aliases = []) => ({ id, name, aliases, handles, urls: [], updatedAt: '2026-10-01T10:00:00Z' });
let failures = 0;
const check = (name, run) => { try { run(); console.log(`PASS ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}: ${e.message.split('\n').slice(0, 4).join(' | ')}`); } };

check('who made a post, from its address, author and title only', () => {
  const by = (url, extra) => lib.authorOf(post('p', url, extra));
  assert.deepEqual(by('https://x.com/Bakehouse_Kit/status/123', { author: 'Bakehouse Kit' }),
    { platform: 'x', handle: 'bakehouse_kit', name: 'Bakehouse Kit', profile: 'https://x.com/Bakehouse_Kit' });
  assert.equal(by('https://twitter.com/i/status/123'), null, 'no handle in that address');
  assert.equal(by('https://www.tiktok.com/@ana.field/video/7001').handle, 'ana.field');
  assert.equal(by('https://www.instagram.com/p/Ckit1/', { title: 'bakehouse.kit on Instagram' }).handle, 'bakehouse.kit');
  assert.equal(by('https://www.instagram.com/p/Ckit1/', { title: 'Shaping a loaf' }), null, 'nothing says who');
  assert.deepEqual(by('https://www.reddit.com/r/Breadit/comments/abc/x/', { author: 'u/ryetoast' }).name, 'u/ryetoast');
  assert.deepEqual(by('https://www.youtube.com/watch?v=1', { author: 'Bread Channel' }), { platform: 'youtube', handle: '', name: 'Bread Channel', profile: '' });
  assert.equal(by('https://example.org/an-article', { author: 'Someone' }), null, 'only the social sites');
});
check('matching: handle, then name, then another name; only when exactly one fits', () => {
  const a = creator('c-a', 'Ana Field', [{ platform: 'tiktok', handle: 'ana.field' }]);
  const b = creator('c-b', 'Ana Field', [{ platform: 'instagram', handle: 'anafield' }]);
  const k = creator('c-k', 'Bakehouse Kit', [{ platform: 'x', handle: 'bakehouse_kit' }], ['Kit Bakes']);
  const author = (platform, handle, name) => ({ platform, handle, name, profile: '' });
  assert.equal(lib.matchCreator([a, b, k], author('tiktok', 'ana.field', 'Ana Field')).creator.id, 'c-a', 'the handle decides');
  assert.deepEqual(lib.matchCreator([a, b, k], author('x', 'anafield', 'Ana Field')).options.map(c => c.id), ['c-a', 'c-b'], 'two by name: the owner decides');
  assert.equal(lib.matchCreator([a, b, k], author('reddit', 'kit', 'kit bakes')).creator.id, 'c-k', 'another name, any case');
  assert.equal(lib.matchCreator([a, b, k], author('x', 'other', 'Someone')).by, 'none');
});
check('"Find creators": new, joining and needs-you, from posts without a creator', () => {
  const k = creator('c-k', 'Bakehouse Kit', [{ platform: 'x', handle: 'bakehouse_kit' }]);
  const posts = [
    post('1', 'https://x.com/bakehouse_kit/status/1', { author: 'Bakehouse Kit' }),
    post('2', 'https://x.com/bakehouse_kit/status/2', { author: 'Bakehouse Kit', creatorId: 'c-k' }),
    post('3', 'https://www.tiktok.com/@ana.field/video/3', { author: 'Ana Field' }),
    post('4', 'https://x.com/anafield/status/4', { author: 'Ana Field' }),
    post('5', 'https://www.tiktok.com/@ana.field/video/5', { author: 'Ana Field' }),
  ];
  const plan = lib.findCreators(posts, [k]);
  assert.deepEqual(plan.joining.map(j => [j.creatorId, j.postIds, j.by]), [['c-k', ['1'], 'handle']]);
  assert.deepEqual(plan.fresh.map(f => [f.author.platform, f.postIds]), [['tiktok', ['3', '5']], ['x', ['4']]]);
  assert.match(plan.fresh[0].alsoNamed, /X @anafield/, 'the same name elsewhere is said, not merged');
  const two = lib.findCreators([post('6', 'https://x.com/anafield/status/6', { author: 'Ana Field' })],
    [creator('c-1', 'Ana Field'), creator('c-2', 'Ana Field')]);
  assert.deepEqual(two.ambiguous.map(a => a.options), [['c-1', 'c-2']]);
});
check('a name belongs to one creator', () => {
  const list = [creator('c-a', 'Ana Field', [], ['A. Field']), creator('c-k', 'Bakehouse Kit')];
  assert.equal(lib.nameOwner(list, 'c-k', 'ana field').id, 'c-a');
  assert.equal(lib.nameOwner(list, 'c-k', 'a. field').id, 'c-a', 'another name counts');
  assert.equal(lib.nameOwner(list, 'c-a', 'Ana Field'), null, 'its own name');
});
check('merging: the kept name stays, the other becomes another name, lists join, posts move; Undo', () => {
  const store = lib.useLibrary;
  const into = { ...creator('c-k', 'Bakehouse Kit', [{ platform: 'x', handle: 'bakehouse_kit' }], ['Kit Bakes']), notes: '' };
  const from = { ...creator('c-i', 'bakehouse.kit', [{ platform: 'instagram', handle: 'bakehouse.kit' }]), notes: 'bakery, Leeds' };
  store.setState({ posts: [post('1', 'https://x.com/bakehouse_kit/status/1', { creatorId: 'c-k' }), post('2', 'https://www.instagram.com/p/C2/', { creatorId: 'c-i' })],
    pending: {}, creators: [into, from], deletedCreators: {} });
  const choices = lib.defaultChoices(into, from);
  assert.equal(choices.notes, 'other', 'the kept one has no note: the other\'s is taken');
  const change = store.getState().mergeCreator('c-i', 'c-k', choices);
  const s = store.getState();
  const kept = s.creators.find(c => c.id === 'c-k');
  assert.deepEqual([kept.aliases, kept.handles.length, kept.notes], [['Kit Bakes', 'bakehouse.kit'], 2, 'bakery, Leeds']);
  assert.equal(s.creators.some(c => c.id === 'c-i'), false);
  assert.ok(s.deletedCreators['c-i']);
  assert.equal(s.posts.find(p => p.id === '2').creatorId, 'c-k');
  for (const until = Date.now() + 3; Date.now() < until;) { /* a later moment */ }
  assert.deepEqual(store.getState().undoCreatorChange(change), { restored: 1, skipped: 0 });
  const back = store.getState();
  assert.deepEqual(back.creators.map(c => c.id).sort(), ['c-i', 'c-k']);
  assert.equal(back.creators.find(c => c.id === 'c-k').aliases.length, 1);
  assert.equal(back.posts.find(p => p.id === '2').creatorId, 'c-i');
  assert.equal(back.deletedCreators['c-i'], undefined);
});
check('moving posts to a new creator takes their handle along when nothing else uses it; Undo', () => {
  const store = lib.useLibrary;
  const k = { ...creator('c-k', 'Bakehouse Kit', [{ platform: 'x', handle: 'bakehouse_kit' }, { platform: 'x', handle: 'kitbakes' }]), urls: ['https://x.com/kitbakes'] };
  store.setState({ posts: [post('1', 'https://x.com/bakehouse_kit/status/1', { creatorId: 'c-k' }), post('2', 'https://x.com/kitbakes/status/2', { creatorId: 'c-k' })],
    pending: {}, creators: [k], deletedCreators: {} });
  const change = store.getState().moveToCreator(['2'], { name: 'Kit Bakes (second account)' });
  const s = store.getState();
  const made = s.creators.find(c => c.name === 'Kit Bakes (second account)');
  assert.deepEqual(made.handles, [{ platform: 'x', handle: 'kitbakes' }]);
  assert.deepEqual(s.creators.find(c => c.id === 'c-k').handles, [{ platform: 'x', handle: 'bakehouse_kit' }], 'the handle went with the post');
  assert.equal(s.posts.find(p => p.id === '2').creatorId, made.id);
  for (const until = Date.now() + 3; Date.now() < until;) { /* a later moment */ }
  store.getState().undoCreatorChange(change);
  const back = store.getState();
  assert.equal(back.creators.some(c => c.id === made.id), false, 'the new creator goes again');
  assert.equal(back.creators.find(c => c.id === 'c-k').handles.length, 2);
  assert.equal(back.posts.find(p => p.id === '2').creatorId, 'c-k');
});
check('creator: in the search finds posts by any of the creator\'s names', () => {
  const names = p => (p.creatorId === 'c-k' ? ['Bakehouse Kit', 'Kit Bakes'] : []);
  const posts = [post('1', 'https://x.com/a/status/1', { creatorId: 'c-k' }), post('2', 'https://x.com/b/status/2')];
  const found = q => posts.filter(p => lib.matchesQuery(p, lib.parseQuery(q), undefined, names)).map(p => p.id).join(' ');
  assert.equal(found('creator:bakes'), '1');
  assert.equal(found('-creator:kit'), '2');
});

check("refresh: only what differs; keep what the creator has, take where it has nothing; kept values aren't offered again", () => {
  const k = { ...creator('c-k', 'Bakehouse Kit', [], ['Kit Bakes']), about: '', picture: '/thumb/old1' };
  const page = { name: 'Bakehouse Kit 🍞', about: 'Sourdough classes in Leeds', picture: '/thumb/new1' };
  const rows = lib.refreshRows(k, page, [k]);
  assert.deepEqual(rows.map(r => [r.field, r.choice]), [['name', 'keep'], ['about', 'take'], ['picture', 'keep']]);
  assert.deepEqual(rows[0].options, ['keep', 'alias', 'take']);
  const patch = lib.applyRefresh(k, rows.map(r => (r.field === 'name' ? { ...r, choice: 'alias' } : r)));
  assert.deepEqual([patch.aliases, patch.about, patch.picture], [['Kit Bakes', 'Bakehouse Kit 🍞'], 'Sourdough classes in Leeds', undefined]);
  assert.deepEqual(patch.kept, { picture: '/thumb/new1' }, 'the picture kept against the page is remembered');
  const after = { ...k, ...patch };
  assert.deepEqual(lib.refreshRows(after, page, [after]), [], 'a second refresh with nothing new lists nothing');
  const taken = lib.applyRefresh(k, [{ ...rows[0], choice: 'take' }]);
  assert.deepEqual([taken.name, taken.aliases], ['Bakehouse Kit 🍞', ['Bakehouse Kit', 'Kit Bakes']], 'the old main name stays as another name');
  const other = creator('c-o', 'Bakehouse Kit 🍞');
  assert.deepEqual(lib.refreshRows(k, page, [k, other])[0], { field: 'name', now: 'Bakehouse Kit', page: 'Bakehouse Kit 🍞', choice: 'keep', options: ['keep'], clash: 'Bakehouse Kit 🍞' },
    "another creator's name is only kept (merge them instead)");
});

check('names as SQLite keeps them: hidden and control characters out, lists within their limits', () => {
  assert.equal(lib.cleanName('Bake‍house\u0000 Kit\n'), 'Bakehouse Kit');
  assert.equal(lib.authorOf(post('p', 'https://x.com/bakehouse_kit/status/1', { author: 'Bake‍house‮ Kit' })).name, 'Bakehouse Kit');
  const long = lib.cleanName('🍞'.repeat(250));
  assert.equal(Array.from(long).length, 200);
  assert.equal(/\p{Cs}/u.test(long), false, 'no half of an emoji left at the cut');
  const store = lib.useLibrary;
  store.setState({ posts: [], pending: {}, creators: [], deletedCreators: {} });
  const many = { ...creator('c-many', 'Many​ Names'), aliases: Array.from({ length: 60 }, (_, i) => `name ${i}⁦`),
    handles: Array.from({ length: 25 }, (_, i) => ({ platform: 'x', handle: `h${i}` })) };
  store.getState().saveCreators([many], {});
  const saved = store.getState().creators[0];
  assert.equal(saved.name, 'Many Names');
  assert.deepEqual([saved.aliases.length, saved.handles.length], [50, 20]);
  assert.equal(saved.aliases.some(a => /\p{C}/u.test(a)), false);
  const other = { ...creator('c-other', 'Other'), handles: Array.from({ length: 20 }, (_, i) => ({ platform: 'tiktok', handle: `t${i}` })) };
  store.setState({ creators: [saved, other] });
  store.getState().mergeCreator('c-other', 'c-many', lib.defaultChoices(saved, other));
  assert.equal(store.getState().creators.find(c => c.id === 'c-many').handles.length, 20, 'a merge stays within the limit');
});
check('"last looked" is kept in this browser: looking never changes the creator', () => {
  const store = lib.useLibrary;
  const k = creator('c-k', 'Bakehouse Kit');
  store.setState({ posts: [], pending: {}, creators: [k], deletedCreators: {}, creatorSeen: {} });
  store.getState().seeCreator('c-k');
  assert.equal(store.getState().creators[0].updatedAt, k.updatedAt, 'the synced creator is untouched');
  assert.ok(store.getState().creatorSeen['c-k']);
});
check('Undo leaves alone a creator merged away since, and a change made again since', () => {
  const store = lib.useLibrary;
  const k = creator('c-k', 'Bakehouse Kit', [{ platform: 'x', handle: 'bakehouse_kit' }]);
  const x = creator('c-x', 'Kit Bakes', [{ platform: 'x', handle: 'kitbakes' }]);
  store.setState({ posts: [post('1', 'https://x.com/bakehouse_kit/status/1', { creatorId: 'c-k' }), post('2', 'https://x.com/someone/status/2', { creatorId: 'c-k' })],
    pending: {}, creators: [k, x], deletedCreators: {} });
  const move = store.getState().moveToCreator(['2'], { id: 'c-x' });
  for (const until = Date.now() + 3; Date.now() < until;) { /* a later moment */ }
  const xNow = store.getState().creators.find(c => c.id === 'c-x');
  store.getState().mergeCreator('c-x', 'c-k', lib.defaultChoices(store.getState().creators.find(c => c.id === 'c-k'), xNow));
  for (const until = Date.now() + 3; Date.now() < until;) { /* a later moment */ }
  store.getState().undoCreatorChange(move);
  assert.equal(store.getState().creators.some(c => c.id === 'c-x'), false, 'merged away since: not brought back as a second "Kit Bakes"');
  const at = store.getState().updateCreator('c-k', { name: 'Bakehouse Kit Bakery' });
  for (const until = Date.now() + 3; Date.now() < until;) { /* a later moment */ }
  store.getState().updateCreator('c-k', { notes: 'changed again' });
  assert.equal(store.getState().revertCreator('c-k', at, { name: 'Bakehouse Kit' }), false);
  assert.equal(store.getState().creators.find(c => c.id === 'c-k').name, 'Bakehouse Kit Bakery');
});
check('Undo of a tag merge leaves alone a tag record merged away since', () => {
  const store = lib.useLibrary;
  store.setState({ posts: [post('1', 'https://example.org/1', { tags: ['a'] })], pending: {},
    tagInfo: [{ id: 'b', name: 'b', parents: [], aliases: ['bee'], updatedAt: '2026-10-01T10:00:00Z' }], deletedTags: {} });
  const first = store.getState().mergeTag('a', 'b');
  for (const until = Date.now() + 3; Date.now() < until;) { /* a later moment */ }
  store.getState().mergeTag('b', 'c');
  for (const until = Date.now() + 3; Date.now() < until;) { /* a later moment */ }
  store.getState().undoTagMerge(first);
  assert.equal(store.getState().tagInfo.some(t => t.name === 'b'), false, '"bee" stays only with c');
});

if (failures) { console.error(`FAILED ${failures}`); process.exit(1); }
console.log('ALL PASS');
process.exit(0);   // the store's timers would keep Node running
