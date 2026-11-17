// "Check again while the app is open" (Settings > Telegram) in Node, with a stand-in server and
// recorded timers: off until turned on; then one read every chosen interval, never two tabs at once,
// a note only when new links arrive (and once when a check can't run).
// Run from frontend/: node tests/telegram-timed-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

// The stand-in server: an empty library that accepts saves, and a Telegram read answering `next`.
const refreshes = [];
let next = { ok: true, checked: 0, limit: 200, malformed: 0 };
globalThis.fetch = async (url, options = {}) => {
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (String(url) === '/api/telegram/refresh') { refreshes.push(JSON.parse(options.body)); return json(next, next.ok ? 200 : 503); }
  if (String(url).startsWith('/api/library')) return json({ ok: true, posts: [], deletedUrls: [], legacyRows: [], categories: [], rev: 1, epoch: 0 });
  if (String(url) === '/api/categorize') return json({ ok: false }, 503);
  return json({}, 404);
};

// Timers of a minute or more are recorded instead of waited for.
const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
const long = new Map();
let seq = 0;
globalThis.setTimeout = (fn, ms, ...rest) => {
  if (!(ms >= 60_000)) return realSet(fn, ms, ...rest);
  const id = { long: ++seq };
  long.set(id, { fn, minutes: Math.round(ms / 60_000) });
  return id;
};
globalThis.clearTimeout = id => { if (id && id.long) long.delete(id); else realClear(id); };
const waits = () => [...long.values()].map(t => t.minutes);
const fire = async () => {
  const [[id, timer]] = [...long];
  long.delete(id);
  timer.fn();
  await new Promise(r => realSet(r, 200));
};

const out = await build({
  stdin: {
    contents: `export { usePrefs } from './src/store/prefs';\nexport { startTimedTelegramRefresh, useNotice, useTimedTelegram } from './src/lib/telegramRefresh';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' },
});
const { usePrefs, startTimedTelegramRefresh, useNotice, useTimedTelegram } = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const failures = [];
const check = async (name, run) => {
  try { await run(); console.log('PASS', name); } catch (error) { failures.push(name); console.error('FAIL', name, '\n ', error.message.split('\n').slice(0, 6).join('\n  ')); }
};

const stop = startTimedTelegramRefresh();

await check('off by default: nothing is scheduled', async () => {
  assert.equal(usePrefs.getState().telegramTimedCheck, false);
  assert.equal(usePrefs.getState().telegramCheckMinutes, 60);
  assert.deepEqual(waits(), []);
});

await check('turned on: one read every hour, and no note when nothing is new', async () => {
  usePrefs.getState().setTelegramTimedCheck(true);
  assert.deepEqual(waits(), [60]);
  assert.ok(useTimedTelegram.getState().nextAt > Date.now() + 59 * 60_000);
  await fire();
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].startup, undefined, 'an ordinary read, not the once-per-run start-up check');
  assert.equal(useNotice.getState().text, '');
  assert.deepEqual(waits(), [60], 'the next one is scheduled');
  assert.ok(useTimedTelegram.getState().lastAt <= Date.now());
});

await check('another interval is used at once', async () => {
  usePrefs.getState().setTelegramCheckMinutes(180);
  assert.deepEqual(waits(), [180]);
  usePrefs.getState().setTelegramCheckMinutes(30);
  assert.deepEqual(waits(), [30]);
});

await check('another tab that just checked: this tab waits for the next turn', async () => {
  localStorage.setItem('sbm-telegram-timed-check', JSON.stringify({ at: Date.now(), added: 0 }));
  await fire();
  assert.equal(refreshes.length, 1, 'no second read');
  assert.deepEqual(waits(), [30]);
});

await check('a check that can\'t run says so once, not every time', async () => {
  localStorage.removeItem('sbm-telegram-timed-check');
  next = { ok: false, error: 'Telegram is not connected.' };
  useNotice.getState().clear();
  // Skip the shared wait: the last check is long ago.
  localStorage.setItem('sbm-telegram-timed-check', JSON.stringify({ at: Date.now() - 3 * 3600_000, added: 0 }));
  await fire();
  assert.match(useNotice.getState().text, /Telegram check didn't run: Telegram is not connected\./);
  useNotice.getState().clear();
  localStorage.setItem('sbm-telegram-timed-check', JSON.stringify({ at: Date.now() - 3 * 3600_000, added: 0 }));
  await fire();
  assert.equal(refreshes.length, 3);
  assert.equal(useNotice.getState().text, '', 'said once');
});

await check('new links arrive: a note says how many', async () => {
  const exported = JSON.parse(readFileSync(new URL('./fixtures/telegram-saved-messages.json', import.meta.url), 'utf8'));
  next = { ok: true, checked: exported.messages.length, limit: 200, malformed: 0, export: exported };
  useNotice.getState().clear();
  localStorage.setItem('sbm-telegram-timed-check', JSON.stringify({ at: Date.now() - 3 * 3600_000, added: 0 }));
  await fire();
  assert.match(useNotice.getState().text, /^Telegram: \d+ new links? from Saved Messages/);
  assert.ok(useTimedTelegram.getState().added > 0);
});

await check('turned off: the timer goes', async () => {
  usePrefs.getState().setTelegramTimedCheck(false);
  assert.deepEqual(waits(), []);
  assert.equal(useTimedTelegram.getState().nextAt, undefined);
});

stop();
if (failures.length) { console.error(`FAILED ${failures.length}: ${failures.join('; ')}`); process.exit(1); }
console.log('ALL PASS');
process.exit(0);   // the store keeps timers running
