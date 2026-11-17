// What the Save window accepts from the browser extension (src/lib/pagePosts.ts, v0.4.0 phase 3): one
// address per post, the same spelling the extension's readers.js uses; capped text; https pictures; at
// most 50 posts; anything else dropped. Run from frontend/: node tests/page-posts-test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

const out = await build({
  stdin: { contents: `export * from './src/lib/pagePosts';`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const lib = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
// The extension's readers, as the browser would load them (only their address spelling is used here).
const sandbox = { URL, location: { href: 'https://example.invalid/', hostname: 'example.invalid', pathname: '/' } };
sandbox.globalThis = sandbox;
vm.runInNewContext(await readFile(fileURLToPath(new URL('../../extension/readers.js', import.meta.url)), 'utf8'), sandbox);
const readers = sandbox.sbmReaders;

let count = 0;
const addresses = [
  ['https://x.com/maraquinn/status/1849000000000000001?s=20', 'https://x.com/maraquinn/status/1849000000000000001', 'x:1849000000000000001'],
  ['https://twitter.com/MaraQuinn/status/1849000000000000001/photo/1', 'https://x.com/MaraQuinn/status/1849000000000000001', 'x:1849000000000000001'],
  ['https://mobile.x.com/someone/statuses/42', 'https://x.com/someone/status/42', 'x:42'],
  ['https://www.instagram.com/fieldnotes_ana/p/CgridOne1/', 'https://www.instagram.com/p/CgridOne1/', 'ig:CgridOne1'],
  ['https://instagram.com/reels/CreelTwo2/?igsh=abc', 'https://www.instagram.com/reel/CreelTwo2/', 'ig:CreelTwo2'],
  ['https://www.instagram.com/tv/CtvThree3', 'https://www.instagram.com/tv/CtvThree3/', 'ig:CtvThree3'],
  ['https://www.tiktok.com/@juniperbakes/video/7430000000000000001?is_from_webapp=1', 'https://www.tiktok.com/@juniperbakes/video/7430000000000000001', 'tt:7430000000000000001'],
  ['https://m.tiktok.com/@juniper.bakes/photo/7430000000000000002', 'https://www.tiktok.com/@juniper.bakes/photo/7430000000000000002', 'tt:7430000000000000002'],
];
for (const [raw, url, key] of addresses) {
  assert.deepEqual(lib.postAddress(raw), { url, key, site: key.startsWith('x:') ? 'x' : key.startsWith('ig:') ? 'instagram' : 'tiktok' }, raw);
  const theirs = readers.postAddress(raw);
  assert.deepEqual([theirs.url, theirs.key, theirs.site], [url, key, lib.postAddress(raw).site], `readers.js spells ${raw} the same way`);
  count++;
}
for (const raw of ['http://x.com/a/status/1', 'https://x.com/home', 'https://x.com/a/likes', 'https://evil.invalid/a/status/1', 'https://x.com.evil.invalid/a/status/1',
  'https://www.instagram.com/fieldnotes_ana/', 'https://www.instagram.com/explore/', 'https://www.tiktok.com/@juniperbakes', 'javascript:alert(1)', 'not a url',
  // A reel's audio page and a profile's reels tab (2026-11-08: the audio link beside a reel had a Download button).
  'https://www.instagram.com/reels/audio/1234567890123/', 'https://www.instagram.com/fieldnotes_ana/reels/']) {
  assert.equal(lib.postAddress(raw), null, raw);
  assert.equal(readers.postAddress(raw), null, `readers.js: ${raw}`);
  count++;
}
console.log(`PASS ${count} addresses, the Save window and the extension agree`);

// The hand-over: checked field by field; bad posts dropped; one per post; at most 50.
const good = { url: 'https://x.com/maraquinn/status/1849000000000000001', author: 'Mara Quinn', handle: '@maraquinn', text: '  Day 3\nFeeding  ',
  takenAt: '2026-10-24T08:00:00.000Z', pictures: ['https://pbs.twimg.com/media/A?name=small', 'http://pbs.twimg.com/media/B', 'javascript:alert(1)', 7, 'https://pbs.twimg.com/media/A?name=small'], video: 'yes' };
const read = lib.readPagePosts({ type: 'sbm-posts', single: null, posts: [good, { url: 'https://evil.invalid/x' }, { ...good, text: 'the same post again' }, 'junk', null,
  { url: 'https://www.instagram.com/p/CgridOne1/', author: 'x'.repeat(500), text: 'y'.repeat(6000), pictures: 'not a list', video: true }] });
assert.equal(read.single, null);
assert.equal(read.posts.length, 2);
assert.deepEqual(read.posts[0], { url: 'https://x.com/maraquinn/status/1849000000000000001', key: 'x:1849000000000000001', site: 'x', author: 'Mara Quinn',
  handle: 'maraquinn', text: 'Day 3\nFeeding', takenAt: '2026-10-24T08:00:00.000Z', pictures: ['https://pbs.twimg.com/media/A?name=small'], video: false });
assert.deepEqual([read.posts[1].author.length, read.posts[1].text.length, read.posts[1].pictures, read.posts[1].video], [200, 5000, [], true]);
const many = lib.readPagePosts({ posts: Array.from({ length: 80 }, (_, i) => ({ url: `https://x.com/a/status/${1000 + i}` })) });
assert.equal(many.posts.length, 50);
assert.equal(lib.readPagePosts({ posts: [{ url: 'https://evil.invalid/' }] }), null, 'nothing usable: nothing accepted');
assert.equal(lib.readPagePosts('sbm-posts'), null);
assert.equal(lib.readPagePosts({ single: { url: 'https://www.tiktok.com/@a/video/12345' } }).single.key, 'tt:12345');
// An Instagram video says whether its page held the video's file; nothing else says it.
const reel = { url: 'https://www.instagram.com/reel/CreelTwo2/', video: true };
assert.equal(lib.readPagePosts({ single: { ...reel, videoUrl: 'https://scontent.cdninstagram.com/v/reel2.mp4' } }).single.videoFile, true);
assert.equal(lib.readPagePosts({ single: reel }).single.videoFile, false);
assert.equal(lib.readPagePosts({ single: { ...reel, videoUrl: 'javascript:alert(1)' } }).single.videoFile, false);
assert.equal('videoFile' in lib.readPagePosts({ single: { url: 'https://x.com/a/status/1', video: true, videoUrl: 'https://video.twimg.com/a.mp4' } }).single, false);
console.log('PASS the hand-over is checked field by field');

// Instagram copies get the bookmark button's shape, pictures only from Instagram's own hosts.
const ig = lib.readPagePosts({ posts: [{ url: 'https://www.instagram.com/p/CgridOne1/', author: 'Ana Field Notes', handle: 'fieldnotes_ana', text: 'Crumb',
  pictures: ['https://scontent.cdninstagram.com/v/grid1.jpg', 'https://evil.invalid/x.jpg'], video: false }] }).posts[0];
assert.deepEqual(lib.instagramDataOf(ig), { caption: 'Crumb', author: 'Ana Field Notes', handle: 'fieldnotes_ana', takenAt: '', pictures: ['https://scontent.cdninstagram.com/v/grid1.jpg'], video: false });
assert.equal(lib.instagramTitle(ig), 'Ana Field Notes on Instagram');
assert.equal(lib.instagramTitle({ author: '', handle: 'fieldnotes_ana' }), '@fieldnotes_ana on Instagram');
console.log('PASS Instagram posts keep the bookmark button\'s rules');

// "Already saved" finds a link whatever spelling it was saved with.
const saved = lib.savedByKey([
  { id: 'a', url: 'https://twitter.com/BreadLabNotes/status/1848900000000000002', categories: ['other', 'Recipes'] },
  { id: 'b', url: 'https://www.instagram.com/fieldnotes_ana/p/CgridOne1/?img_index=1', categories: [] },
  { id: 'c', url: 'https://walks.example.invalid/', categories: [] },
]);
assert.deepEqual([...saved.keys()], ['x:1848900000000000002', 'ig:CgridOne1']);
assert.equal(lib.shelfOf(saved.get('x:1848900000000000002')), 'Recipes');
assert.equal(lib.firstLine('\n  First line  \nsecond'), 'First line');
const now = Date.parse('2026-10-24T10:00:00.000Z');
assert.deepEqual(['2026-10-24T09:58:00Z', '2026-10-24T08:00:00Z', '2026-10-21T10:00:00Z', 'never'].map(t => lib.postAge(t, now)), ['2m', '2h', '3d', '']);
console.log('PASS already-saved posts are found by post, not by spelling');

// What the extension kept while the app wasn't running: checked like the posts.
const keptPost = { url: 'https://www.instagram.com/reel/CkeptOne7/', site: 'instagram', author: 'bakehouse.kit', handle: '', text: 'Scoring', pictures: [], video: true };
const keptRead = lib.readKept({ waiting: [
  { id: 'mh6abc12xyz9', keptAt: '2026-10-24T10:00:00.000Z', url: keptPost.url, title: 'Instagram', single: keptPost,
    files: [{ url: 'https://scontent.cdninstagram.com/v/kept7.mp4', kind: 'video', size: 307224, dropped: false, fileId: 'x' }, { url: 7, kind: 'video' }, { url: 'https://a.invalid/x', kind: 'pdf' }] },
  { id: 'mh6abd34qwe1', keptAt: '2026-10-24T09:00:00.000Z', url: 'https://walks.example.invalid/ten', title: 'Ten walks', single: null, files: [] },
  { id: 'BAD ID', url: 'https://walks.example.invalid/', single: null },
  { id: 'mh6abe56rty2', url: 'javascript:alert(1)', single: null },
  { id: 'mh6abf78uio3', url: 'https://walks.example.invalid/a', single: { ...keptPost } },
], notices: [{ name: "haleandcrumb's post", keptAt: '2026-10-20T10:00:00.000Z', kind: 'video' }, { name: 'x', kind: 'audio' }] });
assert.deepEqual(keptRead.items.map(i => i.id), ['mh6abc12xyz9', 'mh6abd34qwe1'], 'a bad id, a non-web address and a post that isn\'t the item\'s own are dropped');
assert.deepEqual(keptRead.rejected, ['mh6abe56rty2', 'mh6abf78uio3'], 'the refused ones with an id are named, so the extension can let them go');
assert.deepEqual(keptRead.items[0].files, [{ url: 'https://scontent.cdninstagram.com/v/kept7.mp4', kind: 'video', size: 307224, dropped: false }]);
assert.equal(keptRead.items[0].post.key, 'ig:CkeptOne7');
assert.deepEqual(keptRead.notices, [{ name: "haleandcrumb's post", keptAt: '2026-10-20T10:00:00.000Z', kind: 'video' }]);
assert.equal(lib.readKept({ waiting: [] }), null);
assert.equal(lib.readKept({ single: null, posts: [] }), null);
console.log('PASS kept items are checked like the posts');
console.log('ALL PASS');
