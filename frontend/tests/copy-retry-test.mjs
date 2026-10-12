// Saved copies in Node, synthetic links and a stand-in /api/archive: a site that asks the app to
// slow down (Reddit answered HTTP 429, shown as "busy" in the RUN-ME-4 report) is asked again by
// itself after a minute, then after five, and then left for Update.
// Run from frontend/: node tests/copy-retry-test.mjs
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

// The stand-in server: every copy is queued, then comes back with the next answer in `answers`.
const answers = [];
const submitted = [];
globalThis.fetch = async (url, options = {}) => {
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (String(url) === '/api/archive' && options.method === 'POST') {
    submitted.push(JSON.parse(options.body));
    return json({ ok: true, key: 'k1', status: 'queued' }, 202);
  }
  if (String(url).startsWith('/api/archive?keys=')) {
    const answer = answers.shift() ?? { status: 'failed', error: 'busy' };
    // Like archive.py: a failed update says which copy is still there.
    const previous = submitted.at(-1)?.refresh && answer.status === 'failed' ? { previous: { savedAt: '2026-10-01T10:00:00Z', bytes: 2048 } } : {};
    return json({ copies: { k1: { key: 'k1', ...answer, ...previous } } });
  }
  return json({}, 404);
};

// The minute-long retry timers are recorded here instead of waited for (polling every 1.5 s runs for real).
const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
const long = new Map();
let seq = 0;
globalThis.setTimeout = (fn, ms, ...rest) => {
  if (!(ms >= 10_000)) return realSet(fn, ms, ...rest);
  const id = { long: ++seq };
  long.set(id, { fn, seconds: Math.round(ms / 1000) });
  return id;
};
globalThis.clearTimeout = id => { if (id && id.long) long.delete(id); else realClear(id); };
const waits = () => [...long.values()].map(t => t.seconds);
const fire = () => { const [[id, timer]] = [...long]; long.delete(id); timer.fn(); };

const out = await build({
  stdin: {
    contents: `export { useLibrary } from './src/store/library';\nexport { saveCopy } from './src/lib/savedCopies';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' },
});
const { useLibrary, saveCopy } = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const at = new Date('2026-10-01T10:00:00Z').toISOString();
useLibrary.setState({ posts: [{ id: 'r1', url: 'https://www.reddit.com/r/synthetic/comments/abc123/a_post/', source: 'browser', platform: 'reddit',
  domain: 'reddit.com', status: 'reference', createdAt: at, updatedAt: at, categories: ['other'], tags: [], projectIds: [], title: 'A post' }], pending: {} });
const get = () => useLibrary.getState().posts.find(p => p.id === 'r1');
const until = async (what, test) => {
  for (let i = 0; i < 100 && !test(); i++) await new Promise(r => realSet(r, 50));
  assert.ok(test(), what);
};
const failures = [];
const check = async (name, run) => {
  try { await run(); console.log('PASS', name); } catch (error) { failures.push(name); console.error('FAIL', name, '\n ', error.message.split('\n').slice(0, 6).join('\n  ')); }
};

await check('"busy" is asked again by itself after a minute, and the copy is saved', async () => {
  answers.push({ status: 'failed', error: 'busy' }, { status: 'saved', savedAt: at, bytes: 2048 });
  saveCopy('r1');
  await until('the busy answer is recorded', () => get().archiveError === 'busy');
  assert.equal(get().archiveStatus, 'failed');
  assert.deepEqual(waits(), [60]);
  fire();
  await until('the copy is saved on the second try', () => get().archiveStatus === 'saved');
  assert.equal(submitted.length, 2);
  assert.deepEqual(waits(), [], 'nothing more to wait for');
});

await check('a copy that stays busy is tried after one minute, then five, then left for Update', async () => {
  submitted.length = 0;
  answers.push({ status: 'failed', error: 'busy' }, { status: 'failed', error: 'busy' }, { status: 'failed', error: 'busy' });
  saveCopy('r1', { refresh: true });
  await until('busy again', () => get().archiveError === 'busy');
  assert.equal(get().archiveStatus, 'saved', 'the earlier copy is still the copy');
  assert.deepEqual(waits(), [60]);
  fire();
  await until('second try answered', () => submitted.length === 2 && get().archiveError === 'busy' && long.size === 1);
  assert.deepEqual(waits(), [300]);
  fire();
  await until('third try answered', () => submitted.length === 3 && get().archiveError === 'busy');
  await new Promise(r => realSet(r, 300));
  assert.deepEqual(waits(), [], 'left for Update after that');
  assert.ok(submitted.every(body => body.refresh === true), 'an update stays an update');
});

if (failures.length) { console.error(`FAILED ${failures.length}: ${failures.join('; ')}`); process.exit(1); }
console.log('ALL PASS');
process.exit(0);   // the store keeps timers running
