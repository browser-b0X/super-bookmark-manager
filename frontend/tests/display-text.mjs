import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';

const cases = [
  ['ampersand', 'Research &amp; Development', 'Research & Development'],
  ['quotes', 'It&#39;s useful &quot;today&quot;', 'It\'s useful "today"'],
  ['formatting', '<strong>Launch</strong> notes <a href="https://example.invalid/x">read</a>', 'Launch notes read'],
  ['whitespace', 'Line   one\n\n line two\ttab', 'Line one line two tab'],
  ['punctuation', 'Wait — really? Yes: 100% (see §2), "quoted" & \'single\'', 'Wait — really? Yes: 100% (see §2), "quoted" & \'single\''],
  ['Unicode', 'Café naïve · 日本語 · 🎉👩🏽‍🚀 · e\u0301 · ❤️ · \u200Fשלום', 'Café naïve · 日本語 · 🎉👩🏽‍🚀 · e\u0301 · ❤️ · \u200Fשלום'],
  ['inline entities', 'AT&amp;T', 'AT&T'],
  ['trim', '  padded  ', 'padded'],
  ['empty', '', ''], ['undefined', undefined, ''], ['null', null, ''],
  ['single decode', 'Research &amp;amp; Development', 'Research &amp; Development'],
  ['quoted attribute', '<a title="a > b" href="https://example.invalid">read</a>!', 'read!'],
  ['inline adjacency', 'in<b>put</b> <em>word</em>, next', 'input word, next'],
  ['nested', '<b>One <em>two</em></b><br/>three', 'One two three'],
  ['literal tag names', 'Use <code> and <div> tags; 2 < 3 > 1', 'Use <code> and <div> tags; 2 < 3 > 1'],
  ['escaped markup', '&lt;b&gt;literal&lt;/b&gt;', '<b>literal</b>'],
  ['unknown tag', '<strong-custom>literal</strong-custom>', '<strong-custom>literal</strong-custom>'],
  ['controls', '\uFEFFA\u0001B\u0081C\u0085D', 'ABC D'],
  ['encoded controls', 'A&#1;B &#x85;', 'AB …'],
  ['literal escapes', 'literal \\u2014 and \\n', 'literal \\u2014 and \\n'],
  ['markdown punctuation', '**stars** _words_ `code` [link](target) C#', '**stars** _words_ `code` [link](target) C#'],
  ['raw URL', 'https://example.invalid/?x=1&amp;y=2#f', 'https://example.invalid/?x=1&amp;y=2#f'],
  ['URL in prose', 'See  https://example.invalid/?x=%20&amp;y=2#f  now', 'See https://example.invalid/?x=%20&amp;y=2#f now'],
  ['inert hostile text', '</textarea><img src="https://example.invalid/probe" onerror="window.__executed=1"><script>window.__executed=2</script>', '</textarea><img src="https://example.invalid/probe" onerror="window.__executed=1"><script>window.__executed=2</script>'],
];
const bundle = await build({ stdin: { contents: 'export { displayText, displayTitle } from "./src/lib/displayText";', resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, write: false, format: 'iife', globalName: 'txt' });
const { chromium } = createRequire(import.meta.url)(process.env.TXT_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, channel: process.env.TXT_BROWSER_CHANNEL || undefined });
const errors = [], requests = [], results = [];
try {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  for (const [name, input, expected] of cases) {
    const actual = await page.evaluate(value => txt.displayText(value), input);
    try { assert.equal(actual, expected); results.push({ name, status: 'PASS' }); }
    catch { results.push({ name, status: 'FAIL', input, actual, expected }); }
  }
  const fallback = 'https://example.invalid/f?a=1&amp;b=2#f';
  for (const title of ['', '<b></b>', null, undefined]) {
    assert.equal(await page.evaluate(({ title, fallback }) => txt.displayTitle(title, fallback), { title, fallback }), fallback);
  }
  results.push({ name: 'exact URL fallbacks', status: 'PASS' });
  assert.equal(await page.evaluate(() => window.__executed), undefined);
  assert.equal(await page.locator('img, textarea').count(), 0);
  assert.deepEqual(errors, []); assert.deepEqual(requests, []);
  console.log(JSON.stringify(results, null, 2));
  assert.deepEqual(results.filter(r => r.status === 'FAIL'), []);
} finally {
  await browser.close();
  await mkdir(new URL('../../.verify/g4-c7-text-fix-20260921/', import.meta.url), { recursive: true });
  await writeFile(new URL('../../.verify/g4-c7-text-fix-20260921/display-text-results.json', import.meta.url), JSON.stringify({ results, errors, requests, browserClosed: !browser.isConnected() }, null, 2));
}
