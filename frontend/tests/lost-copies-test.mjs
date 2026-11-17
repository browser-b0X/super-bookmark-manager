// Saved copies in Node, synthetic links and a stand-in server: after restoring a JSON-only backup
// on a new install the links still say "saved", but their copies aren't on this computer. Bulk
// "Save copies" asks the server which are missing (POST /api/archive/missing) and saves those
// again, leaving the copies that are here alone (owner report 8, carried into v0.4.0).
// Run from frontend/: node tests/lost-copies-test.mjs
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

const HERE = 'a'.repeat(32), GONE = 'b'.repeat(32), GONE_IG = 'c'.repeat(32);
const asked = [];
const submitted = [];
globalThis.fetch = async (url, options = {}) => {
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (String(url) === '/api/archive/missing' && options.method === 'POST') {
    const { keys } = JSON.parse(options.body);
    asked.push(keys);
    return json({ ok: true, missing: keys.filter(key => key !== HERE) });
  }
  if (String(url) === '/api/archive' && options.method === 'POST') {
    const body = JSON.parse(options.body);
    submitted.push(body);
    return json({ ok: true, key: GONE, status: 'saved', savedAt: '2026-10-23T10:00:00Z', bytes: 4096 });
  }
  return json({}, 404);
};

const out = await build({
  stdin: {
    contents: `export { useLibrary } from './src/store/library';\nexport { saveCopies, canStillCopy } from './src/lib/savedCopies';\nexport { checkLostCopies, useLostCopies } from './src/lib/lostCopies';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' },
});
const { useLibrary, saveCopies, canStillCopy, checkLostCopies, useLostCopies } = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));

const at = new Date('2026-10-01T10:00:00Z').toISOString();
const link = (id, url, extra = {}) => ({ id, url, source: 'browser', platform: 'web', domain: new URL(url).hostname, status: 'reference',
  createdAt: at, updatedAt: at, categories: ['other'], tags: [], projectIds: [], title: id, ...extra });
const saved = key => ({ archiveStatus: 'saved', archiveKey: key, archivedAt: at, archiveBytes: 2048 });
useLibrary.setState({ posts: [
  link('here', 'https://example.com/here', saved(HERE)),
  link('gone', 'https://example.com/gone', saved(GONE)),
  link('ig', 'https://www.instagram.com/p/SYNTH123/', saved(GONE_IG)),
  link('none', 'https://example.com/none'),
], pending: {} });
const get = id => useLibrary.getState().posts.find(p => p.id === id);
const until = async (what, test) => {
  for (let i = 0; i < 100 && !test(); i++) await new Promise(r => setTimeout(r, 30));
  assert.ok(test(), what);
};
const failures = [];
const check = async (name, run) => {
  try { await run(); console.log('PASS', name); } catch (error) { failures.push(name); console.error('FAIL', name, '\n ', error.message.split('\n').slice(0, 6).join('\n  ')); }
};

await check('the server is asked about the keys of links that say they have a copy', async () => {
  await checkLostCopies(useLibrary.getState().posts);
  assert.deepEqual(asked.at(-1)?.slice().sort(), [HERE, GONE, GONE_IG].sort());
  assert.deepEqual([...useLostCopies.getState().keys].sort(), [GONE, GONE_IG].sort());
});

await check('a link whose copy is missing here counts as without one; Instagram stays the button\'s', async () => {
  assert.equal(canStillCopy(get('here')), false, 'its copy is on this computer');
  assert.equal(canStillCopy(get('gone')), true, 'its copy is missing');
  assert.equal(canStillCopy(get('ig')), false, 'only the bookmark button can save Instagram posts');
  assert.equal(canStillCopy(get('none')), true);
});

await check('bulk Save copies saves the missing copy again and leaves the one that is here', async () => {
  const count = saveCopies(['here', 'gone', 'none'], { skipFinal: true });
  assert.equal(count, 2);
  await until('both copies are asked for', () => submitted.length === 2);
  assert.deepEqual(submitted.map(body => body.url).sort(), ['https://example.com/gone', 'https://example.com/none']);
  assert.ok(submitted.every(body => !body.refresh), 'a missing copy is saved, not updated');
  await until('the copy is recorded', () => get('gone').archiveStatus === 'saved' && !useLostCopies.getState().keys.has(GONE));
  assert.equal(get('here').archiveStatus, 'saved');
});

if (failures.length) { console.error(`FAILED ${failures.length}: ${failures.join('; ')}`); process.exit(1); }
console.log('ALL PASS');
process.exit(0);   // the store keeps timers running
