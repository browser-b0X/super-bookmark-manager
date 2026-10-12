// Audit phase 1: one URL identity, recoverable sync, shelf ops, large caches.
// Real Flask app + synthetic SQLite under .verify; the browser runs a store
// harness at the server's own origin so /api calls hit the real backend.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = await mkdtemp(join(root, '.verify', 'audit-sync-'));
const db = join(evidence, 'fixture.sqlite');
const port = 15000 + Math.floor(Math.random() * 20000);
const server = spawn(process.env.C4_PYTHON || 'python3', ['-B', '-c', `
import os, sys
sys.path.insert(0, ${JSON.stringify(root)})
os.environ["SAVED_POSTS_DB_PATH"] = ${JSON.stringify(db)}
os.environ["SBM_AI_CONFIG_FILE"] = ${JSON.stringify(db + ".ai.json")}
import storage, app
storage.init_db()
app.app.run(host="127.0.0.1", port=${port}, debug=False)
`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(base + '/api/stats')).ok) break; } catch { /* starting */ }
  await new Promise(r => setTimeout(r, 100));
}

const bundle = await build({
  stdin: { contents: `
    export { useLibrary } from './src/store/library';
    export { syncLibrary, startLibraryPersistence, useLibraryPersistence } from './src/lib/libraryPersistence';
    export { useStorageHealth } from './src/lib/libraryStorage';
    export { postFromUrl } from './src/lib/providers';
  `, loader: 'tsx', resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  jsx: 'automatic', bundle: true, write: false, format: 'iife', globalName: 'sbm', define: { 'process.env.NODE_ENV': '"test"' },
});
const harness = `<!doctype html><div id="root"></div><script>${bundle.outputFiles[0].text}</script>`;

const browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
const api = async (path, body) => (await fetch(base + path, body === undefined ? {} : {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();

try {
  const context = await browser.newContext();
  await context.route(`${base}/harness`, route => route.fulfill({ contentType: 'text/html', body: harness }));
  const page = await context.newPage();
  await page.goto(`${base}/harness`);
  const sync = () => page.evaluate(async () => {
    const ok = await sbm.syncLibrary();
    const s = sbm.useLibrary.getState();
    return { ok, status: sbm.useLibraryPersistence.getState(), pending: Object.keys(s.pending).length, rejected: s.rejected, posts: s.posts.length };
  });
  await sync();

  await check('delete then re-add a URL variant never wedges saving', async () => {
    await page.evaluate(() => sbm.useLibrary.getState().addByUrl('https://www.example.invalid/page/'));
    assert.equal((await sync()).pending, 0);
    await page.evaluate(() => {
      const s = sbm.useLibrary.getState();
      s.deletePosts(s.posts.filter(p => p.url.includes('/page')).map(p => p.id));
    });
    assert.equal((await sync()).pending, 0);
    await page.evaluate(() => {
      sbm.useLibrary.getState().addByUrl('https://www.example.invalid/page');
      sbm.useLibrary.getState().addByUrl('https://unrelated.example.invalid/after');
    });
    const result = await sync();
    assert.equal(result.ok, true); assert.equal(result.pending, 0); assert.deepEqual(result.rejected, {});
    const urls = (await api('/api/library')).posts.map(p => p.url).sort();
    assert.deepEqual(urls, ['https://unrelated.example.invalid/after', 'https://www.example.invalid/page']);
  });

  await check('explicitly re-adding a deleted link saves it again', async () => {
    await page.evaluate(() => {
      const s = sbm.useLibrary.getState();
      s.deletePosts(s.posts.filter(p => p.url.includes('unrelated')).map(p => p.id));
    });
    await sync();
    const added = await page.evaluate(() => sbm.useLibrary.getState().addByUrl('https://unrelated.example.invalid/after'));
    assert.ok(added, 'addByUrl returned null for a previously deleted link');
    assert.equal((await sync()).pending, 0);
    assert.ok((await api('/api/library')).posts.some(p => p.url === 'https://unrelated.example.invalid/after'));
  });

  await check('shelf rename and adds stay within the server limit and keep IDs', async () => {
    await page.evaluate(() => {
      const s = sbm.useLibrary.getState();
      const post = s.posts[0];
      s.updatePost(post.id, { categories: ['travel'] });
      s.renameCategory('travel', 'trips');
      s.addCategory('alpha'); s.addCategory('beta'); s.addCategory('gamma');
    });
    let result = await sync();
    assert.equal(result.pending, 0); assert.deepEqual(result.rejected, {});
    const cats = (await api('/api/library')).categories;
    assert.ok(cats.includes('trips') && !cats.includes('travel'), cats.join());
    const state = await page.evaluate(() => sbm.useLibrary.getState().categories.find(c => c.name === 'trips'));
    assert.equal(state.id, 'travel', 'renaming must keep the shelf ID stable');
    await page.evaluate(() => {
      const s = sbm.useLibrary.getState();
      s.updatePost(s.posts[1].id, { categories: ['gamma'] });
    });
    result = await sync();
    assert.equal(result.pending, 0); assert.deepEqual(result.rejected, {});
  });

  await check('a refused item is parked for attention while the rest saves', async () => {
    await page.evaluate(() => {
      const s = sbm.useLibrary.getState();
      const [a, b] = s.posts;
      // Bypass the client cap to simulate a stale tab writing a 13th shelf.
      sbm.useLibrary.setState({ pending: { ...s.pending,
        [a.url]: { ...a, categories: ['extra-13', 'extra-14'], updatedAt: new Date().toISOString() },
        [b.url]: { ...b, userNotes: 'saved alongside', updatedAt: new Date().toISOString() } } });
    });
    const result = await sync();
    assert.equal(result.ok, true); assert.equal(result.pending, 0);
    assert.deepEqual(Object.values(result.rejected).map(r => r.reason), ['shelf_limit']);
    assert.ok((await api('/api/library')).posts.some(p => p.userNotes === 'saved alongside'));
    await page.evaluate(() => sbm.useLibrary.getState().discardRejected(Object.keys(sbm.useLibrary.getState().rejected)[0]));
  });

  await check('legacy rows under another spelling are adopted and export works', async () => {
    const legacy = spawn(process.env.C4_PYTHON || 'python3', ['-B', '-c', `
import os, sys
sys.path.insert(0, ${JSON.stringify(root)})
os.environ["SAVED_POSTS_DB_PATH"] = ${JSON.stringify(db)}
os.environ["SBM_AI_CONFIG_FILE"] = ${JSON.stringify(db + ".ai.json")}
import storage
storage.insert_post(91001, "2026-09-17T12:00:00Z", "a", "https://www.example.invalid/watch?v=1&si=aaa", "youtube", "{}")
storage.insert_post(91002, "2026-09-17T12:00:01Z", "b", "https://example.invalid/watch?v=1&si=bbb", "youtube", "{}")
`], { cwd: root });
    await new Promise(r => legacy.on('exit', r));
    assert.equal((await api('/api/library')).legacyRows.length, 2);
    const result = await sync();
    assert.equal(result.pending, 0);
    assert.equal((await api('/api/library')).legacyRows.length, 0);
    const exported = await api('/api/backup/export', { confirm: true });
    assert.equal(exported.ok, true, exported.error);
  });

  await check('a library too large for localStorage moves to IndexedDB and reloads intact', async () => {
    const offline = await browser.newContext();
    await offline.route('**/*', route => (route.request().url().endsWith('/harness')
      ? route.fulfill({ contentType: 'text/html', body: harness })
      : route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false,"error":"offline"}' })));
    const p2 = await offline.newPage();
    await p2.goto('http://audit-storage.invalid/harness');
    const count = 7000;
    await p2.evaluate(n => {
      const posts = Array.from({ length: n }, (_, i) => ({ ...sbm.postFromUrl(`https://bulk.example.invalid/${i}/${'x'.repeat(200)}`, 'browser'),
        description: 'Lorem ipsum '.repeat(20) }));
      return sbm.useLibrary.getState().importPosts(posts);
    }, count);
    await p2.waitForFunction(() => sbm.useStorageHealth.getState().backend === 'indexeddb', null, { timeout: 15000 });
    assert.equal(await p2.evaluate(() => sbm.useStorageHealth.getState().error), '');
    assert.equal(await p2.evaluate(() => localStorage.getItem('library-store-v1')), '{"sbmStorage":"indexeddb"}');
    await p2.reload();
    await p2.waitForFunction(n => sbm.useLibrary.persist.hasHydrated() && sbm.useLibrary.getState().posts.length === n, count, { timeout: 15000 });
    assert.equal(await p2.evaluate(() => Object.keys(sbm.useLibrary.getState().pending).length), count);
    await offline.close();
  });
  await check('two tabs never erase each other\'s unsaved edits while SQLite is down', async () => {
    const offline = await browser.newContext();
    await offline.route('**/*', route => (route.request().url().endsWith('/harness')
      ? route.fulfill({ contentType: 'text/html', body: harness })
      : route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false,"error":"offline"}' })));
    const a = await offline.newPage(), b = await offline.newPage();
    await a.goto('http://audit-tabs.invalid/harness');
    await a.evaluate(() => sbm.useLibrary.getState().importPosts([sbm.postFromUrl('https://tabs.example.invalid/one'), sbm.postFromUrl('https://tabs.example.invalid/two')]));
    await b.goto('http://audit-tabs.invalid/harness');
    for (const page of [a, b]) await page.evaluate(() => sbm.startLibraryPersistence());
    await a.evaluate(() => { const s = sbm.useLibrary.getState(); s.updatePost(s.posts.find(p => p.url.endsWith('/one')).id, { userNotes: 'from A' }); });
    await b.waitForFunction(() => sbm.useLibrary.getState().posts.find(p => p.url.endsWith('/one'))?.userNotes === 'from A', null, { timeout: 15000 });
    await b.evaluate(() => { const s = sbm.useLibrary.getState(); s.updatePost(s.posts.find(p => p.url.endsWith('/two')).id, { userNotes: 'from B' }); });
    await a.waitForFunction(() => sbm.useLibrary.getState().posts.find(p => p.url.endsWith('/two'))?.userNotes === 'from B', null, { timeout: 15000 });
    const stored = await a.evaluate(() => JSON.parse(localStorage.getItem('library-store-v1')).state.posts.map(p => p.userNotes || '').sort());
    assert.deepEqual(stored, ['from A', 'from B']);
    await offline.close();
  });
} finally {
  await browser.close();
  server.kill();
}
if (failures.length) {
  console.error(serverLog.split('\n').slice(-20).join('\n'));
  throw new Error(`audit sync checks failed: ${failures.join(', ')}`);
}
console.log(`PASS audit sync e2e; evidence ${evidence}`);
