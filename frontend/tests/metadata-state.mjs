import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { chromium } = createRequire(import.meta.url)(process.env.C6_PLAYWRIGHT_MODULE);
const bundle = await build({
  stdin: { contents: `
    export { useLibrary } from './src/store/library';
    export { importFilePosts } from './src/lib/importCategorization';
    export { parseTelegramExport } from './src/lib/telegram';
    export { parseBookmarkHtml } from './src/lib/bookmarks';
    export { parseChromiumBookmarks } from './src/lib/chromiumBookmarks';
    export { syncLibrary } from './src/lib/libraryPersistence';
  `, resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, write: false, format: 'iife', globalName: 'm', define: { 'process.env.NODE_ENV': '"test"' },
});
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const failures = [];
async function check(name, run) {
  const context = await browser.newContext();
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic metadata state</title>' }));
  const page = await context.newPage();
  try {
    await page.goto('http://metadata-state.invalid');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => {
      window.db = { posts: [], deletedUrls: [], legacyRows: [] };
      window.events = []; window.categoryFailure = false; window.metadataFailure = false; window.failSave = false;
      window.holdMetadata = false; window.releases = []; window.concurrent = 0; window.maxConcurrent = 0;
      window.until = async test => { const deadline = performance.now() + 2500; while (!test()) {
        if (performance.now() > deadline) throw new Error('State did not settle: ' + test);
        await new Promise(resolve => setTimeout(resolve, 5));
      } };
      window.make = (path, options = {}) => ({ ...m.parseTelegramExport(JSON.stringify({ messages: [{ type: 'message', id: 1,
        text: 'https://fixture.example/' + path, date: '2026-09-24T00:00:00Z' }] })).posts[0], ...options });
      window.fetch = async (url, options = {}) => {
        const data = options.body ? JSON.parse(options.body) : {};
        if (url === '/api/library') {
          if (options.method === 'POST') {
            if (failSave) return Response.json({ error: 'Fixture failed save' }, { status: 503 });
            for (const p of data.posts) {
              db.posts = [...db.posts.filter(q => q.url !== p.url), p]; events.push(['persist', p.url]);
            }
            db.deletedUrls.push(...data.deletedUrls); db.posts = db.posts.filter(p => !db.deletedUrls.includes(p.url));
          }
          return Response.json({ ok: true, ...db });
        }
        if (url === '/api/categorize') {
          events.push(['categorize', data.content]);
          return Response.json({ ok: !categoryFailure, category_name: 'technology' }, { status: categoryFailure ? 403 : 200 });
        }
        if (url === '/api/enrich') {
          events.push(['enrich', data.url, db.posts.some(p => p.url === data.url)]);
          concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
          if (holdMetadata) await new Promise(resolve => releases.push(resolve));
          concurrent--;
          return Response.json(metadataFailure ? { ok: false, error: 'Fixture metadata unavailable' } :
            window.metadataPartial ? { ok: true, title: 'OG partial title', summary: 'Partial description', thumbnail: '', status: 'partial', error: 'blocked_url' } :
            { ok: true, title: 'OG fixture title', summary: 'OG fixture description', thumbnail: 'https://images.example/fixture.png', status: 'ok', error: '' },
            { status: metadataFailure ? 403 : 200 });
        }
        throw new Error('Unexpected fixture request ' + url);
      };
    });
    await run(page); console.log('PASS ' + name);
  } catch (error) { failures.push(name); console.error('FAIL ' + name + ': ' + error.stack); }
  finally { await context.close(); }
}
try {
  await check('durable before categorization before new-only metadata; import immediately returns', async page => {
    const r = await page.evaluate(async () => {
      holdMetadata = true;
      const post = make('new-link'), started = performance.now();
      const result = m.importFilePosts([post]); const elapsed = performance.now() - started;
      await until(() => releases.length === 1);
      const before = structuredClone(db.posts); releases.shift()();
      await until(() => m.useLibrary.getState().posts[0].metadataStatus === 'enriched');
      await m.syncLibrary();
      const enriched = structuredClone(m.useLibrary.getState().posts[0]);
      m.importFilePosts([post, post]); await m.syncLibrary();
      return { result, elapsed, events, before, enriched, posts: db.posts };
    });
    assert.equal(r.result.added, 1); assert.ok(r.elapsed < 500); assert.equal(r.before.length, 1);
    assert.ok(!r.before[0].thumbnailUrl); assert.equal(r.enriched.title, 'OG fixture title');
    assert.equal(r.enriched.description, 'OG fixture description'); assert.equal(r.enriched.thumbnailUrl, 'https://images.example/fixture.png');
    assert.equal(r.events.filter(e => e[0] === 'enrich').length, 1);
    assert.ok(r.events.findIndex(e => e[0] === 'persist') < r.events.findIndex(e => e[0] === 'categorize'));
    assert.ok(r.events.findIndex(e => e[0] === 'categorize') < r.events.findIndex(e => e[0] === 'enrich'));
    assert.equal(r.events.find(e => e[0] === 'enrich')[2], true); assert.equal(r.posts.length, 1);
  });
  await check('in-flight metadata preserves all curation, manual other, meaningful title, source text, views and deletion', async page => {
    const r = await page.evaluate(async () => {
      holdMetadata = true;
      const p = make('preserve'), gone = make('delete'); m.importFilePosts([p, gone]);
      await until(() => releases.length === 2);
      const store = m.useLibrary.getState();
      store.updatePost(p.id, { title: 'Human title', description: 'Human description', thumbnailUrl: '/thumb/human',
        categories: ['other'], userNotes: 'Private synthetic note', tags: ['MiXeD'], favorite: true, status: 'archived' });
      store.saveView('Synthetic view', { query: 'Human' }); store.deletePosts([gone.id]);
      const before = JSON.parse(JSON.stringify(m.useLibrary.getState()));
      releases.splice(0).forEach(fn => fn());
      await until(() => m.useLibrary.getState().posts[0].metadataStatus === 'enriched'); await m.syncLibrary();
      return { before: { posts: before.posts, views: before.views, deletedUrls: before.deletedUrls },
        after: m.useLibrary.getState(), db };
    });
    for (const key of Object.keys(r.before.posts[0]).filter(k => !['metadataStatus','metadataError','updatedAt'].includes(k)))
      assert.deepEqual(r.after.posts[0][key], r.before.posts[0][key], key);
    assert.deepEqual(r.after.views, r.before.views); assert.deepEqual(r.after.deletedUrls, r.before.deletedUrls);
    assert.equal(r.after.posts.length, 1); assert.equal(r.db.posts.length, 1);
  });
  await check('metadata and categorization fail independently, both failures durable', async page => {
    for (const [categoryFailure, metadataFailure] of [[true,false],[false,true],[true,true]]) {
      const r = await page.evaluate(async flags => {
        [window.categoryFailure, window.metadataFailure] = flags;
        const p = make('independent-' + flags.join('-')); m.importFilePosts([p]);
        await until(() => ['enriched','failed'].includes(m.useLibrary.getState().posts.find(q => q.id === p.id).metadataStatus));
        await m.syncLibrary(); return db.posts.find(q => q.id === p.id);
      }, [categoryFailure, metadataFailure]);
      assert.equal(r.categories[0], categoryFailure ? 'other' : 'technology');
      assert.equal(r.metadataStatus, metadataFailure ? 'failed' : 'enriched');
      assert.equal(!!r.thumbnailUrl, !metadataFailure);
    }
  });
  await check('partial metadata retains valid text and visible retryable failure', async page => {
    const r = await page.evaluate(async () => {
      window.metadataPartial = true; const p = make('partial'); m.importFilePosts([p]);
      await until(() => m.useLibrary.getState().posts[0].description === 'Partial description');
      await m.syncLibrary(); return db.posts[0];
    });
    assert.equal(r.title, 'OG partial title'); assert.equal(r.metadataStatus, 'partial');
    assert.match(r.metadataError, /unavailable.*retry/i); assert.ok(!r.thumbnailUrl);
  });
  await check('failed durability prevents metadata; explicit save retry resumes without startup sweep', async page => {
    const r = await page.evaluate(async () => {
      failSave = true; const p = make('save-retry'); m.importFilePosts([p]);
      await m.syncLibrary(); const blocked = events.filter(e => e[0] === 'enrich').length;
      failSave = false; await m.syncLibrary();
      await until(() => m.useLibrary.getState().posts[0].metadataStatus === 'enriched');
      return { blocked, events };
    });
    assert.equal(r.blocked, 0); assert.ok(r.events.filter(e => e[0] === 'enrich').every(e => e[2]));
  });
  await check('three-worker bound, duplicate imports coalesce, existing meaningful imported title retained', async page => {
    const r = await page.evaluate(async () => {
      holdMetadata = true; const posts = Array.from({ length: 8 }, (_, i) => make('worker-' + i, { title: 'Imported meaningful ' + i }));
      m.importFilePosts(posts); m.importFilePosts(posts);
      await until(() => releases.length === 3); const initial = events.filter(e => e[0] === 'enrich').length;
      holdMetadata = false; releases.splice(0).forEach(fn => fn());
      await until(() => m.useLibrary.getState().posts.every(p => p.metadataStatus === 'enriched'));
      return { initial, maxConcurrent, events, posts: m.useLibrary.getState().posts };
    });
    assert.equal(r.initial, 3); assert.equal(r.maxConcurrent, 3); assert.equal(r.events.filter(e => e[0] === 'enrich').length, 8);
    assert.ok(r.posts.every(p => p.title.startsWith('Imported meaningful ')));
  });
} finally { await browser.close(); }
assert.deepEqual(failures, [], 'metadata state failures');
