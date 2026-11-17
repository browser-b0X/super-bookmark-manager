// Saved addresses lose their tracking parameters (owner, 2026-10-24, with the extension): utm_…, ad
// click ids, and share-button parameters on the sites that add them. Everything else stays as it was.
// Run from frontend/: node tests/tracking-test.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const out = await build({
  stdin: { contents: `export { withoutTracking } from './src/lib/platform';`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const { withoutTracking } = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));

const cases = [
  ['https://walks.example.invalid/ten?utm_source=news&id=7&UTM_Medium=mail&fbclid=abc#top', 'https://walks.example.invalid/ten?id=7#top'],
  ['https://shop.example.invalid/p?gclid=1&msclkid=2&mc_eid=3&_hsenc=4', 'https://shop.example.invalid/p'],
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=AbC&feature=share&t=42', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42'],
  ['https://youtu.be/dQw4w9WgXcQ?si=xyz', 'https://youtu.be/dQw4w9WgXcQ'],
  ['https://open.spotify.com/track/1?si=abc', 'https://open.spotify.com/track/1'],
  ['https://x.com/someone/status/123?s=20&t=abc', 'https://x.com/someone/status/123'],
  ['https://www.instagram.com/p/ABC/?igsh=xyz', 'https://www.instagram.com/p/ABC/'],
  // Parameters that mean something elsewhere stay; so does an address with nothing to remove, exactly.
  ['https://docs.example.invalid/page?si=5&s=2&t=9&feature=x', 'https://docs.example.invalid/page?si=5&s=2&t=9&feature=x'],
  ['https://example.invalid/a%20b?q=caf%C3%A9&utm_x', 'https://example.invalid/a%20b?q=caf%C3%A9'],
  ['https://example.invalid/?%E0%A4%A=1', 'https://example.invalid/?%E0%A4%A=1'],
  ['not a url', 'not a url'],
];
for (const [input, expected] of cases) assert.equal(withoutTracking(input), expected, input);
console.log(`PASS ${cases.length} addresses`);
console.log('ALL PASS');
