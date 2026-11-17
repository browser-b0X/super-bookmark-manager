// The library's search language (v0.4.0 phase 6, mockup Claude outputs/v040-review/phase6a/mockup-1): "or", a
// leading "-" (a whole word for words, any operator, a group), "phrases", ( groups ), no:/has: for empty fields,
// saved:/opened: dates; how a search is read back as chips; the text smart shelves write.
// Pure function test: bundles src/lib/librarySearch.ts with esbuild and runs it in Node.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const load = async file => {
  const entry = fileURLToPath(new URL(`../src/lib/${file}`, import.meta.url));
  const { outputFiles } = await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', write: false, platform: 'neutral' });
  return import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
};
const s = await load('librarySearch.ts');
const post = (id, changes = {}) => ({ id, url: `https://example.org/${id}`, source: 'manual', platform: 'web', domain: 'example.org',
  status: 'inbox', title: id, categories: [], tags: [], projectIds: [], createdAt: '2026-10-10T10:00:00Z',
  updatedAt: '2026-10-10T10:00:00Z', metadataStatus: 'none', ...changes });
const posts = [
  post('fractal', { title: 'A fractal zoom', tags: ['pattern'] }),
  post('tone', { title: 'Test tone and colour bars', tags: ['broadcast', 'pattern'], userNotes: 'keep' }),
  post('video', { title: 'Why sourdough is flat: a video', tags: ['bread', 'video'] }),
  post('videos', { title: 'Ten videos of bread rising', tags: ['bread'], domain: 'x.com' }),
  post('rye', { title: 'Rye crackers', tags: ['rye'], createdAt: '2026-10-01T10:00:00Z', lastOpenedAt: '2026-10-12T09:00:00Z' }),
  post('green', { title: 'The green pattern test card', status: 'archived', reviewed: true }),
];
const ids = q => posts.filter(p => s.matchesQuery(p, s.parseQuery(q))).map(p => p.id).join(' ');
let failures = 0;
const check = (name, run) => { try { run(); console.log(`PASS ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}: ${e.message.split('\n').slice(0, 4).join(' | ')}`); } };

check('"or" between words, tags and operators', () => {
  assert.equal(ids('fractal or tone'), 'fractal tone');
  assert.equal(ids('#rye or #broadcast'), 'tone rye');
  assert.equal(ids('fractal OR site:x.com'), 'fractal videos', 'any case');
  assert.equal(ids('bread fractal or rye'), 'rye', '"or" binds looser than the space: (bread fractal) or rye');
});
check('"-word" leaves out the whole word only', () => {
  assert.equal(ids('bread -video'), 'videos', 'a "video" is left out; "videos" stays');
  assert.equal(ids('-"test card"'), 'fractal tone video videos rye', 'a phrase is left out as written');
  assert.equal(ids('-#pattern -is:archived'), 'video videos rye', 'operators as before');
});
check('"phrases" and ( groups ), also left out', () => {
  assert.equal(ids('"green pattern"'), 'green');
  assert.equal(ids('(#bread or #rye) -video'), 'videos rye');
  assert.equal(ids('-(#bread or #pattern)'), 'rye green', 'green has no tags at all');
  assert.equal(ids('(#bread or #rye'), 'video videos rye', 'a missing ")" closes at the end');
  assert.equal(ids('#rye ) or'), 'rye', 'a stray ")" or "or" is skipped');
});
check('empty or not: no: and has:', () => {
  assert.equal(ids('has:notes'), 'tone');
  assert.equal(ids('no:tags'), 'green');
  assert.equal(ids('no:shelf #rye'), 'rye');
  assert.equal(ids('no:whatever'), '', 'an unknown field matches nothing');
});
check('dates: saved: and opened:', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  assert.equal(s.dateMatches('2026-10-10T10:00:00Z', '7d', now), true);
  assert.equal(s.dateMatches('2026-10-01T10:00:00Z', '7d', now), false);
  assert.equal(s.dateMatches('2026-10-01T10:00:00Z', '3w', now), true);
  assert.equal(ids('saved:>2026-10-05'), 'fractal tone video videos green');
  assert.equal(ids('saved:<2026-10-05'), 'rye');
  assert.equal(ids('saved:2026-10-01..2026-10-10'), 'fractal tone video videos rye green');
  assert.equal(ids('opened:2026-10-12'), 'rye');
  assert.equal(ids('opened:>2026-10-01 or is:reviewed'), 'rye green', 'never opened: no opened date matches');
});
check('words that only look like operators are text', () => {
  assert.equal(ids('crackers:'), '', 'not an operator');
  assert.equal(ids('https://example.org/rye'), 'rye');
});
check('how a search is read back', () => {
  assert.deepEqual(s.describeQuery(s.parseQuery('(#bread or #rye) -video "slow bread"')),
    ['any of: #bread, #rye', 'not the word “video”', 'the phrase “slow bread”']);
  assert.deepEqual(s.describeQuery(s.parseQuery('-(site:x.com or #video) saved:7d')), ['none of: site x.com, #video', 'saved 7d']);
  assert.deepEqual(s.describeQuery(s.parseQuery('  ')), []);
  assert.equal(s.isEmptyQuery(s.parseQuery(' ( ) or ')), true);
});
check('search text written from a parsed search reads back the same', () => {
  for (const q of ['(#bread or #rye) -video "slow bread"', '-(site:x.com or #video) saved:>2026-10-01', 'in:"Bookmarks bar" no:notes',
    'a or (b c) or -d', '#"two words" -is:archived', '(a or b) (c or d)']) {
    const tree = s.parseQuery(q).tree;
    assert.deepEqual(s.parseQuery(s.queryText(tree)).tree, tree, q);
  }
});

check("a very deep search can't overflow the stack", () => {
  const deep = '('.repeat(20000) + '#rye' + ')'.repeat(20000);
  assert.equal(ids(deep), 'rye');
  assert.equal(ids('-'.concat('('.repeat(5000), 'fractal or tone', ')'.repeat(5000))), 'video videos rye green');
  assert.ok(s.queryText(s.parseQuery(deep).tree).length < 200, 'and its text stays short');
  assert.deepEqual(s.describeQuery(s.parseQuery(deep)), ['#rye']);
});

// Smart shelves (mockup-2): groups of rules written as a search, and read back.
const shelves = await load('smartShelves.ts');
check('smart shelf groups become a search and come back', () => {
  const groups = [
    { mode: 'any', conditions: [shelves.condition('tag', '#Bread'), shelves.condition('tag', 'rye')] },
    { mode: 'none', conditions: [shelves.condition('text', 'video'), shelves.condition('site', 'x.com')] },
    { mode: 'all', conditions: [shelves.condition('saved', '>2026-10-01'), shelves.condition('is', 'new')] },
  ];
  const search = shelves.searchOf(groups);
  assert.equal(search, '(#bread or #rye) -(video or site:x.com) saved:>2026-10-01 is:new');
  assert.deepEqual(shelves.groupsOf(search), groups);
  assert.equal(ids(search), '', 'nothing here is new, bread or rye, saved after 1 Oct and not a video');
  assert.equal(ids(shelves.searchOf(groups.slice(0, 2))), 'rye', 'without the last group ("videos" is on x.com)');
});
check('a search the groups can\'t show is kept whole (edited as text)', () => {
  assert.equal(shelves.groupsOf('a or (b c)'), null, 'an "and" inside an "or"');
  assert.equal(shelves.groupsOf('-(a b)'), null);
  assert.deepEqual(shelves.groupsOf(''), []);
  assert.deepEqual(shelves.groupsOf('-a -b c'), [{ mode: 'none', conditions: [{ kind: 'text', value: 'a', phrase: false }, { kind: 'text', value: 'b', phrase: false }] },
    { mode: 'all', conditions: [{ kind: 'text', value: 'c', phrase: false }] }], '-a -b is one "none" group');
  assert.equal(shelves.searchOf([{ mode: 'all', conditions: [] }, { mode: 'any', conditions: [shelves.condition('text', 'slow bread')] }]), '"slow bread"',
    'empty groups are left out; one condition needs no brackets');
});
check('conditions from the editor', () => {
  assert.deepEqual(shelves.condition('shelf', 'Food Drink'), { kind: 'op', field: 'shelf', value: 'food-drink' });
  assert.equal(shelves.condition('saved', 'last week'), null, 'not a date the search knows');
  assert.equal(shelves.condition('tag', '  '), null);
});

if (failures) { console.error(`FAILED ${failures}`); process.exit(1); }
console.log('ALL PASS');
