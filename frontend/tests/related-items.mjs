import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const frontendRoot = fileURLToPath(new URL('../', import.meta.url));

// Bundle the pure module and import it in plain node (no DOM, no browser).
const bundle = await build({
  stdin: { contents: 'export { relatedItems } from "./src/lib/relatedItems";', resolveDir: frontendRoot },
  bundle: true, write: false, format: 'esm',
});
const dir = await mkdtemp(join(tmpdir(), 'related-items-'));
const modPath = join(dir, 'related-items.mjs');
await writeFile(modPath, bundle.outputFiles[0].text);
const { relatedItems } = await import(pathToFileURL(modPath).href);

const base = {
  url: 'https://example.invalid/x', source: 'manual', platform: 'web', domain: 'example.invalid',
  categories: [], tags: [], projectIds: [], status: 'inbox',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', metadataStatus: 'enriched',
};
const make = (id, over = {}) => ({ ...base, id, url: `https://example.invalid/${id}`, ...over });
const ids = list => list.map(p => p.id);

const results = [];
const check = (name, fn) => { try { fn(); results.push({ name, status: 'PASS' }); } catch (e) { results.push({ name, status: 'FAIL', error: e.message }); } };

// 1. domain match includes; zero-overlap excluded
check('domain match included, zero-score excluded', () => {
  const a = make('a', { domain: 'site.com' });
  const b = make('b', { domain: 'site.com' });
  const c = make('c', { domain: 'other.com' });
  assert.deepEqual(ids(relatedItems(a, [b, c])), ['b']);
});

// 2. tag overlap ranks above weaker match
check('shared tags rank by count', () => {
  const a = make('a', { domain: 'd0', tags: ['x', 'y'] });
  const b = make('b', { domain: 'd1', tags: ['x', 'y'] }); // +4
  const c = make('c', { domain: 'd2', tags: ['x'] });       // +2
  assert.deepEqual(ids(relatedItems(a, [c, b])), ['b', 'c']);
});

// 3. category overlap contributes
check('shared category contributes', () => {
  const a = make('a', { domain: 'd0', categories: ['dev'] });
  const b = make('b', { domain: 'd1', categories: ['dev'] }); // +2
  const c = make('c', { domain: 'd2', categories: ['art'] }); // 0
  assert.deepEqual(ids(relatedItems(a, [c, b])), ['b']);
});

// 4. domain outranks a single tag; source/status add to score
check('domain(+3) outranks one tag(+2); source/status add', () => {
  const a = make('a', { domain: 'site.com', source: 'telegram', status: 'reference' });
  const sameDomain = make('sd', { domain: 'site.com', source: 'manual', status: 'inbox' });      // +3
  const oneTag = make('ot', { domain: 'other.com', tags: ['t'], source: 'manual', status: 'inbox' }); // +0 (no shared tag with a)
  const domPlusSrc = make('dps', { domain: 'site.com', source: 'telegram', status: 'inbox' });   // +3 +1 = +4
  assert.deepEqual(ids(relatedItems(a, [oneTag, sameDomain, domPlusSrc])), ['dps', 'sd']);
});

// 5. deterministic id tiebreaker independent of input order
check('equal scores ordered by id asc regardless of input order', () => {
  const a = make('a', { domain: 'site.com' });
  const b = make('b', { domain: 'site.com' }); // +3
  const c = make('c', { domain: 'site.com' }); // +3
  const forward = ids(relatedItems(a, [b, c]));
  const shuffled = ids(relatedItems(a, [c, b]));
  assert.deepEqual(forward, ['b', 'c']);
  assert.deepEqual(shuffled, forward);
});

// 6. self is excluded even when it would score highest
check('self excluded', () => {
  const a = make('a', { domain: 'site.com', tags: ['x'] });
  const b = make('b', { domain: 'site.com', tags: ['x'] });
  assert.deepEqual(ids(relatedItems(a, [a, b])), ['b']);
});

// 7. cap at 6, keeping the top-6 by score then id
check('caps at 6 by score then id', () => {
  const a = make('a', { domain: 'site.com' });
  const matches = ['r7', 'r3', 'r5', 'r1', 'r6', 'r2', 'r4', 'r0'].map(id => make(id, { domain: 'site.com' })); // all +3
  const out = ids(relatedItems(a, matches));
  assert.equal(out.length, 6);
  assert.deepEqual(out, ['r0', 'r1', 'r2', 'r3', 'r4', 'r5']);
});

// 8. higher scores survive the cap over lower ones
check('cap keeps highest scores first', () => {
  const a = make('a', { domain: 'site.com', tags: ['x', 'y'] });
  const strong = make('strong', { domain: 'site.com', tags: ['x', 'y'] }); // +3+4 = +7
  const weak = ['w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6'].map(id => make(id, { domain: 'site.com' })); // +3 each
  const out = ids(relatedItems(a, [...weak, strong]));
  assert.equal(out.length, 6);
  assert.equal(out[0], 'strong');
  assert.deepEqual(out.slice(1), ['w0', 'w1', 'w2', 'w3', 'w4']);
});

// 9. empty when nothing matches
check('empty when no signals overlap', () => {
  const a = make('a', { domain: 'site.com', tags: ['x'], categories: ['dev'] });
  const b = make('b', { domain: 'other.com', tags: ['y'], categories: ['art'] });
  assert.deepEqual(relatedItems(a, [b]), []);
});

// 10. empty posts list
check('empty posts list returns empty', () => {
  assert.deepEqual(relatedItems(make('a'), []), []);
});

// 11. blank domain does not create a false match
check('empty/blank domain is not a match signal', () => {
  const a = make('a', { domain: '' });
  const b = make('b', { domain: '' });
  assert.deepEqual(relatedItems(a, [b]), []);
});

for (const r of results) console.log(`${r.status} ${r.name}${r.error ? ' — ' + r.error : ''}`);
const failed = results.filter(r => r.status === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed`);

const evidenceDir = fileURLToPath(new URL('../../.verify/b4-related-items-20260925', import.meta.url));
await writeFile(join(evidenceDir, 'related-items-results.json'), JSON.stringify({ results, passed: results.length - failed.length, total: results.length }, null, 2)).catch(() => {});

if (failed.length) process.exitCode = 1;
