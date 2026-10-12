// "Share a shelf" template: escaping, what goes in, and the page's own policy.
// Pure function test: bundles src/lib/sharePage.ts with esbuild and runs it in Node.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const entry = fileURLToPath(new URL('../src/lib/sharePage.ts', import.meta.url));
const { outputFiles } = await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', write: false, platform: 'neutral' });
const mod = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));

const hostile = '<script>alert(1)</script>"\'&';
const post = (n, changes = {}) => ({
  id: `p${n}`, url: `https://example.org/${n}`, source: 'manual', platform: 'web', domain: 'example.org', status: 'to-review',
  title: `Link ${n}`, description: 'A description', categories: [], tags: ['one'], projectIds: [], createdAt: `2026-10-0${n}T10:00:00Z`,
  updatedAt: '2026-10-08T10:00:00Z', metadataStatus: 'none', ...changes,
});
const items = [
  { post: post(1, { title: hostile, tags: [hostile], description: hostile, userNotes: 'secret note', favorite: true,
                    telegramMessage: { text: 'private message' } }), picture: 'data:image/jpeg;base64,AAAA' },
  { post: post(2, { url: 'javascript:alert(1)' }), picture: 'https://tracker.invalid/p.png' },
  { post: post(3, { url: 'data:text/html,<b>x</b>' }), picture: 'data:image/svg+xml;base64,PHN2Zz4=' },
];
const none = { notes: false, status: false, favorites: false, telegram: false };
const options = { title: `Shelf ${hostile}`, intro: hostile, date: new Date('2026-10-08T12:00:00Z'), include: none };
let failures = 0;
const check = async (name, run) => { try { await run(); console.log('PASS', name); } catch (e) { failures++; console.error('FAIL', name, e.message); } };

await check('every value is escaped', async () => {
  const html = await mod.renderSharePage(items, options);
  const body = html.split('<body>')[1].split('<script>')[0];
  assert.ok(!body.includes('<script>alert'), 'no live script from data');
  assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;'));
  assert.ok(html.includes('<title>Shelf &lt;script&gt;'));
});
await check('only http(s) links; only inline raster pictures', async () => {
  const html = await mod.renderSharePage(items, options);
  assert.ok(!html.includes('javascript:') && !html.includes('data:text/html'));
  assert.ok(!html.includes('tracker.invalid') && !html.includes('image/svg+xml'));
  assert.equal((html.match(/<img /g) || []).length, 1);
  const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map(m => m[1]);
  assert.ok(hrefs.every(h => /^https:\/\//.test(h)), hrefs.join(' '));
});
await check('notes, status, favourites and Telegram text only when ticked', async () => {
  const plain = await mod.renderSharePage(items, options);
  for (const word of ['secret note', 'private message', 'To review', 'Favourite']) assert.ok(!plain.includes(word), word);
  const all = await mod.renderSharePage(items, { ...options, include: { notes: true, status: true, favorites: true, telegram: true } });
  for (const word of ['secret note', 'private message', 'To review', 'Favourite']) assert.ok(all.includes(word), word);
  const notesOnly = await mod.renderSharePage(items, { ...options, include: { ...none, notes: true } });
  assert.ok(notesOnly.includes('secret note') && !notesOnly.includes('private message'));
});
await check('the page allows no network and only its own script', async () => {
  const html = await mod.renderSharePage(items, options);
  const policy = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const hash = createHash('sha256').update(script).digest('base64');
  assert.equal(policy, `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'`);
  assert.equal((html.match(/<script/g) || []).length, 1);
});
await check('file name', async () => {
  assert.equal(mod.fileName('Food & drink', new Date('2026-10-08T12:00:00Z')), 'food-drink-2026-10-08.html');
  assert.equal(mod.fileName('../../ etc', new Date('2026-10-08T12:00:00Z')), 'etc-2026-10-08.html');
  assert.equal(mod.fileName('***', new Date('2026-10-08T12:00:00Z')), 'shelf-2026-10-08.html');
});
console.log(failures ? `FAILED ${failures}` : 'ALL PASS');
process.exit(failures ? 1 : 0);
