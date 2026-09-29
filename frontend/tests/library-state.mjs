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
    import { BrowserRouter, useLocation } from 'react-router-dom';
    import PostDrawer from './src/components/library/PostDrawer';
    import { useLibrary } from './src/store/library';
    export { useLibrary };
    export { postFromUrl } from './src/lib/providers';
    function Harness() {
      const location = useLocation();
      const posts = useLibrary(s => s.posts);
      const post = posts.find(p => p.id === location.pathname.slice(14)) || posts[0];
      return <PostDrawer post={post} onClose={() => {}} />;
    }
    export function mount() { createRoot(document.getElementById('root')).render(<BrowserRouter><Harness /></BrowserRouter>); }
  `, loader: 'tsx', resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  jsx: 'automatic', bundle: true, write: false, format: 'iife', globalName: 'c4', define: { 'process.env.NODE_ENV': '"test"' },
});
const browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
}
try {
  const context = await browser.newContext();
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }));
  const page = await context.newPage();
  await page.goto('http://c4-state.invalid');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const setup = () => page.evaluate(() => {
    const a = { ...c4.postFromUrl('https://example.invalid/first'), id: 'first', title: 'First fixture', categories: ['other'], userNotes: 'First note', tags: ['MixedCase'] };
    const b = { ...c4.postFromUrl('https://example.invalid/second'), id: 'second', title: 'Second fixture', userNotes: 'Second note' };
    c4.useLibrary.setState({ posts: [], pending: {}, deletedUrls: [], demo: false });
    c4.useLibrary.getState().importPosts([a, b]);
    return [a, b];
  });
  await check('imports and edits persist unacknowledged payloads in browser storage', async () => {
    const [a] = await setup();
    const pending = await page.evaluate(() => {
      c4.useLibrary.getState().updatePost('first', { favorite: true, status: 'archived' });
      return JSON.parse(localStorage.getItem('library-store-v1')).state.pending;
    });
    assert.equal(pending?.[a.url]?.favorite, true);
    assert.equal(pending[a.url].status, 'archived');
    assert.deepEqual(pending[a.url].tags, ['MixedCase']);
  });
  await check('confirmed deletion suppresses reimport and retains a pending tombstone', async () => {
    const [a] = await setup();
    const result = await page.evaluate(a => {
      const store = c4.useLibrary.getState();
      store.deletePosts([a.id]);
      const imported = store.importPosts([a]);
      return { imported, state: JSON.parse(localStorage.getItem('library-store-v1')).state };
    }, a);
    assert.equal(result.imported.added, 0);
    assert.equal(result.state.posts.length, 1);
    assert.equal(result.state.pending[a.url], null);
    assert.ok(result.state.deletedUrls.includes(a.url));
  });
  await check('legacy reconciliation does not replace manual other', async () => {
    const [a] = await setup();
    const categories = await page.evaluate(a => {
      c4.useLibrary.setState({ posts: [{ ...a, id: 'tg-1' }] });
      c4.useLibrary.getState().adoptServerCategories([{ tg_msg_id: 1, category: 'technology' }]);
      return c4.useLibrary.getState().posts[0].categories;
    }, a);
    assert.deepEqual(categories, ['other']);
  });
  await check('real imports replace demo content and become pending', async () => {
    const [a] = await setup();
    const result = await page.evaluate(a => {
      c4.useLibrary.setState({ posts: [], pending: {}, deletedUrls: [], demo: false });
      c4.useLibrary.getState().seedDemo();
      const demoPending = Object.keys(c4.useLibrary.getState().pending).length;
      c4.useLibrary.getState().importPosts([a]);
      return { demoPending, state: JSON.parse(localStorage.getItem('library-store-v1')).state };
    }, a);
    assert.equal(result.demoPending, 0);
    assert.equal(result.state.demo, false);
    assert.equal(result.state.posts.length, 1);
    assert.equal(result.state.pending[a.url].id, a.id);
  });
  await check('manual additions replace demo content and become pending', async () => {
    const result = await page.evaluate(() => {
      c4.useLibrary.setState({ posts: [], pending: {}, deletedUrls: [], demo: false });
      c4.useLibrary.getState().seedDemo();
      const post = c4.useLibrary.getState().addByUrl('https://example.invalid/manual');
      return { post, state: JSON.parse(localStorage.getItem('library-store-v1')).state };
    });
    assert.equal(result.state.demo, false);
    assert.equal(result.state.posts.length, 1);
    assert.equal(result.state.pending[result.post.url].id, result.post.id);
  });
  await check('version two cache migrates intact into pending durable adoption', async () => {
    const [a, b] = await setup();
    const result = await page.evaluate(async ([a, b]) => {
      const state = JSON.parse(localStorage.getItem('library-store-v1')).state;
      delete state.pending;
      delete state.deletedUrls;
      localStorage.setItem('library-store-v1', JSON.stringify({ state, version: 2 }));
      await c4.useLibrary.persist.rehydrate();
      return JSON.parse(localStorage.getItem('library-store-v1'));
    }, [a, b]);
    assert.equal(result.version, 3);
    assert.deepEqual(result.state.posts, [a, b]);
    assert.deepEqual(result.state.pending, { [a.url]: a, [b.url]: b });
    assert.deepEqual(result.state.deletedUrls, []);
  });
  await check('Related navigation displays and edits the correct note', async () => {
    await setup();
    await page.evaluate(() => c4.mount());
    const notes = page.getByPlaceholder('Your notes…');
    assert.equal(await notes.inputValue(), 'First note');
    await page.getByRole('button', { name: 'Second fixture', exact: true }).click();
    assert.equal(await notes.inputValue(), 'Second note');
    await notes.fill('Second edited');
    await page.getByRole('button', { name: 'First fixture', exact: true }).click();
    assert.equal(await notes.inputValue(), 'First note');
    const posts = await page.evaluate(() => c4.useLibrary.getState().posts);
    assert.equal(posts[0].userNotes, 'First note');
    assert.equal(posts[1].userNotes, 'Second edited');
  });
  await context.close();
} finally { await browser.close(); }
assert.deepEqual(failures, [], 'C4 state checks failed');
