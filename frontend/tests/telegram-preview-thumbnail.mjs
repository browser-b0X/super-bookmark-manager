import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { chromium } = createRequire(import.meta.url)(process.env.C5_PLAYWRIGHT_MODULE || 'playwright');
const bundle = await build({
  stdin: { contents: `
    export { parseTelegramExport } from './src/lib/telegram';
  `, resolveDir: fileURLToPath(new URL('../', import.meta.url)) },
  bundle: true, write: false, format: 'iife', globalName: 'b1p', define: { 'process.env.NODE_ENV': '"test"' },
});
const browser = await chromium.launch({ headless: true, channel: process.env.C5_BROWSER_CHANNEL || undefined });
const failures = [];

const wrap = messages => JSON.stringify({ type: 'saved_messages', messages });
const msg = patch => ({ id: 1, type: 'message', date: '2026-09-30T12:00:00', text: '', ...patch });

async function parse(page, messages) {
  return page.evaluate(raw => b1p.parseTelegramExport(raw), wrap(messages));
}

const context = await browser.newContext();
await context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>B1 preview synthetic</title>' }));
const page = await context.newPage();
try {
  await page.goto('http://b1-preview.invalid');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });

  try {
    const url = 'https://www.instagram.com/p/PreviewA/';
    const result = await parse(page, [msg({ text: 'caption ' + url, preview: { url, thumbnail: '/thumb/tg_abc' } })]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.posts.length, 1);
    assert.equal(result.posts[0].thumbnailUrl, '/thumb/tg_abc',
      'a preview the refresh already cached must reach the card; got ' + JSON.stringify(result.posts[0].thumbnailUrl));
    console.log('PASS a cached Telegram preview thumbnail reaches the imported card');
  } catch (error) { failures.push('preview reaches card'); console.error('FAIL a cached Telegram preview thumbnail reaches the imported card: ' + error.stack); }

  try {
    const result = await parse(page, [
      msg({ id: 2, text: 'see https://example.invalid/a', preview: { url: 'https://example.invalid/other', thumbnail: '/thumb/tg_other' } }),
      msg({ id: 3, text: 'see https://example.invalid/b', preview: { url: 'https://example.invalid/b', thumbnail: 42 } }),
      msg({ id: 4, text: 'see https://example.invalid/c', preview: 'nonsense' }),
      msg({ id: 5, text: 'see https://example.invalid/d' }),
    ]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.posts.length, 4);
    const byPath = path => result.posts.find(p => p.url.endsWith(path));
    assert.equal(byPath('/a').thumbnailUrl, undefined, 'a preview for a URL the message does not carry must not decorate it');
    assert.equal(byPath('/b').thumbnailUrl, undefined, 'a non-string thumbnail path must be ignored');
    assert.equal(byPath('/c').thumbnailUrl, undefined, 'a malformed preview object must be ignored');
    assert.equal(byPath('/d').thumbnailUrl, undefined, 'a message without a preview keeps the no-thumbnail default');
    console.log('PASS mismatched, malformed and absent previews are ignored');
  } catch (error) { failures.push('preview guards'); console.error('FAIL mismatched, malformed and absent previews are ignored: ' + error.stack); }
} finally {
  await context.close();
  await browser.close();
}

if (failures.length) {
  console.error('\n' + failures.length + ' failing: ' + failures.join(' | '));
  process.exit(1);
}
console.log('\nAll B1 preview-thumbnail import checks passed.');
