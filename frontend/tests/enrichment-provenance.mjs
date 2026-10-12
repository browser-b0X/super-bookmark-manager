// Audit phase 3: preview provenance, retry policy, rich fields, queue progress.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const bundle = await build({
  stdin: { contents: `
    export { useLibrary } from './src/store/library';
    export { postFromUrl } from './src/lib/providers';
    export { enrichSavedPost, enrichMany, useEnrichmentQueue, needsEnrichment, metadataPatch } from './src/lib/metadataEnrichment';
    export { bookmarkPost } from './src/lib/bookmarks';
  `, resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, write: false, format: 'iife', globalName: 'e', define: { 'process.env.NODE_ENV': '"test"' },
});
const browser = await chromium.launch({ headless: true, channel: process.env.C4_BROWSER_CHANNEL || undefined });
const failures = [];
async function check(name, run) {
  const context = await browser.newContext();
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>enrich</title>' }));
  const page = await context.newPage();
  try {
    await page.goto('http://enrich.invalid/');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => {
      window.answer = { ok: true, title: 'Fetched title', summary: 'Fetched summary', thumbnail: '/thumb/img_abc', status: 'ok', error: '',
        siteName: 'Fixture Site', author: 'Ada', readingMinutes: 6, wordCount: 1400, faviconUrl: '/thumb/ico_abc', lang: 'en' };
      window.calls = [];
      window.fetch = async (url, options = {}) => {
        if (url === '/api/enrich') {
          calls.push(JSON.parse(options.body).url);
          const a = window.answer;
          return Response.json(a, { status: a.ok ? 200 : a.error === 'busy' ? 429 : 400, headers: a.error === 'busy' ? { 'Retry-After': '5' } : {} });
        }
        return Response.json({ ok: true, posts: [], deletedUrls: [], legacyRows: [] });
      };
    });
    await run(page); console.log('PASS ' + name);
  } catch (error) { failures.push(name); console.error('FAIL ' + name + ': ' + error.message); }
  finally { await context.close(); }
}
try {
  await check('derived titles are replaced; file titles and owner edits never are', async page => {
    const r = await page.evaluate(async () => {
      const manual = e.postFromUrl('https://a.invalid/some-slug');
      const file = e.bookmarkPost('https://b.invalid/x', 'My bookmark name', undefined, []);
      const edited = { ...e.postFromUrl('https://c.invalid/y'), title: 'Owner wording', fieldSources: { title: 'user' } };
      e.useLibrary.setState({ posts: [manual, file, edited], demo: false });
      await e.enrichMany([manual.id, file.id, edited.id], { force: true });
      return e.useLibrary.getState().posts.map(p => [p.title, p.fieldSources?.title, p.description, p.thumbnailUrl, p.siteName, p.readingMinutes, p.faviconUrl, p.metadataStatus]);
    });
    assert.deepEqual(r[0], ['Fetched title', 'fetched', 'Fetched summary', '/thumb/img_abc', 'Fixture Site', 6, '/thumb/ico_abc', 'enriched']);
    assert.equal(r[1][0], 'My bookmark name'); assert.equal(r[1][1], 'file'); assert.equal(r[1][2], 'Fetched summary');
    assert.equal(r[2][0], 'Owner wording'); assert.equal(r[2][1], 'user');
  });
  await check('refresh updates previously fetched values', async page => {
    const r = await page.evaluate(async () => {
      const post = { ...e.postFromUrl('https://d.invalid/z'), title: 'Old fetched', description: 'Old', fieldSources: { title: 'fetched', description: 'fetched' }, metadataStatus: 'enriched' };
      e.useLibrary.setState({ posts: [post], demo: false });
      await e.enrichSavedPost(post.id, { force: true });
      return e.useLibrary.getState().posts[0];
    });
    assert.equal(r.title, 'Fetched title'); assert.equal(r.description, 'Fetched summary');
  });
  await check('busy backs off and retries later; deterministic failures stop', async page => {
    const r = await page.evaluate(async () => {
      answer = { ok: false, error: 'busy', status: 'failed', title: '', summary: '', thumbnail: '' };
      const busy = e.postFromUrl('https://busy.invalid/'), bad = e.postFromUrl('https://bad.invalid/'), site = e.postFromUrl('https://site.invalid/');
      e.useLibrary.setState({ posts: [busy, bad, site], demo: false });
      await e.enrichSavedPost(busy.id);
      answer = { ok: false, error: 'invalid_url', status: 'failed', title: '', summary: '', thumbnail: '' };
      await e.enrichSavedPost(bad.id);
      answer = { ok: false, error: 'http_error', status: 'failed', title: '', summary: '', thumbnail: '' };
      await e.enrichSavedPost(site.id);
      const [a, b, c] = e.useLibrary.getState().posts;
      const now = Date.now();
      return { a, b, c, dueNow: [a, b, c].map(p => e.needsEnrichment(p, now)), dueLater: e.needsEnrichment(a, now + 60_000) };
    });
    assert.equal(r.a.metadataStatus, 'failed'); assert.equal(r.a.metadataAttempts, 1); assert.ok(r.a.metadataRetryAt);
    assert.equal(r.b.metadataRetryAt, undefined); assert.match(r.b.metadataError, /could not be read/);
    assert.equal(r.c.metadataRetryAt, undefined, 'site errors wait for the owner');
    assert.deepEqual(r.dueNow, [false, false, false]); assert.equal(r.dueLater, true);
  });
  await check('a site without preview data is "none", not a failure', async page => {
    const r = await page.evaluate(async () => {
      answer = { ok: true, title: '', summary: '', thumbnail: '', status: 'empty', error: '' };
      const post = e.postFromUrl('https://plain.invalid/');
      e.useLibrary.setState({ posts: [post], demo: false });
      await e.enrichSavedPost(post.id);
      return e.useLibrary.getState().posts[0].metadataStatus;
    });
    assert.equal(r, 'none');
  });
  await check('queue reports progress and resets when done', async page => {
    const r = await page.evaluate(async () => {
      const posts = Array.from({ length: 5 }, (_, i) => e.postFromUrl('https://q.invalid/' + i));
      e.useLibrary.setState({ posts, demo: false });
      const seen = [];
      const stop = e.useEnrichmentQueue.subscribe(s => seen.push([s.total, s.done]));
      await e.enrichMany(posts.map(p => p.id));
      stop();
      return { seen, final: e.useEnrichmentQueue.getState() };
    });
    assert.ok(r.seen.some(([total]) => total === 5));
    assert.deepEqual([r.final.total, r.final.done, r.final.running], [0, 0, 0]);
  });
} finally { await browser.close(); }
if (failures.length) throw new Error('enrichment provenance failures: ' + failures.join(', '));
console.log('PASS enrichment provenance/retry/progress');
