import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const bundle = await build({
  stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { useLegacyMigration } from './src/lib/migrate';
    export { useLibrary } from './src/store/library';
    export { postFromUrl } from './src/lib/providers';
    function Harness() { useLegacyMigration(); return null; }
    export function mount() { createRoot(document.getElementById('root')).render(<Harness />); }
  `, loader: 'tsx', resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  jsx: 'automatic', bundle: true, write: false, format: 'iife', globalName: 'c4', define: { 'process.env.NODE_ENV': '"test"' },
});
const browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
try {
  const context = await browser.newContext();
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }));
  const page = await context.newPage();
  await page.goto('http://c4-sync.invalid');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => {
    window.db = { posts: [], deletedUrls: [], legacyRows: [] };
    window.writes = [];
    window.hold = false;
    window.failWrites = false;
    window.fetch = async (url, options = {}) => {
      if (url === '/api/stats') return Response.json({ total: 0 });
      if (url === '/api/categories' || url.startsWith('/api/posts')) return Response.json([]);
      if (url !== '/api/library') throw new Error('Unexpected URL: ' + url);
      if (options.method === 'POST') {
        const delta = JSON.parse(options.body);
        window.writes.push(delta);
        if (window.hold) await new Promise(resolve => { window.release = resolve; });
        if (window.failWrites) return Response.json({ ok: false, error: 'Fixture write failed' }, { status: 503 });
        for (const url of delta.deletedUrls) {
          if (!db.deletedUrls.includes(url)) db.deletedUrls.push(url);
          db.posts = db.posts.filter(p => p.url !== url);
        }
        for (const p of delta.posts) {
          if (db.deletedUrls.includes(p.url)) continue;
          db.posts = [...db.posts.filter(old => old.url !== p.url), p];
        }
        return Response.json({ ok: true, ...db });
      }
      return Response.json(db);
    };
    const post = { ...c4.postFromUrl('https://example.invalid/sync'), id: 'sync', userNotes: 'Cached note', categories: ['other'], tags: ['MixedCase'] };
    c4.useLibrary.getState().importPosts([post]);
    c4.mount();
  });
  await page.waitForFunction(() => db.posts.length === 1 && Object.keys(c4.useLibrary.getState().pending).length === 0, { timeout: 4000 });
  assert.equal(await page.evaluate(() => db.posts[0].userNotes), 'Cached note');
  console.log('PASS startup durably adopts cached imports');

  await page.evaluate(() => {
    window.hold = true;
    c4.useLibrary.getState().updatePost('sync', { userNotes: 'First in-flight edit' });
  });
  await page.waitForFunction(() => typeof window.release === 'function');
  await page.evaluate(() => {
    c4.useLibrary.getState().updatePost('sync', { userNotes: 'Newest in-flight edit', favorite: true });
    window.hold = false;
    window.release();
    delete window.release;
  });
  await page.waitForFunction(() => db.posts[0]?.userNotes === 'Newest in-flight edit' && Object.keys(c4.useLibrary.getState().pending).length === 0);
  assert.equal(await page.evaluate(() => c4.useLibrary.getState().posts[0].userNotes), 'Newest in-flight edit');
  console.log('PASS in-flight acknowledgement retains and subsequently saves newer edits');

  await page.evaluate(() => {
    window.failWrites = true;
    c4.useLibrary.getState().updatePost('sync', { userNotes: 'Offline edit' });
  });
  await page.waitForFunction(() => writes.some(w => w.posts.some(p => p.userNotes === 'Offline edit')));
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('library-store-v1')).state.pending['https://example.invalid/sync'].userNotes), 'Offline edit');
  assert.equal(await page.evaluate(() => db.posts[0].userNotes), 'Newest in-flight edit');
  await page.evaluate(() => { window.failWrites = false; window.dispatchEvent(new Event('online')); });
  await page.waitForFunction(() => db.posts[0]?.userNotes === 'Offline edit' && Object.keys(c4.useLibrary.getState().pending).length === 0);
  console.log('PASS failed writes remain pending and reconnect saves the latest edit');

  await page.evaluate(() => c4.useLibrary.getState().deletePosts(['sync']));
  await page.waitForFunction(() => db.posts.length === 0 && db.deletedUrls.length === 1 && Object.keys(c4.useLibrary.getState().pending).length === 0);
  console.log('PASS deletion delta is acknowledged only after durable suppression');
  await context.close();
} finally { await browser.close(); }
