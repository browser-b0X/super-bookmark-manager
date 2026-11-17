// Two open tabs share one library cache; when one writes it, the other re-reads it and merges
// (store/library.ts `merge`). Saved views, shelves, import history, activity and queued shelf
// changes merge item by item, like links (owner, 2026-10-23: "Merge them, like links").
// Synthetic data; the store's own merge function is called with each tab's copy.
// Run from frontend/: node tests/two-tabs-test.mjs
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

const out = await build({
  stdin: {
    contents: `export { useLibrary } from './src/store/library';\nexport { syncLibrary } from './src/lib/libraryPersistence';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' },
});
const { useLibrary, syncLibrary } = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const merge = useLibrary.persist.getOptions().merge;
const base = useLibrary.getState();
// Each tab's state: the store's own fields, as a tab would hold and write them.
const tab = (extra = {}) => ({ ...base, posts: [], pending: {}, deletedUrls: [], rejected: {}, purgeUrls: [], undeleteUrls: [], adoptedUrls: [],
  categoryOps: [], imports: [], activity: [], views: [], syncRev: 3, ...extra });
// Minutes of the last hour, not a fixed day: a deletion older than 30 days is forgotten, so a fixed date would expire.
const lastHour = new Date(Date.now() - 3600000).toISOString().slice(0, 14);
const t = n => `${lastHour}0${n}:00.000Z`;
const failures = [];
const check = async (name, run) => {
  try { await run(); console.log('PASS', name); } catch (error) { failures.push(name); console.error('FAIL', name, '\n ', error.message.split('\n').slice(0, 8).join('\n  ')); }
};
const ids = list => list.map(item => item.id).sort();

await check('a view saved in each tab: both are kept', () => {
  const a = tab({ views: [{ id: 'v-a', name: 'Recipes to try', filter: { kind: 'category', categoryId: 'food' }, updatedAt: t(1) }] });
  const b = tab({ views: [{ id: 'v-b', name: 'Unread videos', filter: { kind: 'inbox' }, updatedAt: t(2) }] });
  assert.deepEqual(ids(merge(a, b).views), ['v-a', 'v-b'], 'B re-reads A\'s write');
  assert.deepEqual(ids(merge(b, a).views), ['v-a', 'v-b'], 'A re-reads B\'s write');
});

await check('the same view changed in both tabs: the later change wins, whichever tab wrote last', () => {
  const older = { id: 'v', name: 'Old name', filter: { kind: 'inbox' }, updatedAt: t(1) };
  const newer = { id: 'v', name: 'New name', filter: { kind: 'inbox' }, updatedAt: t(5) };
  assert.equal(merge(tab({ views: [older] }), tab({ views: [newer] })).views[0].name, 'New name');
  assert.equal(merge(tab({ views: [newer] }), tab({ views: [older] })).views[0].name, 'New name');
});

await check('a view deleted in one tab goes in the other too, unless it was changed after', () => {
  const view = { id: 'v', name: 'A view', filter: { kind: 'inbox' }, updatedAt: t(1) };
  const deleted = tab({ views: [], deletedViews: { v: t(3) } });
  assert.deepEqual(merge(deleted, tab({ views: [view] })).views, []);
  assert.deepEqual(merge(tab({ views: [view] }), deleted).views, []);
  const changedLater = { ...view, name: 'Kept: changed after the delete', updatedAt: t(4) };
  assert.equal(merge(deleted, tab({ views: [changedLater] })).views[0]?.name, 'Kept: changed after the delete');
});

await check('shelves: a colour changed in one tab and a rename in the other both stay', () => {
  const shelf = (id, extra) => ({ id, name: id, color: '#111111', order: id === 'food' ? 0 : 1, ...extra });
  const a = tab({ categories: [shelf('food', { color: '#ff0000', updatedAt: t(2) }), shelf('travel')] });
  const b = tab({ categories: [shelf('food'), shelf('travel', { name: 'trips', updatedAt: t(3) })] });
  const merged = merge(a, b).categories;
  assert.deepEqual(merged.map(c => [c.id, c.name, c.color]), [['food', 'food', '#ff0000'], ['travel', 'trips', '#111111']]);
});

await check('a shelf deleted in one tab stays deleted when the other tab writes', () => {
  const travel = { id: 'travel', name: 'travel', color: '#111111', order: 1 };
  const a = tab({ categories: [], deletedCategories: { travel: t(2) } });
  const b = tab({ categories: [travel] });
  assert.deepEqual(merge(b, a).categories, [], 'A re-reads B\'s older copy');
  assert.deepEqual(merge(a, b).categories, [], 'B re-reads A');
});

await check('an import undone in one tab stays undone; each tab\'s imports are kept', () => {
  const run = { id: 'imp-1', at: t(1), source: 'html', fileName: 'bookmarks.html', added: 3, updated: 0, skipped: 0, filed: 0 };
  const a = tab({ imports: [{ ...run, undone: { at: t(4), removed: 3, kept: 0 } }] });
  const b = tab({ imports: [run, { ...run, id: 'imp-2', at: t(2) }] });
  const merged = merge(a, b).imports;
  assert.deepEqual(merged.map(r => [r.id, !!r.undone]), [['imp-2', false], ['imp-1', true]]);
});

await check('queued shelf changes from both tabs go to SQLite once; acknowledged ones are not sent again', () => {
  const opA = { op: 'add', name: 'garden', id: 'op-a' }, opB = { op: 'rename', from: 'travel', to: 'trips', id: 'op-b' };
  const merged = merge(tab({ categoryOps: [opA] }), tab({ categoryOps: [opB] }));
  assert.deepEqual(merged.categoryOps.map(op => op.id).sort(), ['op-a', 'op-b']);
  // A sent op-a and SQLite acknowledged it; B still holds its older copy of A's queue.
  const after = merge(tab({ categoryOps: [], doneOps: ['op-a'] }), tab({ categoryOps: [opA, opB] }));
  assert.deepEqual(after.categoryOps.map(op => op.id), ['op-b']);
});

await check('activity from both tabs, each event once, newest first', () => {
  const e = (n, text) => ({ kind: 'organize', text, time: t(n) });
  const merged = merge(tab({ activity: [e(3, 'Saved view'), e(1, 'Imported')] }), tab({ activity: [e(2, 'Renamed shelf'), e(1, 'Imported')] }));
  assert.deepEqual(merged.activity.map(x => x.text), ['Saved view', 'Renamed shelf', 'Imported']);
});

await check('the store stamps changes and remembers deletions', () => {
  useLibrary.setState(tab({ categories: [{ id: 'food', name: 'food', color: '#111111', order: 0 }] }));
  const lib = useLibrary.getState();
  const id = lib.saveView('Mine', { kind: 'inbox' });
  assert.ok(useLibrary.getState().views.find(v => v.id === id).updatedAt);
  useLibrary.getState().deleteView(id);
  assert.ok(useLibrary.getState().deletedViews[id]);
  useLibrary.getState().recolorCategory('food', '#00ff00');
  assert.ok(useLibrary.getState().categories[0].updatedAt);
  useLibrary.getState().renameCategory('food', 'cooking');
  assert.ok(useLibrary.getState().categoryOps.at(-1).id, 'queued with an id');
});

await check('SQLite gets the bare shelf changes; the acknowledged ones leave the queue by id', async () => {
  useLibrary.setState({ categoryOps: [{ op: 'add', name: 'garden', id: 'op-1' }], pending: {} });
  const sent = [];
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST' && sent.push(JSON.parse(init.body)) === 1) {
      // Another tab's op arrives (by a merge that puts it first) while this request is in flight.
      useLibrary.setState({ categoryOps: [{ op: 'rename', from: 'cooking', to: 'food', id: 'op-2' }, { op: 'add', name: 'garden', id: 'op-1' }] });
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, posts: [], deletedUrls: [], legacyRows: [], categories: ['garden'], rev: 4, since: 3 }) };
  };
  assert.equal(await syncLibrary(), true);
  assert.deepEqual(sent[0].categoryOps, [{ op: 'add', name: 'garden' }], 'no id goes to SQLite');
  assert.deepEqual(sent[1]?.categoryOps, [{ op: 'rename', from: 'cooking', to: 'food' }], "the other tab's op follows; op-1 is not sent twice");
  const state = useLibrary.getState();
  assert.deepEqual(state.categoryOps, [], 'both acknowledged');
  assert.ok(state.doneOps.includes('op-1') && state.doneOps.includes('op-2'));
});

await check('saved views go to SQLite when they change, once', async () => {
  const mine = { id: 'v-mine', name: 'Mine', filter: { kind: 'inbox' }, updatedAt: t(6) };
  useLibrary.setState({ views: [mine], deletedViews: { 'v-old': t(5) }, categoryOps: [], pending: {}, viewsSent: undefined });
  const sent = [];
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') sent.push(JSON.parse(init.body));
    // SQLite has no views until this browser sends them (only the save's answer carries them).
    const saved = init?.method === 'POST' ? { views: [mine], deletedViews: { 'v-old': t(5) } } : { views: [], deletedViews: {} };
    return { ok: true, status: 200, json: async () => ({ ok: true, posts: [], deletedUrls: [], legacyRows: [], categories: [], rev: 5, since: 4, ...saved }) };
  };
  assert.equal(await syncLibrary(), true);
  assert.deepEqual([sent[0].views, sent[0].deletedViews], [[mine], { 'v-old': t(5) }]);
  sent.length = 0;
  assert.equal(await syncLibrary(), true);
  assert.ok(sent.every(body => !('views' in body)), 'unchanged views are not sent again');
});

await check('views from SQLite (another browser\'s) are merged in; a newer local change stays', async () => {
  const local = { id: 'v-mine', name: 'Mine, renamed here', filter: { kind: 'inbox' }, updatedAt: t(9) };
  useLibrary.setState({ views: [local], pending: {}, syncRev: 0 });
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, posts: [], deletedUrls: [], legacyRows: [], categories: [], rev: 6,
    views: [{ id: 'v-mine', name: 'Mine', filter: { kind: 'inbox' }, updatedAt: t(6) }, { id: 'v-other', name: 'From the laptop', filter: { kind: 'favorites' }, updatedAt: t(7) }],
    deletedViews: {} }) });
  assert.equal(await syncLibrary(), true);
  assert.deepEqual(useLibrary.getState().views.map(v => v.name).sort(), ['From the laptop', 'Mine, renamed here']);
});

await check('reading the same views back from SQLite changes nothing (no save is set off by it)', async () => {
  const views = useLibrary.getState().views;
  let posts = 0;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') posts++;
    return { ok: true, status: 200, json: async () => ({ ok: true, posts: [], deletedUrls: [], legacyRows: [], categories: [], rev: 7,
      views: JSON.parse(JSON.stringify(views)), deletedViews: useLibrary.getState().deletedViews ?? {} }) };
  };
  assert.equal(await syncLibrary(), true);
  assert.equal(useLibrary.getState().views, views, 'the same list, not a fresh copy that looks like an edit');
  assert.equal(await syncLibrary(), true);
  assert.equal(posts, 0, 'already sent: reading them back sends nothing');
});

await check('after a restore elsewhere, the restored library\'s views replace this tab\'s', async () => {
  useLibrary.setState({ views: [{ id: 'v-stale', name: 'From the replaced library', filter: { kind: 'inbox' }, updatedAt: t(9) }], pending: {}, syncEpoch: 0 });
  const restored = [{ id: 'v-backup', name: 'From the backup', filter: { kind: 'inbox' }, updatedAt: t(1) }];
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, posts: [], deletedUrls: [], legacyRows: [], categories: [], rev: 9, epoch: 8,
    views: restored, deletedViews: {} }) });
  assert.equal(await syncLibrary(), true);
  assert.deepEqual(useLibrary.getState().views.map(v => v.id), ['v-backup']);
});

if (failures.length) { console.error(`FAILED ${failures.length}: ${failures.join('; ')}`); process.exit(1); }
console.log('ALL PASS');
process.exit(0);
