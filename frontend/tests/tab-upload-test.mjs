// The Save window's upload of a file from the owner's tab (lib/tabMedia.ts) uses XMLHttpRequest for its progress, which
// the packaged app's fetch wrapper (lib/publicRuntime.ts) doesn't reach, so it carries this run's token itself: without
// it the installed app refused every Instagram picture and video handed over. Synthetic bytes; no network.
// Run from frontend/: node tests/tab-upload-test.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const sent = [];
globalThis.window = globalThis;
globalThis.XMLHttpRequest = class {
  upload = {}; headers = {};
  open(method, path) { Object.assign(this, { method, path }); }
  setRequestHeader(name, value) { this.headers[name] = value; }
  send() { sent.push(this); this.status = 200; this.responseText = JSON.stringify({ ok: true, id: 'a'.repeat(64) }); this.onload(); }
};
const out = await build({
  stdin: { contents: `export { uploadTabFile } from './src/lib/tabMedia';`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
let copy = 0;
// The token is read once, when the page loads: each page gets its own copy of the module.
const page = token => {
  globalThis.document = { querySelector: selector => (token && selector.includes('sbm-instance') ? { content: token } : null) };
  return import('data:text/javascript;base64,' + Buffer.from(`${out.outputFiles[0].text}\n// page ${++copy}`).toString('base64'));
};
const upload = async token => {
  const id = await (await page(token)).uploadTabFile(new Blob(['synthetic'], { type: 'image/png' }), () => {});
  return { id, request: sent.at(-1) };
};

let failures = 0;
const check = async (name, run) => { try { await run(); console.log(`PASS ${name}`); } catch (e) { failures++; console.error(`FAIL ${name}: ${e.message.split('\n').slice(0, 4).join(' | ')}`); } };

await check('in the packaged app the upload carries this run\'s token', async () => {
  const { id, request } = await upload('run-token');
  assert.equal(request.headers['X-SBM-Instance'], 'run-token');
  assert.deepEqual([request.method, request.path], ['POST', '/api/archive/media']);
  assert.equal(request.headers['Content-Type'], 'image/png');
  assert.equal(id, 'a'.repeat(64));
});

await check('run from source there is no token, and no header', async () => {
  const { id, request } = await upload('');
  assert.equal('X-SBM-Instance' in request.headers, false);
  assert.equal(id, 'a'.repeat(64));
});

if (failures) { console.error(`FAILED ${failures}`); process.exit(1); }
console.log('ALL PASS');
