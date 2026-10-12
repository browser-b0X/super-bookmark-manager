import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { chromium } = createRequire(import.meta.url)(process.env.C5_PLAYWRIGHT_MODULE || 'playwright');
const bundle = await build({
  stdin: { contents: `
    export { useLibrary } from './src/store/library';
    export { postFromUrl } from './src/lib/providers';
    export { importFilePosts } from './src/lib/importCategorization';
    export { appendBoundedShelves } from './src/lib/shelves';
    export { syncLibrary } from './src/lib/libraryPersistence';
  `, resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, write: false, format: 'iife', globalName: 'c5', define: { 'process.env.NODE_ENV': '"test"' },
});
const browser = await chromium.launch({ headless: true, channel: process.env.C5_BROWSER_CHANNEL || undefined });
const failures = [];
const persisted = value => JSON.parse(JSON.stringify(value));
async function check(name, run) {
  const context = await browser.newContext();
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>C5 synthetic state</title>' }));
  const page = await context.newPage();
  try {
    await page.goto('http://c5-state.invalid');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(withPersistence => {
      window.calls = [];
      window.until = async predicate => {
        const deadline = performance.now() + 1500;
        while (!predicate()) {
          if (performance.now() > deadline) throw new Error('Fixture condition did not settle');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      };
      window.make = (id, overrides = {}) => ({ ...c5.postFromUrl('https://example.invalid/' + id), id, title: id, ...overrides });
      if (withPersistence) {
        // Imports now wait for an acknowledged SQLite save before classification.
        // Model that boundary locally while each test still owns its provider stub.
        let database = { posts: [], deletedUrls: [], legacyRows: [] };
        window.fixtureDatabase = () => JSON.parse(JSON.stringify(database));
        let classifyFetch;
        Object.defineProperty(window, 'fetch', {
          configurable: true,
          set: value => { classifyFetch = value; },
          get: () => async (url, options = {}) => {
            if (url === '/api/library') {
              if (options.method === 'POST') {
                const delta = JSON.parse(options.body);
                const posts = new Map(database.posts.map(post => [post.url, post]));
                for (const post of delta.posts) posts.set(post.url, post);
                for (const url of delta.deletedUrls) posts.delete(url);
                database = { posts: [...posts.values()], deletedUrls: [...new Set([...database.deletedUrls, ...delta.deletedUrls])], legacyRows: [] };
              }
              return Response.json({ ok: true, ...database });
            }
            if (url === '/api/enrich') return Response.json({ ok: false }, { status: 503 });
            return classifyFetch(url, options);
          },
        });
      }
      window.fetch = async (url, options) => {
        if (url !== '/api/categorize') throw new Error('Unexpected API');
        const data = JSON.parse(options.body);
        if (data.keywords_only !== true) throw new Error('Provider use forbidden');
        calls.push(data);
        return Response.json({ ok: true, category_name: 'technology' });
      };
    }, !name.startsWith('C4 '));
    await run(page);
    console.log('PASS ' + name);
  } catch (error) { failures.push(name); console.error('FAIL ' + name + ': ' + error.stack); }
  finally { await context.close(); }
}
try {
  await check('eligible stored URLs, not first N input records, are classified', async page => {
    const result = await page.evaluate(async () => {
      const old = make('old', { categories: ['other'], userNotes: 'Keep', tags: ['MixedCase'] });
      const unrelated = make('not-in-this-import');
      c5.useLibrary.getState().importPosts([old, unrelated]);
      const result = c5.importFilePosts([{ ...old, id: 'different-import-id' }, make('new-a'), make('new-b')]);
      await until(() => c5.useLibrary.getState().posts.filter(p => p.id.startsWith('new-')).every(p => p.categoryMode === 'automatic'));
      await c5.syncLibrary();
      return { result, calls, state: c5.useLibrary.getState(), database: fixtureDatabase(), old };
    });
    assert.equal(result.result.added, 2);
    assert.equal(result.calls.length, 2);
    assert.ok(result.calls.every(c => /new-[ab]/.test(c.content)));
    assert.deepEqual(persisted(result.state.posts.find(p => p.id === 'old')), persisted(result.old));
    assert.deepEqual(result.state.posts.filter(p => p.id.startsWith('new-')).map(p => p.categories), [['technology'], ['technology']]);
    assert.equal(result.database.posts.find(p => p.url === 'https://example.invalid/new-a').categoryMode, 'automatic');
    assert.deepEqual(result.state.pending, {});
  });
  await check('single and bulk manual other, empty and uncategorized choices survive reimport', async page => {
    const result = await page.evaluate(async () => {
      const incoming = ['other', 'empty', 'uncat', 'topic'].map(id => make(id));
      const store = c5.useLibrary.getState();
      store.importPosts(incoming);
      store.updatePost('other', { categories: ['other'] });
      store.updatePost('empty', { categories: [] });
      store.bulkPatch(['uncat'], { categories: ['uncategorized'] });
      store.bulkPatch(['topic'], { categories: ['arts-culture'] });
      const before = c5.useLibrary.getState().posts;
      c5.importFilePosts(incoming);
      await new Promise(resolve => setTimeout(resolve, 0));
      return { before, after: c5.useLibrary.getState().posts, calls };
    });
    assert.equal(result.calls.length, 0);
    assert.deepEqual(persisted(result.after), persisted(result.before));
    assert.ok(result.after.every(p => p.categoryMode === 'manual' && p.categoryReview === false));
  });
  await check('in-flight classification cannot override manual edits or resurrect deletion', async page => {
    const result = await page.evaluate(async () => {
      const releases = [];
      let finished = 0;
      const apply = c5.useLibrary.getState().applyAutomaticCategory;
      c5.useLibrary.setState({ applyAutomaticCategory: (...args) => { apply(...args); finished++; } });
      window.fetch = () => new Promise(resolve => releases.push(() => resolve(Response.json({ ok: true, category_name: 'technology' }))));
      c5.importFilePosts([make('edited'), make('deleted')]);
      await until(() => releases.length === 2);
      c5.useLibrary.getState().updatePost('edited', { categories: ['other'], userNotes: 'Manual wins' });
      c5.useLibrary.getState().deletePosts(['deleted']);
      releases.forEach(release => release());
      await until(() => finished === 2);
      await c5.syncLibrary();
      return { ...c5.useLibrary.getState(), database: fixtureDatabase() };
    });
    assert.equal(result.posts.length, 1);
    assert.deepEqual(result.posts[0].categories, ['other']);
    assert.equal(result.posts[0].categoryMode, 'manual');
    assert.equal(result.posts[0].userNotes, 'Manual wins');
    assert.deepEqual(result.pending, {});
    assert.ok(result.database.deletedUrls.includes('https://example.invalid/deleted'));
    assert.ok(!result.database.posts.some(p => p.url === 'https://example.invalid/deleted'));
  });
  await check('unknown response, failed API and hung API finish as other/review without blocking import', async page => {
    const initial = await page.evaluate(() => {
      window.fetch = async (url, options) => {
        const { content } = JSON.parse(options.body);
        if (content.startsWith('unknown')) return Response.json({ ok: true, category_name: 'invented-shelf' });
        if (content.startsWith('failed')) throw new Error('Fixture API unavailable');
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Fixture timeout'))));
      };
      const start = performance.now();
      const result = c5.importFilePosts([make('unknown'), make('failed'), make('hung')]);
      return { result, elapsed: performance.now() - start };
    });
    assert.equal(initial.result.added, 3);
    assert.ok(initial.elapsed < 1000);
    await page.waitForFunction(() => c5.useLibrary.getState().posts.every(p => p.categoryMode === 'automatic'), null, { timeout: 6000 });
    const state = await page.evaluate(() => c5.useLibrary.getState());
    assert.ok(state.posts.every(p => p.categories[0] === 'other' && p.categoryReview === true));
    assert.equal(state.categories.length, 11);
  });
  await check('review retry keeps curation and successful category is not retried', async page => {
    const result = await page.evaluate(async () => {
      const original = make('retry');
      window.fetch = async () => Response.json({ ok: false }, { status: 503 });
      c5.importFilePosts([original]);
      await until(() => c5.useLibrary.getState().posts[0].categoryMode === 'automatic');
      c5.useLibrary.getState().updatePost('retry', { userNotes: 'Keep café', tags: ['MixedCase'], favorite: true, status: 'archived' });
      window.fetch = async () => { calls.push('retry'); return Response.json({ ok: true, category_name: 'technology' }); };
      c5.importFilePosts([original]);
      await until(() => c5.useLibrary.getState().posts[0].categories[0] === 'technology');
      const before = c5.useLibrary.getState().posts[0];
      c5.importFilePosts([original]);
      await new Promise(resolve => setTimeout(resolve, 0));
      return { before, after: c5.useLibrary.getState().posts[0], calls };
    });
    assert.deepEqual(persisted(result.before), persisted(result.after));
    assert.equal(result.calls.length, 1);
    assert.deepEqual(result.after.categories, ['technology']);
    assert.deepEqual(result.after.tags, ['MixedCase']);
    assert.equal(result.after.userNotes, 'Keep café');
    assert.equal(result.after.favorite, true);
    assert.equal(result.after.status, 'archived');
  });
  await check('fresh store and category recovery enforce 12 topical plus reserved, preserving existing lists', async page => {
    const result = await page.evaluate(() => {
      const store = c5.useLibrary.getState();
      const before = store.categories;
      for (let i = 0; i < 3; i++) store.addCategory('fixture-' + i);
      const rejected = store.addCategory('thirteenth');
      store.renameCategory('other', 'renamed-other');
      store.deleteCategory('uncategorized');
      const capped = c5.useLibrary.getState().categories;
      const incoming = Array.from({ length: 20 }, (_, i) => ({ id: 'recovered-' + i, name: 'recovered-' + i, order: i, color: 'red' }));
      return { before, rejected, capped, recovered: c5.appendBoundedShelves(before, incoming), oversize: c5.appendBoundedShelves([...before, ...incoming], [{ id: 'extra', name: 'extra' }]) };
    });
    assert.equal(result.before.length, 11);
    assert.equal(result.rejected, null);
    assert.equal(result.capped.length, 14);
    assert.ok(result.capped.some(c => c.name === 'other') && result.capped.some(c => c.name === 'uncategorized'));
    assert.equal(result.recovered.length, 14);
    assert.equal(result.oversize.length, 31);
  });
  await check('C4 in-flight save acknowledgment preserves and saves newer automatic then manual category writes', async page => {
    const result = await page.evaluate(async () => {
      let database = { posts: [], deletedUrls: [], legacyRows: [] };
      let release;
      let writes = 0;
      window.fetch = async (url, options = {}) => {
        if (url !== '/api/library') throw new Error('Unexpected API');
        if (options.method === 'POST') {
          const delta = JSON.parse(options.body);
          if (++writes === 1) await new Promise(resolve => { release = resolve; });
          database = { posts: delta.posts, deletedUrls: [], legacyRows: [] };
          return Response.json({ ok: true, ...database });
        }
        return Response.json(database);
      };
      c5.useLibrary.getState().importPosts([make('ack', { userNotes: 'Keep original note' })]);
      const saving = c5.syncLibrary();
      await until(() => typeof release === 'function');
      c5.useLibrary.getState().applyAutomaticCategory('ack', 'technology');
      c5.useLibrary.getState().updatePost('ack', { categories: ['other'], tags: ['MixedCase'] });
      release();
      const ok = await saving;
      return { ok, database, writes, state: c5.useLibrary.getState() };
    });
    assert.equal(result.ok, true);
    assert.equal(result.writes, 2);
    assert.deepEqual(result.database.posts, persisted(result.state.posts));
    assert.deepEqual(result.state.pending, {});
    assert.deepEqual(result.database.posts[0].categories, ['other']);
    assert.equal(result.database.posts[0].categoryMode, 'manual');
    assert.deepEqual(result.database.posts[0].tags, ['MixedCase']);
    assert.equal(result.database.posts[0].userNotes, 'Keep original note');
  });
} finally { await browser.close(); }
assert.deepEqual(failures, [], 'C5 state checks failed');
