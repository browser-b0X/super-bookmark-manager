import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { chromium } = createRequire(import.meta.url)(process.env.C5_PLAYWRIGHT_MODULE || 'playwright');
const bundle = await build({
  stdin: { contents: `
    export { useLibrary } from './src/store/library';
    export { postFromUrl } from './src/lib/providers';
    export { enrichSavedPost } from './src/lib/metadataEnrichment';
    export { syncLibrary } from './src/lib/libraryPersistence';
  `, resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, write: false, format: 'iife', globalName: 'f10', define: { 'process.env.NODE_ENV': '"test"' },
});
const browser = await chromium.launch({ headless: true, channel: process.env.C5_BROWSER_CHANNEL || undefined });
const failures = [];

async function check(name, failure, run) {
  const context = await browser.newContext();
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>F10 synthetic enrichment state</title>' }));
  const page = await context.newPage();
  try {
    await page.goto('http://f10-state.invalid');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(failure => {
      window.calls = [];
      window.until = async predicate => {
        const deadline = performance.now() + 3000;
        while (!predicate()) {
          if (performance.now() > deadline) throw new Error('Fixture condition did not settle');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      };
      let database = { posts: [], deletedUrls: [], legacyRows: [] };
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
        if (url !== '/api/enrich') throw new Error('Unexpected API ' + url);
        calls.push(JSON.parse(options.body));
        if (failure === 'transport') throw new TypeError('Failed to fetch');
        // Mirrors app.py's /api/enrich failure response: ok:false plus the
        // safe_http error code, served at the mapped non-2xx status.
        return Response.json(
          { ok: false, title: '', summary: '', thumbnail: '', status: 'failed', error: failure.error },
          { status: failure.status });
      };
      // Run enrichment against a post already in the store, exactly as the
      // import worker does after classification.
      window.enrichOne = async url => {
        const post = f10.postFromUrl(url, 'telegram');
        f10.useLibrary.getState().importPosts([post]);
        await f10.syncLibrary();
        await f10.enrichSavedPost(post.id);
        await f10.syncLibrary();
        const stored = f10.useLibrary.getState().posts.find(p => p.id === post.id);
        return { calls, status: stored.metadataStatus, error: stored.metadataError, title: stored.title };
      };
    }, failure);
    await run(page);
    console.log('PASS ' + name);
  } catch (error) { failures.push(name); console.error('FAIL ' + name + ': ' + error.stack); }
  finally { await context.close(); }
}

try {
  await check('a deterministic oversize rejection does not promise a retry', { status: 502, error: 'too_large' }, async page => {
    const result = await page.evaluate(() => enrichOne('https://www.instagram.com/p/AbC123XyZ/'));
    assert.equal(result.calls.length, 1);
    assert.equal(result.status, 'failed');
    assert.ok(result.error, 'the failure must carry a readable state');
    assert.ok(!/retry/i.test(result.error),
      'an oversize document will fail identically on every attempt; the message was: ' + JSON.stringify(result.error));
    assert.ok(!/unavailable/i.test(result.error),
      'the generic transport wording must not be reused for a deterministic rejection; got: ' + JSON.stringify(result.error));
  });

  await check('a target site error status still invites a retry', { status: 502, error: 'http_error' }, async page => {
    const result = await page.evaluate(() => enrichOne('https://example.invalid/flaky'));
    assert.equal(result.status, 'failed');
    assert.match(result.error, /retry later/,
      'a site 5xx can clear on a later attempt (metadata_e2e_fixture.py recovers /failure); got: ' + JSON.stringify(result.error));
  });

  await check('an unrecognized backend error keeps the accepted wording', { status: 503, error: 'Synthetic metadata unavailable' }, async page => {
    const result = await page.evaluate(() => enrichOne('https://example.invalid/disposable'));
    assert.equal(result.error, 'Metadata unavailable. The saved link is unchanged; retry later.',
      'the core-acceptance and metadata-e2e contract pins this exact string for a non-code error');
  });

  await check('a transient timeout still invites a retry', { status: 504, error: 'timeout' }, async page => {
    const result = await page.evaluate(() => enrichOne('https://example.invalid/slow'));
    assert.equal(result.status, 'failed');
    assert.match(result.error, /retry later/,
      'a timeout is genuinely transient; the message was: ' + JSON.stringify(result.error));
  });

  await check('a transport failure still invites a retry', 'transport', async page => {
    const result = await page.evaluate(() => enrichOne('https://example.invalid/down'));
    assert.equal(result.status, 'failed');
    assert.match(result.error, /retry later/,
      'the message was: ' + JSON.stringify(result.error));
  });
} finally {
  await browser.close();
}

if (failures.length) {
  console.error('\n' + failures.length + ' failing: ' + failures.join(' | '));
  process.exit(1);
}
console.log('\nAll F10 enrichment-failure wording checks passed.');
