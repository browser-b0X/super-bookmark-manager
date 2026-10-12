// "Fetch missing previews" in Node, synthetic links and a stand-in /api/enrich: which links count as
// missing, the owner's request going ahead of background work, links that keep failing being set
// aside, a paused queue resuming when the owner asks, and pictures missing on this computer (a backup
// restored on a new install keeps each link's picture address but not the picture file).
// Run from frontend/: node tests/preview-queue-test.mjs
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

// The stand-in server: answers by the link's shape, records the order links were asked for.
const asked = [];
let hold = 0;
// Links answered "busy" (the server's "too many at once") this many more times.
const busyFor = new Map();
globalThis.fetch = async (url, options = {}) => {
  if (String(url) !== '/api/enrich') return new Response('{}', { status: 404 });
  const link = JSON.parse(options.body).url;
  asked.push(new URL(link).pathname.split('/').pop());
  if (hold) await new Promise(r => setTimeout(r, hold));
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const name = new URL(link).pathname.split('/').pop();
  if (busyFor.get(name) > 0) { busyFor.set(name, busyFor.get(name) - 1); return json({ ok: false, error: 'busy', status: 'failed' }, 503); }
  if (link.includes('/refuse/')) return json({ ok: false, error: 'http_error', status: 'failed', httpStatus: 403 }, 502);
  if (link.includes('/noimg/')) return json({ ok: true, title: 'A page', summary: 'Words.', thumbnail: '', status: 'ok', error: '' });
  return json({ ok: true, title: 'A page', summary: 'Words.', thumbnail: '/thumb/abc', status: 'ok', error: '' });
};

const out = await build({
  stdin: {
    contents: `
      export { useLibrary } from './src/store/library';
      export { enrichMany, enrichSavedPost, setEnrichmentPaused, useEnrichmentQueue } from './src/lib/metadataEnrichment';
      export { needsPreview, couldNotFetch, outcomeOf, failureReason } from './src/lib/previewHealth';
      export { useLostPictures } from './src/lib/lostPictures';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' },
});
const lib = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const { useLibrary, enrichMany, needsPreview, couldNotFetch, outcomeOf, failureReason, useLostPictures } = lib;
const fresh = useLibrary.getState();
const at = new Date('2026-10-01T10:00:00Z').toISOString();
const post = (name, extra = {}) => ({ id: name, url: `https://${name}.example.invalid/${extra.kind ?? 'img'}/${name}`, source: 'browser', platform: 'web',
  domain: `${name}.example.invalid`, status: 'reference', createdAt: at, updatedAt: at, categories: ['technology'], tags: [], projectIds: [],
  title: name, metadataStatus: 'failed', ...extra });
const load = posts => useLibrary.setState({ ...fresh, posts, pending: {}, deletedUrls: [], rejected: {}, purgeUrls: [], undeleteUrls: [], imports: [], syncRev: 0 }, false);
const get = id => useLibrary.getState().posts.find(p => p.id === id);
const failures = [];
const check = async (name, run) => {
  asked.length = 0; hold = 0; lib.setEnrichmentPaused(false); useLostPictures.setState({ codes: new Set() });
  try { await run(); console.log('PASS', name); } catch (error) { failures.push(name); console.error('FAIL', name, '\n ', error.message.split('\n').slice(0, 6).join('\n  ')); }
};

await check('only links with no preview yet count as missing (not pages that simply have no picture)', () => {
  const cases = [
    [post('waiting', { metadataStatus: 'pending' }), true],
    [post('failed'), true],
    [post('failed-again', { metadataTriedAt: at }), false],                       // the owner asked; set aside, listed instead
    [post('carried-over', { metadataStatus: 'partial' }), true],                  // old database, never fetched here
    [post('carried-over-titled', { metadataStatus: 'enriched' }), true],
    [post('read-no-picture', { metadataStatus: 'enriched', enrichedAt: at }), false],
    [post('partial-no-picture', { metadataStatus: 'partial', enrichedAt: at }), false],
    [post('partial-with-picture', { metadataStatus: 'partial', thumbnailUrl: '/thumb/x', enrichedAt: at }), false],   // e.g. a private YouTube video
    [post('empty-page', { metadataStatus: 'none', enrichedAt: at }), false],
    [post('gone', { linkStatus: 'gone', httpStatus: 404 }), false],
    [post('has-picture', { metadataStatus: 'enriched', thumbnailUrl: '/thumb/y', enrichedAt: at }), false],
  ];
  for (const [p, expected] of cases) assert.equal(needsPreview(p), expected, p.id);
  assert.equal(couldNotFetch(post('failed-again', { metadataTriedAt: at })), true);
  assert.equal(couldNotFetch(post('failed')), false);
  assert.equal(failureReason(post('x', { httpStatus: 403 })), 'The site refused (403)');
  assert.equal(failureReason(post('x', { linkStatus: 'gone', httpStatus: 410 })), 'Not found (410)');
  assert.equal(failureReason(post('x', { httpStatus: 503 })), 'The site had an error (503)');
  assert.equal(outcomeOf(post('x', { metadataStatus: 'enriched', enrichedAt: at })), 'words');
});

await check('fetching at the owner\'s request brings the count down, and links that still fail are set aside', async () => {
  load([post('a'), post('b', { kind: 'noimg' }), post('c', { kind: 'refuse' }), post('d', { metadataStatus: 'partial' })]);
  const before = useLibrary.getState().posts.filter(needsPreview).length;
  assert.equal(before, 4);
  await enrichMany(['a', 'b', 'c', 'd'], { force: true });
  assert.equal(useLibrary.getState().posts.filter(needsPreview).length, 0, 'nothing left to count');
  assert.equal(get('a').thumbnailUrl, '/thumb/abc');
  assert.equal(outcomeOf(get('b')), 'words');
  assert.equal(get('c').metadataStatus, 'failed');
  assert.ok(get('c').metadataTriedAt, 'the failure the owner asked about is marked');
  assert.equal(get('c').httpStatus, 403);
  assert.ok(!get('a').metadataTriedAt && get('a').enrichedAt);
});

await check('a background failure is not set aside; a later fetch that works clears the mark', async () => {
  load([post('e', { kind: 'refuse' }), post('f', { metadataTriedAt: at })]);
  await enrichMany(['e']);                       // background (not the owner)
  assert.equal(get('e').metadataStatus, 'failed');
  assert.equal(get('e').metadataTriedAt, undefined);
  assert.equal(needsPreview(get('e')), true);
  await enrichMany(['f'], { force: true });      // works this time
  assert.equal(get('f').metadataTriedAt, undefined);
  assert.equal(get('f').thumbnailUrl, '/thumb/abc');
});

await check('the owner\'s links go ahead of background work, in the order asked, and queued ones are moved up', async () => {
  const names = ['bg1', 'bg2', 'bg3', 'bg4', 'bg5', 'bg6', 'own1', 'own2', 'own3'];
  load(names.map(n => post(n)));
  hold = 60;
  const background = enrichMany(['bg1', 'bg2', 'bg3', 'bg4', 'bg5', 'bg6']);   // 3 start, 3 wait
  const owner = enrichMany(['own1', 'bg5', 'own2', 'own3'], { force: true });  // bg5 was waiting: moved up
  await Promise.all([background, owner]);
  assert.deepEqual(asked.slice(0, 3), ['bg1', 'bg2', 'bg3']);
  assert.deepEqual(asked.slice(3, 7), ['own1', 'bg5', 'own2', 'own3']);
  assert.deepEqual(asked.slice(7), ['bg4', 'bg6']);
  assert.equal(new Set(asked).size, asked.length, 'no link fetched twice');
});

await check('a queued link the owner asks for counts as theirs (marked if it fails)', async () => {
  load(['h1', 'h2', 'h3', 'h4'].map(n => post(n, { kind: n === 'h4' ? 'refuse' : 'img' })));
  hold = 60;
  const background = enrichMany(['h1', 'h2', 'h3', 'h4']);
  const owner = enrichMany(['h4'], { force: true });
  await Promise.all([background, owner]);
  assert.ok(get('h4').metadataTriedAt);
});

await check('a paused queue resumes when the owner asks for previews', async () => {
  load([post('p1'), post('p2')]);
  lib.setEnrichmentPaused(true);
  const waiting = enrichMany(['p1']);              // background: stays paused
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(asked, []);
  await enrichMany(['p2'], { force: true });
  await waiting;
  assert.equal(lib.useEnrichmentQueue.getState().paused, false);
  assert.deepEqual(asked.sort(), ['p1', 'p2']);
});

await check('a sooner retry is not kept waiting behind another link\'s later one, and the later one still comes round', async () => {
  // The 30 s / 5 min / 1 h retry timers are recorded here instead of waited for.
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
  const until = async (what, test) => {
    for (let i = 0; i < 60 && !test(); i++) await new Promise(r => realSet(r, 50));
    assert.ok(test(), what);
  };
  try {
    load([post('late', { metadataAttempts: 2 }), post('soon')]);
    busyFor.set('late', 1); busyFor.set('soon', 1);
    await enrichMany(['late']);                    // busy a third time: back in an hour
    assert.deepEqual(waits(), [3600]);
    await enrichMany(['soon']);                    // busy once: back in 30 s, not after that hour
    assert.deepEqual(waits(), [31]);
    // Its turn comes: "soon" is asked again (and answers); "late" keeps its own turn, still timed.
    useLibrary.setState(s => ({ posts: s.posts.map(p => p.id === 'soon' ? { ...p, metadataRetryAt: new Date(Date.now() - 1000).toISOString() } : p) }));
    asked.length = 0;
    const [[id, timer]] = [...long];
    long.delete(id);
    timer.fn();
    await until('"soon" fetched again', () => get('soon').thumbnailUrl === '/thumb/abc');
    assert.deepEqual(asked, ['soon']);
    assert.equal(waits().length, 1, 'a timer is waiting for "late"');
    assert.ok(waits()[0] >= 3590 && waits()[0] <= 3600, String(waits()));
  } finally {
    globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear;
    busyFor.clear();
  }
});

// Owner report: after restoring a backup on a fresh install, "Fetch missing previews" said (0) and
// couldn't be run, though no picture showed: every link still had its /thumb/ address.
const lostSet = (...codes) => new Set(codes);
const restored = (name, code, extra = {}) => post(name, { metadataStatus: 'enriched', enrichedAt: at, thumbnailUrl: `/thumb/${code}`, ...extra });

await check('a picture missing from this computer counts as a missing preview; one that is here does not', () => {
  const lost = lostSet('lost1');
  assert.equal(needsPreview(restored('r1', 'lost1'), lost), true);
  assert.equal(needsPreview(restored('r2', 'here1'), lost), false);
  assert.equal(needsPreview(restored('r3', 'lost1', { thumbnailUrl: 'https://cdn.example.invalid/lost1' }), lost), false, 'only pictures the app keeps');
  assert.equal(needsPreview(restored('r4', 'lost1', { linkStatus: 'gone' }), lost), false);
  assert.equal(needsPreview(restored('r1', 'lost1')), false, 'without the check it looked fine: the bug');
  assert.equal(outcomeOf(restored('r1', 'lost1'), Date.now(), lost), 'words');
});

await check('fetching it stores the picture again under the same address, and it stops counting', async () => {
  load([restored('g1', 'abc')]);
  useLostPictures.setState({ codes: lostSet('abc') });
  assert.equal(useLibrary.getState().posts.filter(p => needsPreview(p, useLostPictures.getState().codes)).length, 1);
  await enrichMany(['g1'], { force: true });
  const lost = useLostPictures.getState().codes;
  assert.equal(lost.has('abc'), false, 'the server has it again');
  assert.equal(get('g1').thumbnailUrl, '/thumb/abc');
  assert.equal(needsPreview(get('g1'), lost), false);
  assert.equal(outcomeOf(get('g1'), Date.now(), lost), 'picture');
});

await check('if the page no longer gives a picture, the missing one is dropped and the link shows its text card', async () => {
  load([restored('n1', 'lost2', { url: 'https://n1.example.invalid/noimg/n1' })]);
  useLostPictures.setState({ codes: lostSet('lost2') });
  await enrichMany(['n1'], { force: true });
  assert.equal(get('n1').thumbnailUrl, undefined);
  assert.equal(needsPreview(get('n1'), useLostPictures.getState().codes), false);
  assert.equal(outcomeOf(get('n1'), Date.now(), useLostPictures.getState().codes), 'words');
});

await check('if fetching it fails after the owner asked, it is set aside like other failures', async () => {
  load([restored('f1', 'lost3', { url: 'https://f1.example.invalid/refuse/f1' })]);
  useLostPictures.setState({ codes: lostSet('lost3') });
  await enrichMany(['f1'], { force: true });
  const lost = useLostPictures.getState().codes;
  assert.equal(get('f1').metadataStatus, 'failed');
  assert.equal(needsPreview(get('f1'), lost), false, 'not counted again and again');
  assert.equal(couldNotFetch(get('f1'), lost), true, 'listed with "Try them again"');
  assert.equal(couldNotFetch(get('f1')), false, 'a picture that is here is not listed');
});

if (failures.length) { console.error(`FAILED ${failures.length}: ${failures.join('; ')}`); process.exit(1); }
console.log('ALL PASS');
process.exit(0);   // the store keeps timers running
