// The extension's post readers (extension/readers.js, v0.4.0 phase 3) on synthetic stand-in pages for X,
// Instagram and TikTok served at the sites' addresses: the open post, or the posts already loaded on a
// feed, profile or search page. Reading never scrolls, opens anything or makes a request.
// Run from frontend/: node tests/post-readers-e2e.mjs (C4_PLAYWRIGHT_MODULE)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as pages from './post-pages.mjs';

const readers = await readFile(fileURLToPath(new URL('../../extension/readers.js', import.meta.url)), 'utf8');
const snapshot = await readFile(fileURLToPath(new URL('../../extension/snapshot.js', import.meta.url)), 'utf8');
const media = await readFile(fileURLToPath(new URL('../../extension/media.js', import.meta.url)), 'utf8');
const { chromium } = createRequire(import.meta.url)(process.env.C4_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
await pages.serveStandIns(context);
await context.route('https://walks.example.invalid/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Ten walks</title><article><a href="https://x.com/someone/status/123">a post</a></article>' }));

const failures = [];
async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message.split('\n').slice(0, 8).join(' | ')}`); }
}
/** Open a stand-in, put the readers in it as the extension does, and read it; no request may happen meanwhile. */
async function read(url, how = () => sbmReaders.readPage()) {
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  await page.addScriptTag({ content: readers });
  const requests = [];
  page.on('request', r => requests.push(r.url()));
  const result = await page.evaluate(how);
  const scrolled = await page.evaluate(() => window.scrollY);
  await page.close();
  assert.deepEqual(requests, [], 'reading makes no request');
  assert.equal(scrolled, 0, 'reading never scrolls');
  return result;
}

await check('X feed: the posts loaded in the tab, each once, quoted posts not mixed in', async () => {
  const result = await read(pages.X_FEED_URL);
  assert.equal(result.site, 'x');
  assert.equal(result.single, null);
  assert.deepEqual(result.posts.map(p => p.url), [
    'https://x.com/maraquinn/status/1849000000000000001', 'https://x.com/breadlabnotes/status/1848900000000000002',
    'https://x.com/tferreira/status/1848800000000000003', 'https://x.com/JuniperBakes/status/1848700000000000004']);
  assert.deepEqual(result.posts[0], {
    url: 'https://x.com/maraquinn/status/1849000000000000001', site: 'x', author: 'Mara Quinn', handle: 'maraquinn',
    text: 'Day 3 of the rye starter: finally bubbly.\nFeeding schedule in the thread below.', takenAt: '2026-10-24T08:00:00.000Z',
    pictures: ['https://pbs.twimg.com/media/MaraOne?format=jpg&name=small', 'https://pbs.twimg.com/media/MaraTwo?format=jpg&name=small'], video: false });
  assert.equal(result.posts[1].author, 'Bread Lab Notes', 'a repost is saved as the original post');
  assert.deepEqual([result.posts[2].video, result.posts[2].pictures], [true, ['https://pbs.twimg.com/ext_tw_video_thumb/3/pu/img/loaf.jpg']], 'a video brings its cover');
  const quoting = result.posts[3];
  assert.equal(quoting.text, 'Rye crackers from leftover starter. Recipe card attached.');
  assert.deepEqual(quoting.pictures, ['https://pbs.twimg.com/media/JuniperCard?format=png&name=900x900'], 'the quoted post\'s picture is not this post\'s');
  assert.equal(quoting.author, 'Juniper Wells');
});

await check('X post page: the open post, not the replies under it; tracking left out of its address', async () => {
  const result = await read(pages.X_POST_URL);
  assert.deepEqual(result.posts, []);
  assert.deepEqual(result.single, {
    url: 'https://x.com/maraquinn/status/1849000000000000001', site: 'x', author: 'Mara Quinn', handle: 'maraquinn',
    text: 'Day 3 of the rye starter: finally bubbly.\nFeeding schedule in the thread below.', takenAt: '2026-10-24T08:00:00.000Z',
    pictures: ['https://pbs.twimg.com/media/MaraOne?format=jpg&name=large'], video: false });
});

await check('Instagram feed: each post with its caption, pictures and video; other boxes skipped', async () => {
  const result = await read(pages.IG_FEED_URL);
  assert.equal(result.site, 'instagram');
  assert.deepEqual(result.posts, [
    { url: 'https://www.instagram.com/p/CfeedOne1/', site: 'instagram', author: 'fieldnotes_ana', handle: 'fieldnotes_ana',
      text: 'Crumb shot from this morning\'s bake. 80% hydration, 4 hour bulk.', takenAt: '2026-10-23T18:00:00.000Z',
      pictures: ['https://scontent.cdninstagram.com/v/feed1_1080.jpg'], video: false },
    { url: 'https://www.instagram.com/reel/CreelTwo2/', site: 'instagram', author: 'bakehouse.kit', handle: 'bakehouse.kit',
      text: 'Shaping a batard in 30 seconds', takenAt: '2026-10-22T12:00:00.000Z',
      pictures: ['https://scontent.cdninstagram.com/v/reel2_cover.jpg'], video: true },
  ]);
});

await check('Instagram profile: the grid\'s posts, named after the profile; one address per post', async () => {
  const result = await read(pages.IG_PROFILE_URL);
  assert.deepEqual(result.posts.map(p => [p.url, p.author, p.handle, p.video]), [
    ['https://www.instagram.com/p/CgridOne1/', 'Ana Field Notes', 'fieldnotes_ana', false],
    ['https://www.instagram.com/reel/CgridTwo2/', 'Ana Field Notes', 'fieldnotes_ana', true],
    ['https://www.instagram.com/p/CgridThree3/', 'Ana Field Notes', 'fieldnotes_ana', false],
  ]);
  assert.match(result.posts[0].text, /^Photo by Ana Field Notes on October 20, 2026/);
  assert.deepEqual(result.posts[0].pictures, ['https://scontent.cdninstagram.com/v/grid1.jpg']);
});

await check('Instagram post page: read as the bookmark button reads it', async () => {
  const result = await read(pages.IG_POST_URL);
  assert.deepEqual(result.single, {
    url: 'https://www.instagram.com/p/CfixTure123/', site: 'instagram', author: 'Ana Field Notes', handle: 'fieldnotes_ana',
    text: 'Slow rise rye, day three. Recipe in the comments.', takenAt: '2026-10-01T09:30:00.000Z',
    pictures: ['https://scontent.cdninstagram.com/v/one_1080.jpg', 'https://scontent.cdninstagram.com/v/two_1080.jpg'], video: false });
});

await check('Instagram video: its file\'s address from what the page holds, only when one post is saved', async () => {
  const reel = await read(pages.IG_REEL_URL);
  assert.deepEqual(reel.single, {
    url: 'https://www.instagram.com/reel/CreelOwn55/', site: 'instagram', author: 'bakehouse.kit', handle: 'bakehouse.kit',
    text: 'Shaping a batard in 30 seconds', takenAt: '2026-10-22T12:00:00.000Z', pictures: ['https://scontent.cdninstagram.com/v/reel55_cover.jpg'],
    video: true, videoUrl: 'https://scontent.cdninstagram.com/v/reel55.mp4' }, 'the <video> playing a file');
  const feed = await read(pages.IG_FEED_URL, () => sbmReaders.cards().map(card => sbmReaders.postOf(card)?.videoUrl ?? null));
  assert.deepEqual(feed, [null, 'https://scontent.cdninstagram.com/v/reel2_1080.mp4', null], 'a post\'s Download button: the widest file in the page\'s own data');
  const list = await read(pages.IG_FEED_URL);
  assert.ok(list.posts.every(post => !('videoUrl' in post)), 'a list never looks for media');
});

await check('a video on a host that only looks like Instagram\'s, or another post\'s video, is not taken', async () => {
  const lookalike = await read(pages.IG_REEL_URL, () => {
    document.querySelector('video').setAttribute('src', 'https://evil.invalid?.fbcdn.net/v.mp4');
    return sbmReaders.readPage().single.videoUrl ?? null;
  });
  assert.equal(lookalike, null, 'checked by the address\'s real host');
  const beside = await read(pages.IG_REEL_URL, () => {
    document.querySelector('video').remove();
    document.body.insertAdjacentHTML('beforeend', '<aside><video preload="none" src="https://scontent.cdninstagram.com/v/suggested.mp4"></video></aside>');
    return sbmReaders.readPage().single.videoUrl ?? null;
  });
  assert.equal(beside, null, 'a suggested reel beside the open post is not its video');
});

await check('TikTok profile: videos and photo posts, captions without the "created by" line', async () => {
  const result = await read(pages.TT_PROFILE_URL);
  assert.equal(result.site, 'tiktok');
  assert.deepEqual(result.posts.map(p => [p.url, p.author, p.text, p.video]), [
    ['https://www.tiktok.com/@juniperbakes/video/7430000000000000001', 'Juniper Wells', 'Rye crackers from leftover starter #sourdough #rye', true],
    ['https://www.tiktok.com/@juniperbakes/photo/7430000000000000002', 'Juniper Wells', 'Five loaves, five flours', false],
    ['https://www.tiktok.com/@juniperbakes/video/7430000000000000003', 'Juniper Wells', '', true],
  ]);
  assert.deepEqual(result.posts[0].pictures, ['https://p16-sign-va.tiktokcdn.com/obj/tos-useast2a-p-0068/rye1.jpeg']);
});

await check('TikTok video page: the open video, its caption and cover', async () => {
  const result = await read(pages.TT_VIDEO_URL);
  assert.deepEqual(result.single, {
    url: 'https://www.tiktok.com/@juniperbakes/video/7430000000000000001', site: 'tiktok', author: 'Juniper Wells', handle: 'juniperbakes',
    text: 'Rye crackers from leftover starter #sourdough', takenAt: '', pictures: ['https://p16-sign-va.tiktokcdn.com/obj/tos-useast2a-p-0068/cover.jpeg'], video: true });
});

await check('TikTok For You, 2026 layout: no video there has an address of its own, so nothing is listed', async () => {
  const result = await read(pages.TT_FOR_YOU_URL);
  assert.deepEqual([result.site, result.single, result.posts], ['tiktok', null, []]);
  const addresses = await read(pages.TT_FOR_YOU_URL, () => sbmReaders.cards().map(card => sbmReaders.addressOf(card)));
  assert.deepEqual(addresses, ['', ''], 'its cards have no address, so they get no Download button');
});

await check('TikTok video page, 2026 layout: the open video with its creator and cover; its card has the page\'s address', async () => {
  const result = await read(pages.TT_CINEMA_URL);
  assert.match(result.single.text, /^Overnight rye, no knead\s+#rye$/);
  assert.deepEqual({ ...result.single, text: '' }, { url: 'https://www.tiktok.com/@juniperbakes/video/7430000000000000009', site: 'tiktok',
    author: 'Juniper Wells', handle: 'juniperbakes', text: '', takenAt: '', video: true,
    pictures: ['https://p16-common-sign.tiktokcdn-us.com/tos-maliva-p-0068/rye9~tplv-tiktokx-origin.jpeg'] });
  const cards = await read(pages.TT_CINEMA_URL, () => sbmReaders.cards().map(card => { const post = sbmReaders.postOf(card); return post && [post.url, post.author]; }));
  assert.deepEqual(cards, [['https://www.tiktok.com/@juniperbakes/video/7430000000000000009', 'Juniper Wells'],
    ['https://www.tiktok.com/@bakehouse.kit/video/7430000000000000078', 'Kit']], 'the open video\'s Download button saves it');
});

await check('Instagram Reels viewer: the reel in the address, read from its own article, not the one before it', async () => {
  const result = await read(pages.IG_REELS_URL);
  assert.deepEqual(result.single, { url: 'https://www.instagram.com/reel/CreelTwo2/', site: 'instagram', author: 'bakehouse.kit', handle: 'bakehouse.kit',
    text: 'Shaping a batard in 30 seconds', takenAt: '2026-10-22T12:00:00.000Z', pictures: ['https://scontent.cdninstagram.com/v/reel2_cover.jpg'], video: true,
    videoUrl: 'https://scontent.cdninstagram.com/v/reel2_1080.mp4' });
});

await check('Instagram Reels tab, 2026: the reel in view is the post (not its audio link); the others have no address yet', async () => {
  const result = await read(pages.IG_REELS_TAB_URL);
  assert.deepEqual(result.single, { url: 'https://www.instagram.com/reel/CreelAAA11/', site: 'instagram', author: 'kit.a', handle: 'kit.a',
    text: 'Proofing in the fridge overnight', takenAt: '', pictures: ['https://scontent.cdninstagram.com/v/reelA_cover.jpg'], video: true });
  const addresses = await read(pages.IG_REELS_TAB_URL, () => sbmReaders.cards().map(card => sbmReaders.addressOf(card)));
  assert.deepEqual(addresses, ['https://www.instagram.com/reel/CreelAAA11/', '', ''],
    'three reels (the one in view has the page\'s address); their audio links are no posts');
});

await check('Instagram Reels tab, scrolled to the next reel: that reel is the post, not the one the page\'s own tags describe', async () => {
  const single = await read(pages.IG_REELS_TAB_URL, () => {
    // The tags describe the reel the tab was opened on; scrolling, Instagram changes the address only.
    document.head.insertAdjacentHTML('beforeend', '<meta property="og:url" content="https://www.instagram.com/reels/CreelAAA11/">'
      + '<meta property="og:title" content="Kit A on Instagram: &quot;Proofing in the fridge overnight&quot;">'
      + '<meta property="og:description" content="12 likes - kit.a: Proofing in the fridge overnight">'
      + '<meta property="og:image" content="https://scontent.cdninstagram.com/v/reelA_og.jpg">');
    const first = sbmReaders.readPage().single;
    history.replaceState(null, '', '/reels/CreelBBB22/');
    scrollTo(0, innerHeight);
    const next = sbmReaders.readPage().single;
    history.replaceState(null, '', '/reels/CreelCCC33/');
    scrollTo(0, 2 * innerHeight);
    const third = sbmReaders.readPage().single;
    scrollTo(0, 0);
    return [first, next, third];
  });
  assert.deepEqual([single[0].author, single[0].text], ['Kit A', '12 likes - kit.a: Proofing in the fridge overnight'], 'the tags are this reel\'s');
  assert.deepEqual(single[1], { url: 'https://www.instagram.com/reel/CreelBBB22/', site: 'instagram', author: 'mara.b', handle: 'mara.b',
    text: 'Rye at 100% hydration', takenAt: '', pictures: ['https://scontent.cdninstagram.com/v/reelB_cover.jpg'], video: true });
  assert.deepEqual([single[2].url, single[2].handle, single[2].text], ['https://www.instagram.com/reel/CreelCCC33/', 'tom.c', 'Scoring a batard\nTwo cuts, one ear'],
    'a caption written as plain text between line breaks, as in the owner\'s Reels tab');
});

await check('a reel opened over its creator\'s profile: its cover from the grid behind, not the profile\'s tags', async () => {
  const [single, button] = await read(pages.IG_REEL_OVER_PROFILE_URL, () => [sbmReaders.readPage().single,
    sbmReaders.postOf(sbmReaders.cards().find(card => card.matches('article')))]);
  const own = { url: 'https://www.instagram.com/reel/CreelGrid8/', site: 'instagram', author: 'bakehouse.kit', handle: 'bakehouse.kit',
    text: 'Shaping a batard, take two', takenAt: '2026-10-23T12:00:00.000Z', pictures: ['https://scontent.cdninstagram.com/v/grid8_cover.jpg'], video: true };
  assert.deepEqual(single, own, 'the toolbar icon');
  assert.deepEqual(button, own, 'its Download button');
});

await check('a post with no caption, opened over a page: no comment is its caption, no profile picture its picture', async () => {
  const [single, button] = await read(pages.IG_NOCAPTION_URL, () => [sbmReaders.readPage().single,
    sbmReaders.postOf(sbmReaders.cards().find(card => card.matches('article')))]);
  const own = { url: 'https://www.instagram.com/p/CnoCaption1/', site: 'instagram', author: 'mara.b', handle: 'mara.b', text: '',
    takenAt: '2026-10-24T08:00:00.000Z', pictures: ['https://scontent.cdninstagram.com/v/nocap_1080.jpg'], video: false };
  assert.deepEqual(single, own, 'the toolbar icon: its own time, not the comment\'s; pictures told by size where the label isn\'t English');
  assert.deepEqual(button, own, 'its Download button');
});

await check('a post opened over the feed is read where it is shown whole, not from a card behind it', async () => {
  const result = await read(pages.IG_OVER_FEED_URL);
  assert.deepEqual(result.single, { url: 'https://www.instagram.com/p/CoverFeed22/', site: 'instagram', author: 'mara.b', handle: 'mara.b',
    text: 'Rye at 100% hydration: the full method is in three steps, and none of them is kneading.', takenAt: '2026-10-24T08:00:00.000Z',
    pictures: ['https://scontent.cdninstagram.com/v/feed22_1080.jpg'], video: false });
});

await check('a profile\'s name comes only from a title or tags that name that profile', async () => {
  const [stale, titled] = await read(pages.IG_PROFILE_STALE_URL, () => {
    const first = sbmReaders.readPage().posts[0];
    document.title = '(2) Tom C (@tom.c) • Instagram photos and videos';
    return [first, sbmReaders.readPage().posts[0]];
  });
  assert.deepEqual([stale.url, stale.handle, stale.author], ['https://www.instagram.com/p/CtomOne111/', 'tom.c', ''], 'not the name of the profile the tab was opened on');
  assert.equal(titled.author, 'Tom C', 'the tab\'s title names this profile');
});

await check('the page structure for support: a name written with its own separators, and another site\'s name, stay out', async () => {
  const structure = async (url, prepare = () => {}) => {
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    await page.addScriptTag({ content: readers });
    await page.addScriptTag({ content: snapshot });
    await page.evaluate(prepare);
    const text = await page.evaluate(() => sbmSnapshot());
    await page.close();
    return text;
  };
  const feed = await structure(pages.X_FEED_URL, () => document.querySelector('main').insertAdjacentHTML('beforeend',
    '<div data-testid="UserAvatar-Container-jo_li" class="avatar jo_li"><a href="/jo_li">@jo_li</a></div>'
    + '<div data-testid="UserAvatar-Container-Jo_Smith"><a href="/jo_smith">Jo</a></div>'));
  assert.ok(!/jo_li|jo_smith|smith/i.test(feed), feed.split('\n').filter(line => /jo_|smith/i.test(line)).join(' | '));
  assert.match(feed, /\[testid=UserAvatar-Container-\*\]/);
  assert.match(feed, /^site: x\.com /m);
  const other = await structure('https://walks.example.invalid/ten');
  assert.match(other, /^site: another site /m);
  assert.ok(!/walks|example/i.test(other), 'another site isn\'t named');
});

await check('a picture address that sends the browser somewhere else is not taken for the post\'s file', async () => {
  // The stand-in pages can't play a real redirect, so the page's fetch answers as the browser does after one: the file,
  // with the address it came from in the end.
  const page = await context.newPage();
  try {
    await page.goto(pages.IG_FEED_URL);
    await page.evaluate(() => {
      const real = window.fetch;
      window.fetch = async (url, init) => {
        const response = await real(String(url).replace('/moved.jpg', '/feed1_320.jpg'), init);
        if (String(url).endsWith('/moved.jpg')) Object.defineProperty(response, 'url', { value: 'https://elsewhere.example.invalid/x.png' });
        return response;
      };
    });
    await page.addScriptTag({ content: media });
    const got = await page.evaluate(() => sbmMedia.fetchAll([{ url: 'https://scontent.cdninstagram.com/v/moved.jpg', kind: 'picture' },
      { url: 'https://scontent.cdninstagram.com/v/feed1_1080.jpg', kind: 'picture' }]));
    assert.deepEqual(got.map(file => file.error || 'taken'), ['unavailable', 'taken']);
  } finally {
    await page.close();
  }
});

await check('a post card on its own (what a Download button reads)', async () => {
  const cards = await read(pages.X_FEED_URL, () => sbmReaders.cards().map(card => sbmReaders.postOf(card)?.url ?? null));
  assert.deepEqual(cards, ['https://x.com/maraquinn/status/1849000000000000001', 'https://x.com/breadlabnotes/status/1848900000000000002',
    'https://x.com/tferreira/status/1848800000000000003', 'https://x.com/JuniperBakes/status/1848700000000000004', 'https://x.com/maraquinn/status/1849000000000000001']);
  const addresses = await read(pages.X_FEED_URL, () => sbmReaders.cards().map(card => sbmReaders.addressOf(card)));
  assert.deepEqual(addresses, cards, 'the address alone (what the green check asks about) is the same');
  const more = await read(pages.TT_VIDEO_URL, () => sbmReaders.cards().map(card => sbmReaders.postOf(card)?.url));
  assert.deepEqual(more, ['https://www.tiktok.com/@bakehouse.kit/video/7430000000000000077'], 'the videos suggested beside the open one');
});

await check('any other site: nothing is read', async () => {
  const result = await read('https://walks.example.invalid/ten');
  assert.deepEqual(result, { site: null, page: { url: 'https://walks.example.invalid/ten', title: 'Ten walks' }, single: null, posts: [] });
});

await check('at most 50 posts are handed over', async () => {
  const many = await read(pages.X_FEED_URL, () => {
    const list = document.querySelector('[aria-label^="Timeline"]');
    for (let i = 0; i < 70; i++) list.insertAdjacentHTML('beforeend',
      `<article data-testid="tweet"><a href="/someone/status/18${String(i).padStart(17, '0')}"><time datetime="2026-10-01T00:00:00Z">1d</time></a><div data-testid="tweetText">Post ${i}</div></article>`);
    return sbmReaders.readPage().posts.length;
  });
  assert.equal(many, 50);
});

await context.close();
await browser.close();
if (failures.length) { console.error(`FAILED ${failures.length}`); process.exit(1); }
console.log('ALL PASS');
