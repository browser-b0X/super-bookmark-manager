// Synthetic stand-in pages for X, Instagram and TikTok, shaped like the sites' own markup where the
// readers look (data-testid / data-e2e names, <article>, <time datetime>, picture addresses). Made-up
// people and posts. Playwright serves them at the sites' addresses, so no real site is ever contacted.
import { createHmac } from 'node:crypto';
import { deflateSync } from 'node:zlib';

/** A plain 200 × 200 PNG (big enough not to count as an icon). */
function png(size = 200) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const i = y * (size * 3 + 1) + 1 + x * 3; raw[i] = 200; raw[i + 1] = 150; raw[i + 2] = 100; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export const PICTURE = png();

/** Pair as the extension's options do, without the page: the app shows it knows the code, then the extension does. */
export async function pairExtension(base, origin, code, browser) {
  const nonce = 'cd'.repeat(16);
  const ask = body => fetch(base + '/api/extension/pair', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(body) }).then(response => response.json());
  const { challenge } = await ask({ nonce });
  return ask({ nonce, proof: createHmac('sha256', code.replace('-', '')).update(`browser|${nonce}|${challenge}|${base}`).digest('hex'), browser });
}
/** A stand-in MP4: a real "ftyp" box, then padding (about 300 KB). */
export const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(4), Buffer.from('mp42isom'), Buffer.alloc(300 * 1024)]);

const page = (title, head, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}
<style>body{font:15px/1.4 system-ui;margin:0;background:#fff;color:#0f1419} article,[data-e2e$="item"]{position:relative;border-bottom:1px solid #ddd;padding:12px 16px}
img{max-width:220px;display:block} main{max-width:600px;margin:0 auto}</style></head><body>${body}</body></html>`;

// ── X ──
const xName = (name, handle, id, when, iso, quoted = false) => quoted
  ? `<div data-testid="User-Name"><div><span>${name}</span></div><div><span>@${handle}</span><span>·</span><time datetime="${iso}">${when}</time></div></div>`
  : `<div data-testid="User-Name"><div><a href="/${handle}" role="link"><span>${name}</span></a></div>
     <div><a href="/${handle}" role="link" tabindex="-1"><span>@${handle}</span></a><span>·</span><a href="/${handle}/status/${id}" role="link"><time datetime="${iso}">${when}</time></a></div></div>`;
const xActions = '<div role="group" aria-label="12 replies, 4 reposts, 88 likes"><button data-testid="reply">12</button><button data-testid="like">88</button></div>';

export const X_FEED_URL = 'https://x.com/search?q=sourdough&src=typed_query';
// The page also carries elements named like the extension's globals (a page could, to switch it off).
export const X_FEED = page('sourdough - Search / X', '', `<div id="sbmReaders" hidden></div><div id="sbmMarks" hidden></div>
<main role="main"><div aria-label="Timeline: Search timeline">
<div data-testid="cellInnerDiv"><article data-testid="tweet" role="article" tabindex="0">
  <div data-testid="Tweet-User-Avatar"><a href="/maraquinn"><img alt="" src="https://pbs.twimg.com/profile_images/1/mara_normal.jpg" width="40"></a></div>
  ${xName('Mara Quinn', 'maraquinn', '1849000000000000001', '2h', '2026-10-24T08:00:00.000Z')}
  <div data-testid="tweetText" lang="en"><span>Day 3 of the rye starter: finally bubbly.</span><br><span>Feeding schedule in the thread below.</span></div>
  <div><a href="/maraquinn/status/1849000000000000001/photo/1"><div data-testid="tweetPhoto"><img alt="Image" src="https://pbs.twimg.com/media/MaraOne?format=jpg&amp;name=small"></div></a>
       <a href="/maraquinn/status/1849000000000000001/photo/2"><div data-testid="tweetPhoto"><img alt="Image" src="https://pbs.twimg.com/media/MaraTwo?format=jpg&amp;name=small"></div></a></div>
  ${xActions}
</article></div>
<div data-testid="cellInnerDiv"><article data-testid="tweet" role="article" tabindex="0">
  <div><span data-testid="socialContext">Kitchen Table Radio reposted</span></div>
  ${xName('Bread Lab Notes', 'breadlabnotes', '1848900000000000002', '5h', '2026-10-24T05:00:00.000Z')}
  <div data-testid="tweetText" lang="en"><span>Why your sourdough is flat: a short guide to proofing times at room temperature</span></div>
  ${xActions}
</article></div>
<div data-testid="cellInnerDiv"><article data-testid="tweet" role="article" tabindex="0">
  ${xName('Tomás Ferreira', 'tferreira', '1848800000000000003', '8h', '2026-10-24T02:00:00.000Z')}
  <div data-testid="tweetText" lang="pt"><span>Overnight loaf, 78% hydration, baked in a cast-iron pot. Sound on for the crust.</span></div>
  <div data-testid="videoPlayer"><div data-testid="videoComponent"><video poster="https://pbs.twimg.com/ext_tw_video_thumb/3/pu/img/loaf.jpg" preload="none"></video></div></div>
  ${xActions}
</article></div>
<div data-testid="cellInnerDiv"><article data-testid="tweet" role="article" tabindex="0">
  ${xName('Juniper Wells', 'JuniperBakes', '1848700000000000004', '1d', '2026-10-23T10:00:00.000Z')}
  <div data-testid="tweetText" lang="en"><span>Rye crackers from leftover starter. Recipe card attached.</span></div>
  <div><a href="/JuniperBakes/status/1848700000000000004/photo/1"><div data-testid="tweetPhoto"><img alt="Image" src="https://pbs.twimg.com/media/JuniperCard?format=png&amp;name=900x900"></div></a></div>
  <div role="link" tabindex="0" aria-label="Quoted post">
    ${xName('Bread Lab Notes', 'breadlabnotes', '1848600000000000005', 'Oct 20', '2026-10-20T09:00:00.000Z', true)}
    <div data-testid="tweetText" lang="en"><span>A cracker recipe for every starter discard. Quoted text, not Juniper's.</span></div>
    <div data-testid="tweetPhoto"><img alt="Image" src="https://pbs.twimg.com/media/QuotedOne?format=jpg&amp;name=small"></div>
  </div>
  ${xActions}
</article></div>
<div data-testid="cellInnerDiv"><aside aria-label="Who to follow"><a href="/haleandcrumb">Hale &amp; Crumb</a></aside></div>
<div data-testid="cellInnerDiv"><article data-testid="tweet" role="article" tabindex="0">
  ${xName('Mara Quinn', 'maraquinn', '1849000000000000001', '2h', '2026-10-24T08:00:00.000Z')}
  <div data-testid="tweetText" lang="en"><span>The same post again further down (a reply chain shows it twice).</span></div>
</article></div>
</div></main>`);

export const X_POST_URL = 'https://x.com/maraquinn/status/1849000000000000001?s=20';
export const X_POST = page('Mara Quinn on X: "Day 3 of the rye starter: finally bubbly." / X', '', `<main role="main"><div aria-label="Timeline: Conversation">
<div data-testid="cellInnerDiv"><article data-testid="tweet" role="article" tabindex="-1">
  <div data-testid="User-Name"><div><a href="/maraquinn" role="link"><span>Mara Quinn</span></a></div><div><a href="/maraquinn" role="link" tabindex="-1"><span>@maraquinn</span></a></div></div>
  <div data-testid="tweetText" lang="en"><span>Day 3 of the rye starter: finally bubbly.</span><br><span>Feeding schedule in the thread below.</span></div>
  <div><a href="/maraquinn/status/1849000000000000001/photo/1"><div data-testid="tweetPhoto"><img alt="Image" src="https://pbs.twimg.com/media/MaraOne?format=jpg&amp;name=large"></div></a></div>
  <div><a href="/maraquinn/status/1849000000000000001" role="link"><time datetime="2026-10-24T08:00:00.000Z">8:00 AM · Oct 24, 2026</time></a></div>
  ${xActions}
</article></div>
<div data-testid="cellInnerDiv"><article data-testid="tweet" role="article" tabindex="0">
  ${xName('Hale & Crumb', 'haleandcrumb', '1849000000000000009', '1h', '2026-10-24T09:00:00.000Z')}
  <div data-testid="tweetText" lang="en"><span>Replying: we use the same schedule in class.</span></div>
</article></div>
</div></main>`);

// ── Instagram ──
export const IG_FEED_URL = 'https://www.instagram.com/';
export const IG_FEED = page('Instagram', '', `<main role="main"><div>
<article>
  <div><div><a href="/fieldnotes_ana/"><img alt="fieldnotes_ana's profile picture" src="https://scontent.cdninstagram.com/v/ana_avatar.jpg" width="32"></a></div>
    <div><span><a href="/fieldnotes_ana/">fieldnotes_ana</a></span> • <a href="/p/CfeedOne1/"><time datetime="2026-10-23T18:00:00.000Z">5h</time></a></div></div>
  <div><img alt="Photo by Ana Field Notes on October 23, 2026. May be an image of bread." srcset="https://scontent.cdninstagram.com/v/feed1_320.jpg 320w, https://scontent.cdninstagram.com/v/feed1_1080.jpg 1080w" src="https://scontent.cdninstagram.com/v/feed1_320.jpg"></div>
  <section><button>Like</button><button>Comment</button></section>
  <div><span><a href="/fieldnotes_ana/">fieldnotes_ana</a></span> <span dir="auto">Crumb shot from this morning's bake. 80% hydration, 4 hour bulk.</span><span>… more</span></div>
</article>
<article>
  <div><div><a href="/bakehouse.kit/"><img alt="bakehouse.kit's profile picture" src="https://scontent.cdninstagram.com/v/kit_avatar.jpg" width="32"></a></div>
    <div><span><a href="/bakehouse.kit/">bakehouse.kit</a></span> • <a href="/reel/CreelTwo2/"><time datetime="2026-10-22T12:00:00.000Z">2d</time></a></div></div>
  <div><video preload="none" poster="https://scontent.cdninstagram.com/v/reel2_cover.jpg"></video></div>
  <div><span><a href="/bakehouse.kit/">bakehouse.kit</a></span> <span dir="auto">Shaping a batard in 30 seconds</span></div>
</article>
<article><div><span dir="auto">Suggested for you</span><a href="/explore/">See all</a></div></article>
</div></main>
<script type="application/json">{"require":[["ScheduledServerJS",{"items":[{"code":"CreelTwo2","media_type":2,
"video_versions":[{"width":720,"url":"https://scontent.cdninstagram.com/v/reel2_720.mp4"},{"width":1080,"url":"https://scontent.cdninstagram.com/v/reel2_1080.mp4"}]}]}]]}</script>`);

export const IG_PROFILE_URL = 'https://www.instagram.com/fieldnotes_ana/';
export const IG_PROFILE = page('Ana Field Notes (@fieldnotes_ana) • Instagram photos and videos',
  '<meta property="og:title" content="Ana Field Notes (@fieldnotes_ana) • Instagram photos and videos">', `<main role="main">
<header><img alt="fieldnotes_ana's profile picture" src="https://scontent.cdninstagram.com/v/ana_avatar.jpg" width="150"><h2>fieldnotes_ana</h2><span>Ana Field Notes</span></header>
<div>
  <a href="/fieldnotes_ana/p/CgridOne1/" role="link"><div><img alt="Photo by Ana Field Notes on October 20, 2026. May be an image of bread and text that says 'DAY 3'." src="https://scontent.cdninstagram.com/v/grid1.jpg"></div></a>
  <a href="/fieldnotes_ana/reel/CgridTwo2/" role="link"><div><img alt="Starter feeding routine, explained." src="https://scontent.cdninstagram.com/v/grid2.jpg"></div><svg aria-label="Clip" width="18" height="18"></svg></a>
  <a href="/p/CgridThree3/" role="link"><div><img alt="" src="https://scontent.cdninstagram.com/v/grid3.jpg"></div></a>
  <a href="/fieldnotes_ana/followers/">1,204 followers</a>
</div></main>`);

export const IG_POST_URL = 'https://www.instagram.com/p/CfixTure123/?img_index=1';
const igCaption = 'Slow rise rye, day three. Recipe in the comments.';
export const IG_POST = page('Instagram', `<meta property="og:title" content="Ana Field Notes on Instagram: &quot;${igCaption}&quot;">
<meta property="og:image" content="https://scontent.cdninstagram.com/v/og.jpg">`, `<main><article><header><img alt="fieldnotes_ana's profile picture" src="https://scontent.cdninstagram.com/v/avatar.jpg" width="32">
<a href="/fieldnotes_ana/">fieldnotes_ana</a></header>
<div><img alt="Photo 1" srcset="https://scontent.cdninstagram.com/v/one_320.jpg 320w, https://scontent.cdninstagram.com/v/one_1080.jpg 1080w" src="https://scontent.cdninstagram.com/v/one_320.jpg"></div>
<div><img alt="Photo 2" src="https://scontent.cdninstagram.com/v/two_1080.jpg"></div>
<h1>${igCaption}</h1><time datetime="2026-10-01T09:30:00.000Z">October 1</time>
<ul><li><a href="/someone_else/">someone_else</a> <span dir="auto">A much longer comment that is not the caption of this post at all, just a reply.</span></li></ul>
</article></main>`);

const reel = (code, caption) => page('Instagram', `<meta property="og:title" content="bakehouse.kit on Instagram: &quot;${caption}&quot;">`,
  `<main><article><header><img alt="bakehouse.kit's profile picture" src="https://scontent.cdninstagram.com/v/kit_avatar.jpg" width="32">
<a href="/bakehouse.kit/">bakehouse.kit</a></header>
<div><img alt="Video cover" src="https://scontent.cdninstagram.com/v/${code}_cover.jpg"></div>
<video src="https://scontent.cdninstagram.com/v/${code}.mp4" preload="none"></video>
<h1>${caption}</h1><time datetime="2026-10-22T12:00:00.000Z">2d</time>
</article></main>`);
export const IG_REEL_URL = 'https://www.instagram.com/reel/CreelOwn55/';
export const IG_REEL = reel('reel55', 'Shaping a batard in 30 seconds');
export const IG_KEPT_URL = 'https://www.instagram.com/reel/CkeptOne7/';
export const IG_KEPT = reel('kept7', 'Scoring patterns for a beginner');
export const IG_KEPT2_URL = 'https://www.instagram.com/reel/CkeptTwo8/';
export const IG_KEPT2 = reel('kept8', 'Laminating dough, step by step');

// ── TikTok ──
export const TT_PROFILE_URL = 'https://www.tiktok.com/@juniperbakes?lang=en';
export const TT_PROFILE = page('Juniper Wells (@juniperbakes) | TikTok', '', `<main>
<h1 data-e2e="user-title">juniperbakes</h1><h2 data-e2e="user-subtitle">Juniper Wells</h2>
<div data-e2e="user-post-item-list">
  <div data-e2e="user-post-item"><div><a href="https://www.tiktok.com/@juniperbakes/video/7430000000000000001"><div>
    <img alt="Rye crackers from leftover starter #sourdough #rye created by Juniper Wells with Juniper Wells's original sound" src="https://p16-sign-va.tiktokcdn.com/obj/tos-useast2a-p-0068/rye1.jpeg"></div>
    <strong data-e2e="video-views">12.3K</strong></a></div></div>
  <div data-e2e="user-post-item"><div><a href="https://www.tiktok.com/@juniperbakes/photo/7430000000000000002"><div>
    <img alt="Five loaves, five flours created by Juniper Wells with original sound" src="https://p16-sign-va.tiktokcdn.com/obj/tos-useast2a-p-0068/five.jpeg"></div></a></div></div>
  <div data-e2e="user-post-item"><div><a href="https://www.tiktok.com/@juniperbakes/video/7430000000000000003"><div>
    <img alt="" src="https://p16-sign-va.tiktokcdn.com/obj/tos-useast2a-p-0068/three.jpeg"></div></a></div></div>
</div></main>`);

export const TT_VIDEO_URL = 'https://www.tiktok.com/@juniperbakes/video/7430000000000000001?is_from_webapp=1&sender_device=pc';
export const TT_VIDEO = page('Rye crackers from leftover starter #sourdough | TikTok',
  '<meta property="og:image" content="https://p16-sign-va.tiktokcdn.com/obj/tos-useast2a-p-0068/cover.jpeg">', `<main>
<div data-e2e="browse-video"><video preload="none"></video></div>
<a href="/@juniperbakes"><span data-e2e="browse-username">juniperbakes</span></a>
<span data-e2e="browser-nickname"><span>Juniper Wells</span><span> · </span><span>2026-10-23</span></span>
<h1 data-e2e="browse-video-desc"><span data-e2e="new-desc-span">Rye crackers from leftover starter </span><a href="/tag/sourdough"><strong>#sourdough</strong></a></h1>
<div data-e2e="comment-level-1"><span>Trying these tonight!</span></div>
<div><a href="https://www.tiktok.com/@bakehouse.kit/video/7430000000000000077"><img alt="Shaping a batard created by Kit with original sound" src="https://p16-sign-va.tiktokcdn.com/obj/tos-useast2a-p-0068/kit.jpeg"></a></div>
</main>`);

// ── 2026 layouts, from the owner's page structures (2026-11-08) ──
// TikTok's For You feed: each item holds only its player; the caption and the creator sit in one panel beside them, for
// the video that plays. No item links to its own page.
export const TT_FOR_YOU_URL = 'https://www.tiktok.com/';
const ttFeedItem = cover => `<article data-e2e="recommend-list-item-container" class="css-evcxon-5e6d7f8a--ArticleItemContainer">
  <div data-e2e="anchoring-ambient"></div><div class="css-1mkgzjp-5e6d7f8a--DivContentFlexLayout"><section data-e2e="feed-video"><canvas></canvas>
  <div class="css-zww20g-5e6d7f8a--DivVideoPlayerContainer"><div><div><span><picture><img src="${cover}"></picture></span></div>
  <div class="xgplayer-container tiktok-web-player"><div><video preload="none"></video></div></div></div></div></section></div></article>`;
export const TT_FOR_YOU = page('TikTok - Make Your Day', '', `<main><div data-e2e="anchoring-player-column"><div class="css-ei3j2d-5e6d7f8a--DivColumnListContainer">
${ttFeedItem('https://p16-common-sign.tiktokcdn-us.com/tos-maliva-p-0068/fyp1~tplv-tiktokx-cropcenter.jpeg')}
${ttFeedItem('https://p16-common-sign.tiktokcdn-us.com/tos-maliva-p-0068/fyp2~tplv-tiktokx-cropcenter.jpeg')}
</div><div data-e2e="anchoring-chrome-host"><div><div data-e2e="anchoring-engagement-vertical"><section>
  <div data-e2e="like-icon" role="button"><button>Like</button><strong data-e2e="like-count">1.2K</strong></div></section></div>
  <div data-e2e="anchoring-description-layer"><div><div class="css-pfus7k-5e6d7f8a--DivCaptionContainer">
    <div data-e2e="video-desc"><span data-e2e="desc-span-0_0">Rye crackers from leftover starter </span><a data-e2e="search-common-link" href="/tag/sourdough"><p>#sourdough</p></a></div></div>
  <div data-e2e="cinema-creator-identity"><div data-e2e="cinema-creator-avatar"><a data-e2e="video-author-avatar" href="/@juniperbakes"><img src="https://p16-common-sign.tiktokcdn-us.com/avatar.jpeg"></a></div>
    <div class="css-6bq6xo-5e6d7f8a--DivCreatorUsername"><a href="/@juniperbakes"><div><p>Juniper Wells</p></div></a></div></div>
  </div></div></div></div></div></main>`);

// TikTok's video page: the open video's card holds its caption and creator, but no link to itself; its cover is a picture in
// the player, not a poster. The card after it lists related videos.
export const TT_CINEMA_URL = 'https://www.tiktok.com/@juniperbakes/video/7430000000000000009';
export const TT_CINEMA = page('TikTok - Make Your Day', '', `<div class="css-f1slk2-5e6d7f8a--DivLeftContainer"><div class="css-1rbmkc6-5e6d7f8a--DivColumnListContainer">
<article data-e2e="recommend-list-item-container" class="css-15ek4v0-5e6d7f8a--ArticleItemContainer"><div class="css-x7q2e1-5e6d7f8a--DivContentFlexLayout">
  <section data-e2e="feed-video"><canvas></canvas><div class="css-9iacfr-5e6d7f8a--DivVideoPlayerContainer"><div><div><span><picture>
    <img src="https://p16-common-sign.tiktokcdn-us.com/tos-maliva-p-0068/rye9~tplv-tiktokx-origin.jpeg"></picture></span></div>
    <div class="xgplayer-container tiktok-web-player"><div><video preload="none"></video></div></div></div>
    <div class="css-3rm8q2-5e6d7f8a--DivMediaCardOverlay"><div><div><div class="css-10po8u7-5e6d7f8a--DivOverlayBottomContent">
      <div class="css-f1s7n1-5e6d7f8a--DivCreatorInfoContainer e1a2b3c4"><a href="/@juniperbakes"><div><p>Juniper Wells</p></div></a><span>· 2d ago</span></div>
      <div class="css-1cs5p0c-5e6d7f8a--DivMediaCardDescriptionContainer"><div data-e2e="multiline-text-content"><div data-e2e="video-desc">
        <span data-e2e="desc-span-0">Overnight rye, no knead </span><a data-e2e="search-common-link" href="/tag/rye"><p>#rye</p></a></div></div></div>
    </div></div></div></div></section>
  <section class="css-11fh2ar-5e6d7f8a--SectionActionBarContainer"><div><a data-e2e="video-author-avatar" href="/@juniperbakes"><img src="https://p16-common-sign.tiktokcdn-us.com/avatar.jpeg"></a></div>
    <div data-e2e="like-icon" role="button"><button>Like</button></div></section></div></article>
<article data-e2e="recommend-list-item-container" class="css-6wvhtq-5e6d7f8a--ArticleItemContainer"><button data-e2e="feed-navigation-prev">Up</button>
  <div data-e2e="video-detail-related-video"><a href="https://www.tiktok.com/@bakehouse.kit/video/7430000000000000078">
    <img alt="Shaping a batard created by Kit with original sound" src="https://p16-common-sign.tiktokcdn-us.com/kit2.jpeg"></a></div></article>
</div></div>`);

// Instagram's Reels viewer: several reels, each an <article> without a header or a heading; the one in the address isn't
// the first.
export const IG_REELS_URL = 'https://www.instagram.com/reels/CreelTwo2/';
const igReelCard = (handle, code, iso, caption, media) => `<article><div><div><span role="link"><img alt="${handle}'s profile picture" src="https://scontent.cdninstagram.com/v/${handle}_avatar.jpg" width="32"></span></div>
  <div><a href="/${handle}/" role="link"><span>${handle}</span></a> <a href="/reel/${code}/" role="link"><span><time datetime="${iso}">2d</time></span></a></div>
  <div><span dir="auto">${caption}</span><div role="button">more</div></div></div>${media}<h3>Original audio</h3></article>`;
export const IG_REELS = page('Instagram', '', `<main role="main"><div>
${igReelCard('otherbaker', 'CreelOne1', '2026-10-21T08:00:00.000Z', 'Lamination at home', '<video src="https://scontent.cdninstagram.com/v/reel1.mp4" preload="none"></video>')}
${igReelCard('bakehouse.kit', 'CreelTwo2', '2026-10-22T12:00:00.000Z', 'Shaping a batard in 30 seconds', '<video poster="https://scontent.cdninstagram.com/v/reel2_cover.jpg" preload="none"></video>')}
</div></main>
<script type="application/json">{"require":[["ScheduledServerJS",{"items":[{"code":"CreelTwo2","media_type":2,
"video_versions":[{"width":1080,"url":"https://scontent.cdninstagram.com/v/reel2_1080.mp4"}]}]}]]}</script>`);

// Instagram's Reels tab as the owner's page showed it later the same day: no <article>s. Each reel is a box around its own
// video; only the reel in view has an address (the page's). Its audio link (/reels/audio/…) is no post; its creator's
// links go to their reels (/kit.a/reels/).
export const IG_REELS_TAB_URL = 'https://www.instagram.com/reels/CreelAAA11/';
// `plain`: the caption as text between <br>s in a plain box, as in the owner's Reels tab, without dir="auto".
const igReelBox = (handle, caption, cover, plain = false) => `<div class="reel-box" style="height:100vh;display:flex;gap:16px;align-items:flex-start">
  <div><div><a href="/${handle}/reels/" role="link"><span role="link"><img alt="${handle}'s profile picture" src="https://scontent.cdninstagram.com/v/${handle}_avatar.jpg" width="32"></span></a>
    <a href="/${handle}/reels/" role="link"><span>${handle}</span></a></div>
  <div>${plain ? `<div role="presentation"><div role="button"><div>${caption}</div></div></div>` : `<span dir="auto">${caption}</span>`}</div></div>
  <div class="reel-frame" style="position:relative;width:400px;height:600px">
    <img alt="" src="${cover}" style="position:absolute;inset:0;width:100%;height:100%">
    <div style="position:relative;width:100%;height:100%;overflow:hidden"><div style="position:relative;width:100%;height:100%;z-index:0">
      <video preload="none" style="width:100%;height:100%"></video></div>
      <div><div role="group" style="position:absolute;inset:0"></div></div></div></div>
  <div><button>Like</button><a href="/reels/audio/1234567890/" role="link"><div class="_aagu"><div class="_aagv">
    <img alt="" src="https://scontent.cdninstagram.com/v/audio_${handle}.jpg" width="160" height="160"></div></div></a></div></div>`;
export const IG_REELS_TAB = page('Instagram', '', `<main role="main"><div>
${igReelBox('kit.a', 'Proofing in the fridge overnight', 'https://scontent.cdninstagram.com/v/reelA_cover.jpg')}
${igReelBox('mara.b', 'Rye at 100% hydration', 'https://scontent.cdninstagram.com/v/reelB_cover.jpg')}
${igReelBox('tom.c', 'Scoring a batard<br>Two cuts, one ear', 'https://scontent.cdninstagram.com/v/reelC_cover.jpg', true)}
</div></main>`);

// A reel opened on its own page: shown over the page in a dialog whose box is narrower than the reel's article, so the
// article's top right corner falls outside what the dialog shows. Opened at its own address, the page's tags are its own.
export const IG_REEL_DIALOG_URL = 'https://www.instagram.com/reel/CreelDlg77/';
export const IG_REEL_DIALOG = page('Instagram', '<meta property="og:url" content="https://www.instagram.com/reel/CreelDlg77/">'
  + '<meta property="og:title" content="bakehouse.kit on Instagram: &quot;Shaping a batard&quot;">'
  + '<meta property="og:image" content="https://scontent.cdninstagram.com/v/dlg77_cover.jpg">',
  `<main role="main" style="height:2000px"><div>Behind the dialog</div></main>
<div role="dialog" style="position:fixed;left:40px;top:40px;width:640px;height:620px;overflow:hidden;z-index:10;background:#fff">
  <article role="presentation" style="width:1200px;display:flex">
    <div class="reel-frame" style="position:relative;width:420px;height:600px"><video preload="none" style="width:100%;height:100%"></video></div>
    <div style="width:760px"><a href="/bakehouse.kit/">bakehouse.kit</a><h1>Shaping a batard</h1>
      <time datetime="2026-10-22T12:00:00.000Z">2d</time></div>
  </article></div>`);

// A reel opened over its creator's profile (the owner's retest, 2026-11-08): the profile's grid stays behind the dialog
// with the reel's tile, the reel has no picture of its own in the dialog, and the page's tags are still the profile's.
export const IG_REEL_OVER_PROFILE_URL = 'https://www.instagram.com/reel/CreelGrid8/';
export const IG_REEL_OVER_PROFILE = page('Instagram', '<meta property="og:url" content="https://www.instagram.com/bakehouse.kit/">'
  + '<meta property="og:title" content="Bake House (@bakehouse.kit) &#x2022; Instagram photos and videos">'
  + '<meta property="og:description" content="1,204 followers, 87 following, 312 posts - See Instagram photos and videos from Bake House">'
  + '<meta property="og:image" content="https://scontent.cdninstagram.com/v/bakehouse_profile.jpg">',
  `<main role="main"><div class="grid">
  <a href="/reel/CreelGrid8/" role="link"><img alt="" src="https://scontent.cdninstagram.com/v/grid8_cover.jpg"></a>
  <a href="/p/CgridNine9/" role="link"><img alt="Rye loaves cooling" src="https://scontent.cdninstagram.com/v/grid9.jpg"></a></div></main>
<div role="dialog" style="position:fixed;left:40px;top:40px;width:640px;height:620px;overflow:hidden;z-index:10;background:#fff">
  <article role="presentation" style="width:1200px;display:flex">
    <div class="reel-frame" style="position:relative;width:420px;height:600px"><video preload="none" style="width:100%;height:100%"></video></div>
    <div style="width:760px"><a href="/bakehouse.kit/">bakehouse.kit</a><h1>Shaping a batard, take two</h1>
      <time datetime="2026-10-23T12:00:00.000Z">1d</time></div>
  </article></div>`);

// The pre-release review of 2026-11-09. A post with no caption, opened over its creator's profile, as Instagram shows a
// post whole (the owner's /reel/ structure): the caption would be a heading, and there is none; under it are other people's
// comments, each with a link to itself and its own time; the post's own time is in the link to the post. Instagram in
// Portuguese: profile pictures are told by size, since their label says so only in English.
export const IG_NOCAPTION_URL = 'https://www.instagram.com/p/CnoCaption1/';
export const IG_NOCAPTION = page('Instagram', '<meta property="og:url" content="https://www.instagram.com/mara.b/">'
  + '<meta property="og:title" content="Mara B (@mara.b) &#x2022; Instagram photos and videos">'
  + '<meta property="og:image" content="https://scontent.cdninstagram.com/v/mara_profile.jpg">',
  `<main role="main"><div class="grid">
  <a href="/p/CnoCaption1/" role="link"><img alt="" src="https://scontent.cdninstagram.com/v/nocap_tile.jpg"></a>
  <a href="/p/CgridNine9/" role="link"><img alt="Rye loaves cooling" src="https://scontent.cdninstagram.com/v/grid9.jpg"></a></div></main>
<div role="dialog" style="position:fixed;left:40px;top:40px;width:900px;height:620px;overflow:auto;z-index:10;background:#fff">
  <article role="presentation" style="display:flex">
    <div style="width:420px"><img alt="Foto de mara.b em 24 de outubro de 2026" src="https://scontent.cdninstagram.com/v/nocap_1080.jpg"></div>
    <div style="width:420px">
      <header><a href="/mara.b/"><img alt="Foto do perfil de mara.b" src="https://scontent.cdninstagram.com/v/mara_avatar.jpg" width="32"></a> <a href="/mara.b/">mara.b</a></header>
      <ul><li><a href="/tom.c/"><img alt="Foto do perfil de tom.c" src="https://scontent.cdninstagram.com/v/tom_avatar.jpg" width="32"></a>
        <a href="/tom.c/">tom.c</a> <span dir="auto">A long comment from somebody else, which must never be taken for the caption of this post.</span>
        <a href="/p/CnoCaption1/c/17900000000000001/"><time datetime="2026-10-24T09:00:00.000Z">1h</time></a></li></ul>
      <section><span dir="auto">Curtido por kit.a e outras pessoas</span></section>
      <a href="/p/CnoCaption1/"><time datetime="2026-10-24T08:00:00.000Z">2h</time></a>
    </div>
  </article></div>`);

// A post opened over the feed: the feed behind still holds another post's card first, then this post's own card with its
// caption cut short; the post whole, with its heading, is in the dialog.
export const IG_OVER_FEED_URL = 'https://www.instagram.com/p/CoverFeed22/';
const igFeedCard = (handle, code, iso, picture, caption) => `<article>
  <div><a href="/${handle}/"><img alt="${handle}'s profile picture" src="https://scontent.cdninstagram.com/v/${handle}_avatar.jpg" width="32"></a>
    <a href="/${handle}/">${handle}</a> • <a href="/p/${code}/"><time datetime="${iso}">1d</time></a></div>
  <div><img alt="Photo by ${handle}" src="${picture}"></div>
  <div><span dir="auto">${caption}</span><span>… more</span></div></article>`;
export const IG_OVER_FEED = page('Instagram', '', `<main role="main"><div>
${igFeedCard('kit.a', 'CotherPost1', '2026-10-25T10:00:00.000Z', 'https://scontent.cdninstagram.com/v/other1.jpg', 'Another post entirely, first in the feed.')}
${igFeedCard('mara.b', 'CoverFeed22', '2026-10-24T08:00:00.000Z', 'https://scontent.cdninstagram.com/v/feed22_640.jpg', 'Rye at 100% hydration: the full method is')}
</div></main>
<div role="dialog" style="position:fixed;left:40px;top:40px;width:900px;height:620px;overflow:auto;z-index:10;background:#fff">
  <article role="presentation" style="display:flex">
    <div style="width:420px"><img alt="Photo by mara.b" src="https://scontent.cdninstagram.com/v/feed22_1080.jpg"></div>
    <div style="width:420px"><header><a href="/mara.b/">mara.b</a></header>
      <ul><li><h2><a href="/mara.b/">mara.b</a></h2><h1>Rye at 100% hydration: the full method is in three steps, and none of them is kneading.</h1>
        <time datetime="2026-10-24T08:00:00.000Z">1d</time></li>
        <li><a href="/tom.c/">tom.c</a> <span dir="auto">Trying this at the weekend.</span></li></ul>
      <a href="/p/CoverFeed22/"><time datetime="2026-10-24T08:00:00.000Z">1d</time></a>
    </div>
  </article></div>`);

// A profile reached by a click from another one: the tab's title is Instagram's own, and the page's tags still describe
// the profile the tab was opened on.
export const IG_PROFILE_STALE_URL = 'https://www.instagram.com/tom.c/';
export const IG_PROFILE_STALE = page('Instagram', '<meta property="og:title" content="Ana Field Notes (@fieldnotes_ana) &#x2022; Instagram photos and videos">',
  `<main role="main"><div>
  <a href="/tom.c/p/CtomOne111/" role="link"><div><img alt="Scoring a batard" src="https://scontent.cdninstagram.com/v/tom1.jpg"></div></a>
</div></main>`);

export const PAGES = {
  [X_FEED_URL]: X_FEED, [X_POST_URL]: X_POST, [IG_FEED_URL]: IG_FEED, [IG_PROFILE_URL]: IG_PROFILE, [IG_POST_URL]: IG_POST, [IG_REEL_URL]: IG_REEL, [IG_KEPT_URL]: IG_KEPT, [IG_KEPT2_URL]: IG_KEPT2,
  [TT_PROFILE_URL]: TT_PROFILE, [TT_VIDEO_URL]: TT_VIDEO,
  [TT_FOR_YOU_URL]: TT_FOR_YOU, [TT_CINEMA_URL]: TT_CINEMA, [IG_REELS_URL]: IG_REELS,
  [IG_REELS_TAB_URL]: IG_REELS_TAB, [IG_REEL_DIALOG_URL]: IG_REEL_DIALOG, [IG_REEL_OVER_PROFILE_URL]: IG_REEL_OVER_PROFILE,
  [IG_NOCAPTION_URL]: IG_NOCAPTION, [IG_OVER_FEED_URL]: IG_OVER_FEED, [IG_PROFILE_STALE_URL]: IG_PROFILE_STALE,
};

/** Serve the stand-ins (and a plain picture for every picture address) in a Playwright context. */
export async function serveStandIns(context, pages = PAGES) {
  const byPage = new Map(Object.entries(pages).map(([url, html]) => [url.split('#')[0], html]));
  const html = route => {
    const body = byPage.get(route.request().url());
    return body === undefined ? route.fulfill({ status: 404, contentType: 'text/plain', body: 'not a stand-in page' })
      : route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
  };
  for (const site of ['https://x.com/**', 'https://twitter.com/**', 'https://www.instagram.com/**', 'https://www.tiktok.com/**']) await context.route(site, html);
  // Picture servers answer as CDNs do: anyone may read the files (the extension fetches them from the tab).
  for (const cdn of ['https://pbs.twimg.com/**', 'https://scontent.cdninstagram.com/**', 'https://p16-sign-va.tiktokcdn.com/**', 'https://p16-common-sign.tiktokcdn-us.com/**'])
    await context.route(cdn, route => route.fulfill(route.request().url().split('?')[0].endsWith('.mp4')
      ? { status: 200, contentType: 'video/mp4', body: MP4, headers: { 'Access-Control-Allow-Origin': '*' } }
      : { status: 200, contentType: 'image/png', body: PICTURE, headers: { 'Access-Control-Allow-Origin': '*' } }));
}
