// Which links get site artwork, and what it says, in Node (synthetic links only).
// Run from frontend/: node tests/platform-art-test.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Just enough of a browser for the modules these import.
const memory = new Map();
globalThis.localStorage = { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), removeItem: k => memory.delete(k), clear: () => memory.clear() };
globalThis.window = globalThis;
globalThis.addEventListener = () => {}; globalThis.removeEventListener = () => {};
globalThis.document = { addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, createElement: () => ({ style: {} }),
  visibilityState: 'visible', documentElement: { dataset: {}, style: { setProperty() {} } } };

const out = await build({
  stdin: {
    contents: `
      export { brandOf, kindOf, BRAND_LABEL } from './src/components/library/PlatformArt';
      export { socialText } from './src/components/library/SocialCard';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const { brandOf, kindOf, BRAND_LABEL, socialText } = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const post = (url, extra = {}) => {
  const u = new URL(url);
  return { id: url, url, source: 'browser', platform: 'web', domain: u.hostname.replace(/^www\./, ''), status: 'reference',
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', categories: [], tags: [], projectIds: [], metadataStatus: 'enriched', ...extra };
};
let failed = 0;
const check = (name, run) => { try { run(); console.log('PASS', name); } catch (e) { failed++; console.error('FAIL', name, '\n ', e.message.split('\n').slice(0, 5).join('\n  ')); } };

check('the twelve sites the owner listed (and Threads, Bluesky) are recognised, whatever the app filed them under', () => {
  const cases = [
    ['https://www.facebook.com/groups/club/posts/1', 'facebook', 'Group post'],
    ['https://www.instagram.com/reel/Cx1abc/', 'instagram', 'Reel'],
    ['https://www.youtube.com/watch?v=abcDEF12345', 'youtube', 'Video'],
    ['https://youtu.be/abcDEF12345', 'youtube', 'Video'],
    ['https://www.youtube.com/shorts/abcDEF12345', 'youtube', 'Short'],
    ['https://chat.whatsapp.com/Invite123', 'whatsapp', 'Group invite'],
    ['https://wa.me/15550001111', 'whatsapp', 'Chat link'],
    ['https://www.tiktok.com/@cook/video/7000000000001', 'tiktok', 'Video'],
    ['https://mp.weixin.qq.com/s/AbCd', 'wechat', 'Article'],
    ['https://t.me/designdigest/120', 'telegram', 'Channel post'],
    ['https://t.me/designdigest', 'telegram', 'Channel'],
    ['https://www.linkedin.com/posts/sam_hiring-1', 'linkedin', 'Post'],
    ['https://www.snapchat.com/spotlight/W7_1', 'snapchat', 'Spotlight'],
    ['https://www.reddit.com/r/homelab/comments/x1/y/', 'reddit', 'Thread'],
    ['https://x.com/someone/status/1800000000001', 'x', 'Post'],
    ['https://www.pinterest.com/pin/9900001/', 'pinterest', 'Pin'],
    ['https://www.threads.net/@someone/post/Abc', 'threads', 'Post'],
    ['https://bsky.app/profile/someone.bsky.social/post/3k', 'bluesky', 'Post'],
  ];
  for (const [url, brand, kind] of cases) {
    const p = post(url);
    assert.equal(brandOf(p), brand, url);
    assert.equal(kindOf(p, brand), kind, url);
    assert.ok(BRAND_LABEL[brand], brand);
  }
  // Look-alike hosts and ordinary sites get no site artwork.
  for (const url of ['https://notreddit.example/r/x', 'https://example.com/t.me', 'https://twhatsapp.com.example/x', 'https://github.com/a/b', 'https://news.example.org/story']) {
    assert.equal(brandOf(post(url)), null, url);
  }
});

check('a title that only names the site is not shown as the post\'s words', () => {
  for (const title of ['Instagram post', 'Post on X', 'TikTok video', 'Spotlight on Snapchat', 'Pinterest pin', 'Facebook post', 'LinkedIn post', 'Instagram', 'X']) {
    assert.equal(socialText(post('https://www.instagram.com/p/Abc/', { platform: 'instagram', title })), '', title);
  }
  for (const title of ['My tiny homelab after 3 years', 'Sunset reel', 'Design Digest']) {
    assert.equal(socialText(post('https://www.reddit.com/r/a/comments/b/c/', { platform: 'reddit', title })), title, title);
  }
  assert.equal(socialText(post('https://www.instagram.com/p/Abc/', { platform: 'instagram', title: 'Instagram post',
    description: 'Sunday market haul: figs, sourdough and far too many tomatoes' })), 'Sunday market haul: figs, sourdough and far too many tomatoes');
});

if (failed) { console.error(`FAILED ${failed}`); process.exit(1); }
console.log('ALL PASS');
