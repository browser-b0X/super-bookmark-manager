// "Follow up by <day>" and "use often": day maths, labels, presets, search and order.
// Pure function test: bundles src/lib/followUp.ts and src/lib/librarySearch.ts with esbuild and runs them in Node.
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
const f = await load('followUp.ts');
const search = await load('librarySearch.ts');
const post = (n, changes = {}) => ({ id: `p${n}`, url: `https://example.org/${n}`, source: 'manual', platform: 'web', domain: 'example.org',
  status: 'to-review', title: `Link ${n}`, categories: [], tags: [], projectIds: [], createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-01T10:00:00Z', metadataStatus: 'none', ...changes });
const today = new Date(2026, 9, 8, 23, 30);   // Thu 8 Oct 2026, late evening local time
let failures = 0;
const check = (name, run) => { try { run(); console.log(`PASS ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}: ${e.message.split('\n')[0]}`); } };

check('days are local calendar days', () => {
  assert.equal(f.dayOf(today), '2026-10-08');
  assert.equal(f.daysUntil('2026-10-09', today), 1);
  assert.equal(f.daysUntil('2026-10-02', today), -6);
  assert.equal(f.daysUntil('2026-10-25', new Date(2026, 9, 24, 1)), 1, 'across a daylight-saving change');
  for (const bad of ['', '2026-02-30', '2026-13-01', '2026-1-01', 'tomorrow', undefined]) assert.equal(f.parseDay(bad), null, String(bad));
});
check('states and badge labels', () => {
  assert.equal(f.followUpState(post(1), today), null);
  assert.equal(f.followUpLabel(post(1, { followUpAt: '2026-10-02' }), today), 'Overdue 6 days');
  assert.equal(f.followUpLabel(post(1, { followUpAt: '2026-10-07' }), today), 'Overdue 1 day');
  assert.equal(f.followUpLabel(post(1, { followUpAt: '2026-10-08' }), today), 'Due today');
  assert.equal(f.followUpLabel(post(1, { followUpAt: '2026-10-09' }), today), 'Tomorrow');
  assert.equal(f.followUpLabel(post(1, { followUpAt: '2026-10-15' }), today), 'Thu 15 Oct');
  assert.equal(f.followUpState(post(1, { followUpAt: '2026-10-15' }), today), 'soon');
  assert.equal(f.followUpState(post(1, { followUpAt: '2026-11-15' }), today), 'later');
  assert.equal(f.followUpLabel(post(1, { followUpAt: '2026-10-02', status: 'archived' }), today), null, 'archived links are not chased');
});
check('presets: tomorrow, a week, a month (clamped to the month end)', () => {
  assert.deepEqual(f.followUpPresets(today).map(p => p.day), ['2026-10-09', '2026-10-15', '2026-11-08']);
  assert.equal(f.followUpPresets(new Date(2026, 0, 31)).at(-1).day, '2026-02-28');
  assert.equal(f.followUpPresets(new Date(2026, 11, 31)).map(p => p.day).join(), '2027-01-01,2027-01-07,2027-01-31');
});
check('done clears the day and keeps the link', () => {
  assert.deepEqual(JSON.parse(JSON.stringify({ ...post(1, { followUpAt: '2026-10-02' }), ...f.FOLLOW_UP_DONE })).followUpAt, undefined);
  assert.equal(f.FOLLOW_UP_DONE.status, 'reference');
});
check('follow-up order and the use-often row', () => {
  const list = [post(1, { followUpAt: '2026-10-15' }), post(2), post(3, { followUpAt: '2026-10-02' })].sort(f.byFollowUp);
  assert.deepEqual(list.map(p => p.id), ['p3', 'p1', 'p2']);
  const row = f.useOftenRow([post(1, { useOften: true, openCount: 2 }), post(2, { useOften: true, openCount: 14 }), post(3, { openCount: 99 }),
    post(4, { useOften: true, status: 'archived' }), post(5, { useOften: true, openCount: 2, lastOpenedAt: '2026-10-07T00:00:00Z' })]);
  assert.deepEqual(row.map(p => p.id), ['p2', 'p5', 'p1']);
});
check('search: is:followup, is:due, is:often', () => {
  const now = new Date(); const day = d => { const x = new Date(now); x.setDate(x.getDate() + d); return f.dayOf(x); };
  const posts = [post(1, { followUpAt: day(-2) }), post(2, { followUpAt: day(0) }), post(3, { followUpAt: day(5) }), post(4, { useOften: true }), post(5)];
  const ids = q => posts.filter(p => search.matchesQuery(p, search.parseQuery(q))).map(p => p.id).join();
  assert.equal(ids('is:followup'), 'p1,p2,p3');
  assert.equal(ids('is:due'), 'p1,p2');
  assert.equal(ids('is:often'), 'p4');
});
console.log(failures ? `FAILED ${failures}` : 'ALL PASS');
process.exitCode = failures ? 1 : 0;
