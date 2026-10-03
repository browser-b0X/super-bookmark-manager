import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { chromium } = createRequire(import.meta.url)(process.env.C5_PLAYWRIGHT_MODULE || 'playwright');
const bundle = await build({
  stdin: { contents: `
    export { useLibrary } from './src/store/library';
    export { postFromUrl } from './src/lib/providers';
    export { titleFromUrl } from './src/lib/platform';
    export { importFilePosts } from './src/lib/importCategorization';
    export { syncLibrary } from './src/lib/libraryPersistence';
  `, resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, write: false, format: 'iife', globalName: 'f7', define: { 'process.env.NODE_ENV': '"test"' },
});
const browser = await chromium.launch({ headless: true, channel: process.env.C5_BROWSER_CHANNEL || undefined });
const failures = [];

async function check(name, run) {
  const context = await browser.newContext();
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>F7 synthetic caption state</title>' }));
  const page = await context.newPage();
  try {
    await page.goto('http://f7-state.invalid');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => {
      window.calls = [];
      window.until = async predicate => {
        const deadline = performance.now() + 1500;
        while (!predicate()) {
          if (performance.now() > deadline) throw new Error('Fixture condition did not settle');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      };
      // A saved-message post exactly as frontend/src/lib/telegram.ts builds it:
      // a tg-json- id, the caption in excerpt, and no thumbnail of its own.
      window.telegramPost = (url, caption, overrides = {}) => ({
        ...f7.postFromUrl(url, 'telegram'),
        id: 'tg-json-' + btoa(url).replace(/=+$/, ''),
        excerpt: caption,
        thumbnailUrl: undefined,
        telegramMessage: { id: '9001', text: caption },
        ...overrides,
      });
      let database = { posts: [], deletedUrls: [], legacyRows: [] };
      window.fixtureDatabase = () => JSON.parse(JSON.stringify(database));
      window.fetch = async (url, options = {}) => {
        if (url === '/api/library') {
          if (options.method === 'POST') {
            const delta = JSON.parse(options.body);
            const posts = new Map(database.posts.map(post => [post.url, post]));
            for (const post of delta.posts) posts.set(post.url, post);
            for (const removed of delta.deletedUrls) posts.delete(removed);
            database = { posts: [...posts.values()], deletedUrls: [...new Set([...database.deletedUrls, ...delta.deletedUrls])], legacyRows: [] };
          }
          return Response.json({ ok: true, ...database });
        }
        if (url === '/api/enrich') return Response.json({ ok: false }, { status: 503 });
        if (url !== '/api/categorize') throw new Error('Unexpected API ' + url);
        const data = JSON.parse(options.body);
        if (data.keywords_only !== true) throw new Error('Provider use forbidden');
        calls.push(data);
        // Mirrors the shipped keyword tier: it can only see the text it is given.
        const text = data.content.toLowerCase();
        const category = text.includes('sourdough') ? 'food-drink'
          : text.includes('microservice') ? 'technology' : 'other';
        return Response.json({ ok: true, category_name: category });
      };
    });
    await run(page);
    console.log('PASS ' + name);
  } catch (error) { failures.push(name); console.error('FAIL ' + name + ': ' + error.stack); }
  finally { await context.close(); }
}

try {
  await check('an opaque saved link is categorized from its Telegram caption', async page => {
    const result = await page.evaluate(async () => {
      const caption = 'Amazing sourdough recipe with a long fermentation for the weekend.';
      const post = telegramPost('https://www.instagram.com/p/AbC123XyZ/', caption);
      f7.importFilePosts([post]);
      await until(() => c5Settled());
      function c5Settled() {
        const current = f7.useLibrary.getState().posts.find(p => p.id === post.id);
        return current && current.categoryMode === 'automatic';
      }
      await f7.syncLibrary();
      const stored = f7.useLibrary.getState().posts.find(p => p.id === post.id);
      return { calls, categories: stored.categories, review: stored.categoryReview,
        urlDerivedTitle: stored.title === f7.titleFromUrl(stored.canonicalUrl || stored.url) };
    });
    assert.equal(result.calls.length, 1, 'the imported link must be classified once');
    assert.ok(result.urlDerivedTitle, 'precondition: the only title is derived from the URL slug');
    assert.ok(result.calls[0].content.includes('sourdough'),
      'the saved caption must reach the classifier; sent content was: ' + JSON.stringify(result.calls[0].content));
    assert.deepEqual(result.categories, ['food-drink']);
    assert.equal(result.review, false);
  });

  await check('a real supplied title still wins and a multi-link caption does not leak in', async page => {
    const result = await page.evaluate(async () => {
      // One caption, two links: the caption describes the other link, so it must
      // not be allowed to reclassify a post that already has a genuine title.
      const caption = 'Also see our microservice deployment writeup.';
      const post = telegramPost('https://example.invalid/AbC123XyZ', caption, { title: 'Sourdough Guide' });
      f7.importFilePosts([post]);
      await until(() => {
        const current = f7.useLibrary.getState().posts.find(p => p.id === post.id);
        return current && current.categoryMode === 'automatic';
      });
      await f7.syncLibrary();
      const stored = f7.useLibrary.getState().posts.find(p => p.id === post.id);
      return { calls, categories: stored.categories, title: stored.title };
    });
    assert.equal(result.calls.length, 1);
    assert.equal(result.title, 'Sourdough Guide');
    assert.ok(!result.calls[0].content.includes('microservice'),
      'a caption belonging to another link must not be classified against this one');
    assert.deepEqual(result.categories, ['food-drink']);
  });
} finally {
  await browser.close();
}

if (failures.length) {
  console.error('\n' + failures.length + ' failing: ' + failures.join(' | '));
  process.exit(1);
}
console.log('\nAll F7 caption-categorization checks passed.');
