// Post readers for X, Instagram and TikTok. They read what the page in the owner's tab already shows, and
// only when the owner clicks: the toolbar button (the extension puts this file in the tab then), or a
// post's Download button. They never scroll, open posts, fetch anything or look at cookies.
// A post is { url, site, author, handle, text, takenAt, pictures, video }; the app checks it all again.
(() => {
  // A page element with id="sbmReaders" also shows up as a global: only a real reader counts.
  if (globalThis.sbmReaders && typeof globalThis.sbmReaders.readPage === "function") return;
  const MAX_POSTS = 50;
  const MAX_PICTURES = 10;

  const textOf = (el, max = 5000) => (el ? (el.innerText || el.textContent || "") : "").replace(/ /g, " ").trim().slice(0, max);
  const meta = name => {
    const el = document.querySelector(`meta[property="${name}"]`) || document.querySelector(`meta[name="${name}"]`);
    return (el && el.getAttribute("content")) || "";
  };
  const https = url => typeof url === "string" && /^https:\/\//.test(url);
  /** The largest picture an <img> offers (its srcset), or what it shows. */
  const best = img => {
    const set = (img.getAttribute("srcset") || "").split(",").map(s => s.trim().split(/\s+/)).filter(p => p[0]);
    set.sort((a, b) => parseInt(b[1] || "0", 10) - parseInt(a[1] || "0", 10));
    return (set[0] && set[0][0]) || img.currentSrc || img.src || "";
  };
  const pictureList = (imgs, keep) => {
    const out = [];
    for (const img of imgs) {
      const src = best(img);
      if (https(src) && keep(img, src) && !out.includes(src)) out.push(src);
      if (out.length >= MAX_PICTURES) break;
    }
    return out;
  };

  /** One address per post (the spelling the library keeps) and a key that is the same for every spelling. */
  function postAddress(href) {
    let u;
    try { u = new URL(href, location.href); } catch { return null; }
    if (u.protocol !== "https:") return null;
    const host = u.hostname.toLowerCase();
    let m;
    if (/^(www\.|mobile\.)?(x|twitter)\.com$/.test(host) && (m = /^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,25})(?:\/|$)/.exec(u.pathname)))
      return { site: "x", url: `https://x.com/${m[1]}/status/${m[2]}`, key: `x:${m[2]}` };
    if (/^(www\.|m\.)?instagram\.com$/.test(host) && (m = /^\/(?:[A-Za-z0-9._]{1,30}\/)?(p|reels?|tv)\/(?!audio\/)([A-Za-z0-9_-]{5,64})(?:\/|$)/.exec(u.pathname)))
      return { site: "instagram", url: `https://www.instagram.com/${m[1] === "p" ? "p" : m[1] === "tv" ? "tv" : "reel"}/${m[2]}/`, key: `ig:${m[2]}` };
    if (/^(www\.|m\.)?tiktok\.com$/.test(host) && (m = /^\/@([A-Za-z0-9._]{1,40})\/(video|photo)\/(\d{5,25})(?:\/|$)/.exec(u.pathname)))
      return { site: "tiktok", url: `https://www.tiktok.com/@${m[1]}/${m[2]}/${m[3]}`, key: `tt:${m[3]}` };
    return null;
  }

  function siteOf(host) {
    host = String(host || "").toLowerCase();
    if (/^(www\.|mobile\.)?(x|twitter)\.com$/.test(host)) return "x";
    if (/^(www\.|m\.)?instagram\.com$/.test(host)) return "instagram";
    if (/^(www\.|m\.)?tiktok\.com$/.test(host)) return "tiktok";
    return null;
  }

  // ── X: each post is an <article data-testid="tweet">; a quoted post inside it is a box of its own ──
  const X_CARDS = 'article[data-testid="tweet"], article[role="article"]';
  /** Not inside the quoted post's box (that box is a div acting as a link). */
  const xOwn = (card, el) => {
    const box = el.parentElement && el.parentElement.closest('div[role="link"]');
    return !box || !card.contains(box);
  };
  /** The post's own address (the link around its time), not a quoted post's. */
  function xAddress(card) {
    let address = null;
    let time = null;
    for (const a of card.querySelectorAll('a[href*="/status/"]')) {
      if (!xOwn(card, a)) continue;
      const found = postAddress(a.getAttribute("href"));
      if (!found) continue;
      const stamp = a.querySelector("time[datetime]");
      if (stamp) { address = found; time = stamp; break; }
      address = address || found;
    }
    return { address, time };
  }
  function xPost(card) {
    const { address, time } = xAddress(card);
    if (!address) return null;
    const own = selector => [...card.querySelectorAll(selector)].filter(el => xOwn(card, el));
    const name = own('[data-testid="User-Name"]')[0];
    const handle = address.url.split("/")[3];
    const author = name ? (textOf(name, 400).split("\n").map(s => s.trim()).find(s => s && !s.startsWith("@")) || "") : "";
    const video = own('[data-testid="videoPlayer"], [data-testid="videoComponent"], video').length > 0;
    let pictures = pictureList(own('[data-testid="tweetPhoto"] img'), (_img, src) => /^https:\/\/pbs\.twimg\.com\/media\//.test(src));
    if (!pictures.length && video) {
      const poster = own("video[poster]").map(v => v.getAttribute("poster")).find(https);
      if (poster) pictures = [poster];
    }
    return { ...address, author: author.slice(0, 200), handle, text: textOf(own('[data-testid="tweetText"]')[0]),
      takenAt: time ? time.getAttribute("datetime") : "", pictures, video };
  }

  // ── Instagram: posts in the feed are <article>s; profile and explore grids are one link per post ──
  const IG_POST_LINKS = 'a[href*="/p/"], a[href*="/reel/"], a[href*="/reels/"], a[href*="/tv/"]';
  const IG_NOT_PEOPLE = new Set(["p", "reel", "reels", "tv", "explore", "stories", "direct", "accounts", "about", "legal", "web", "developer"]);
  // "/kit.a/", or "/kit.a/reels/": the Reels tab links each reel's creator to their reels (the owner's page, 2026-11-08).
  const igHandleOf = href => {
    const m = /^\/([A-Za-z0-9._]{1,30})(?:\/reels)?\/?$/.exec(href || "");
    return m && !IG_NOT_PEOPLE.has(m[1].toLowerCase()) ? m[1] : "";
  };
  /** The handle a link names, written from the site's root or in full. */
  const igLinkHandle = a => {
    try {
      const u = new URL(a.getAttribute("href") || "", location.href);
      return /^(www\.|m\.)?instagram\.com$/i.test(u.hostname) ? igHandleOf(u.pathname) : "";
    } catch { return ""; }
  };
  /** An address on one of these hosts (or under them), by its real host, https only. */
  const onHosts = (url, hosts) => {
    try {
      const u = new URL(url);
      return u.protocol === "https:" && hosts.test(u.hostname);
    } catch { return false; }
  };
  const IG_HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;
  const igFile = url => onHosts(url, IG_HOSTS);
  /** The address of a post's video file, from what the page already holds (nothing is fetched): the page's
   *  embedded data for that post (its widest "video_versions" entry), else a <video> playing a file inside the
   *  post itself (not another post's on the same page). */
  function igVideoUrl(root, address) {
    const code = address.key.slice(3);
    const find = (node, depth) => {
      if (!node || typeof node !== "object" || depth > 60) return "";
      if ((node.code === code || node.shortcode === code) && Array.isArray(node.video_versions)) {
        const best = node.video_versions.filter(v => v && igFile(v.url)).sort((a, b) => (b.width || 0) - (a.width || 0))[0];
        if (best) return best.url;
      }
      for (const value of Array.isArray(node) ? node : Object.values(node)) {
        const found = find(value, depth + 1);
        if (found) return found;
      }
      return "";
    };
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      const text = script.textContent || "";
      if (!text.includes(code) || !text.includes("video_versions")) continue;
      try {
        const found = find(JSON.parse(text), 0);
        if (found) return found;
      } catch { /* not this one */ }
    }
    if (root === document) return "";
    return [...root.querySelectorAll("video[src]")].map(v => v.getAttribute("src")).find(igFile) || "";
  }
  /** "Ana Field Notes (@fieldnotes_ana) • Instagram photos and videos" or "Ana Field Notes on Instagram: …"; a title
   *  that names nobody ("Instagram") gives "". */
  const igAuthorFromTitle = () => {
    const title = meta("og:title");
    const cut = title.search(/ \(@| on Instagram/);
    return cut > 0 ? title.slice(0, cut).trim() : "";
  };
  /** The name a profile's page gives its owner, from the tab's title or the page's tags, only when they name this
   *  handle: after a click from one profile to the next, the tags can still be the first one's. */
  const igProfileName = handle => {
    for (const title of [document.title, meta("og:title")]) {
      const m = /^(?:\(\d+\+?\)\s*)?(.*?) \(@([A-Za-z0-9._]{1,30})\)/.exec(title || "");
      if (m && m[2].toLowerCase() === handle.toLowerCase()) return m[1].trim().slice(0, 200);
    }
    return "";
  };
  /** A post's picture: from Instagram's picture servers, and not somebody's profile picture (its label says so only in
   *  English, so also: a picture shown small), an emoji, or the cover of a reel's audio. */
  const igPicture = (img, src) => {
    if ((img.getAttribute("alt") || "").toLowerCase().includes("profile picture") || img.closest('a[href*="/audio/"]')) return false;
    if (img.naturalWidth && img.naturalWidth < 150) return false;
    const shown = img.getBoundingClientRect().width;
    return !(shown && shown < 80) && igFile(src);
  };
  function igTile(link, media) {
    const address = postAddress(link.getAttribute("href"));
    if (!address) return null;
    const img = link.querySelector("img");
    const pathHandle = igHandleOf("/" + ((link.getAttribute("href") || "").split("/").filter(Boolean)[0] || "") + "/");
    const pageHandle = igHandleOf(location.pathname);
    return { ...address, author: pageHandle ? igProfileName(pageHandle) : "", handle: pathHandle || pageHandle,
      text: img ? (img.getAttribute("alt") || "").trim().slice(0, 5000) : "", takenAt: "",
      pictures: img ? pictureList([img], igPicture) : [],
      video: address.url.includes("/reel/") || !!link.querySelector('svg[aria-label="Clip"], svg[aria-label="Reel"], svg[aria-label="Video"]'),
      videoUrl: media ? igVideoUrl(link, address) : "" };
  }
  function igArticleAddress(card) {
    const links = [...card.querySelectorAll(IG_POST_LINKS)];
    const link = links.find(a => a.querySelector("time[datetime]")) || links[0];
    // A post's own page shows it without a link to itself.
    return link ? postAddress(link.getAttribute("href")) : postAddress(location.href);
  }
  /** A link to the post itself ("/p/CODE/"), not to something under it (a comment: "/p/CODE/c/…"). */
  const igOwnLink = (a, address) => {
    try {
      const u = new URL(a.getAttribute("href") || "", location.href);
      return /^\/(?:[A-Za-z0-9._]{1,30}\/)?(?:p|reels?|tv)\/[A-Za-z0-9_-]+\/?$/.test(u.pathname) && (postAddress(u.href) || {}).key === address.key;
    } catch { return false; }
  };
  /** Do the page's own tags (og:…) describe this post? Only when og:url names it: a post opened over a profile or the
   *  feed, or a reel scrolled to in the Reels tab, leaves them describing the page as it was opened. */
  const igTagsName = address => !!meta("og:url") && (postAddress(meta("og:url")) || {}).key === address.key;
  /** A post with no picture where it's shown (a reel opened over a profile or the feed, 2026-11-08): the same post's
   *  tile or card elsewhere on the page has its cover. */
  function igCoverElsewhere(card, address) {
    for (const link of document.querySelectorAll(IG_POST_LINKS)) {
      if (card.contains(link) || (postAddress(link.getAttribute("href")) || {}).key !== address.key) continue;
      const box = link.closest("article") || link;
      if (box.contains(card)) continue;
      const pictures = pictureList(box.querySelectorAll("img"), igPicture);
      const poster = [...box.querySelectorAll("video[poster]")].map(v => v.getAttribute("poster")).find(p => https(p) && igFile(p));
      if (pictures.length || poster) return pictures.length ? pictures : [poster];
    }
    return [];
  }
  /** A feed post, or (given its address) a reel in the Reels tab, read the same way. */
  function igArticle(card, media, address = igArticleAddress(card)) {
    if (!address) return null;
    const handle = [...card.querySelectorAll("a[href]")].map(igLinkHandle).find(Boolean) || "";
    // Its own time: the one in the link to the post itself (a comment's time links to the comment), else the first.
    const time = [...card.querySelectorAll(IG_POST_LINKS)].filter(a => igOwnLink(a, address))
      .map(a => a.querySelector("time[datetime]")).find(Boolean) || card.querySelector("time[datetime]");
    // The caption: a post's own heading. Where the post is shown whole (opened over a page, or on its own page), that is
    // all: the lines under it are other people's comments. In a feed: the longest line that isn't a name, a link or a button.
    let caption = textOf(card.querySelector("h1"));
    const whole = !!card.closest('[role="dialog"]')
      || (card.matches("article") && address.key === (postAddress(location.href) || {}).key && !/^\/reels\//.test(location.pathname));
    if (!caption && !whole) {
      for (const el of card.querySelectorAll('span[dir="auto"], div[dir="auto"]')) {
        if (el.closest("a, button, time, header")) continue;
        const t = textOf(el);
        if (t.length > caption.length && t !== handle) caption = t;
      }
    }
    // The Reels tab (2026-11-08) may keep a reel's caption as plain text between <br>s, without dir="auto": the longest
    // text of a few words written right in one box (not in a link, a button or a time; a count is one word).
    if (!caption && !card.matches("article")) {
      let most = 0;
      for (const el of card.querySelectorAll("div, span")) {
        if (el.closest("a, button, time, header")) continue;
        const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(" ").trim();
        if (own.length > most && /\S\s+\S/.test(own) && own !== handle) { most = own.length; caption = textOf(el); }
      }
    }
    let pictures = pictureList(card.querySelectorAll("img"), igPicture);
    const poster = [...card.querySelectorAll("video[poster]")].map(v => v.getAttribute("poster")).find(https);
    if (!pictures.length && poster && igFile(poster)) pictures = [poster];
    if (!pictures.length) pictures = igCoverElsewhere(card, address);
    if (!pictures.length && igTagsName(address) && igFile(meta("og:image"))) pictures = [meta("og:image")];
    const videoUrl = media ? igVideoUrl(card, address) : "";
    return { ...address, author: handle, handle, text: caption, takenAt: time ? time.getAttribute("datetime") : "",
      pictures, video: !!card.querySelector("video") || !!videoUrl, videoUrl };
  }
  // The Reels tab (the owner's page, 2026-11-08) has no <article>s: each reel is a box around its own <video>, the
  // highest one holding no other video, and only the reel in view has an address: the page's, which follows the scroll.
  function igReelItems() {
    if (!/^\/reels?\//.test(location.pathname)) return [];
    const items = [];
    for (const video of document.querySelectorAll("main video")) {
      if (video.closest("article")) continue;
      let item = video;
      while (item.parentElement && item.parentElement.localName !== "main" && item.parentElement.querySelectorAll("video").length === 1) {
        item = item.parentElement;
      }
      if (item !== video && !items.includes(item)) items.push(item);
    }
    return items;
  }
  function igReelAddress(item) {
    // Its own dated link, as a feed post has, if Instagram gives it one; links to other posts (a remix's original) aren't its own.
    const dated = [...item.querySelectorAll(IG_POST_LINKS)].find(a => a.querySelector("time[datetime]") && postAddress(a.getAttribute("href")));
    if (dated) return postAddress(dated.getAttribute("href"));
    // The reel the owner is watching: each one is about as tall as the window, and that one covers its middle.
    const here = postAddress(location.href);
    const box = item.getBoundingClientRect();
    return here && here.site === "instagram" && box.top <= innerHeight / 2 && box.bottom > innerHeight / 2 ? here : null;
  }

  /** The open post, the way the bookmark button reads it. In the Reels viewer (2026) the post is one of several
   *  <article>s, none with a header or a heading, or in the Reels tab one of several boxes: the one that is this post,
   *  read like a feed post. */
  function igOpenPost(address) {
    // A post opened over a page is the one in the dialog: its card in the feed behind has a shortened caption, and the
    // first card there is another post.
    const own = document.querySelector('[role="dialog"] article') || [...document.querySelectorAll("article")].find(card =>
      [...card.querySelectorAll(IG_POST_LINKS)].some(a => (postAddress(a.getAttribute("href")) || {}).key === address.key))
      || igReelItems().find(item => (igReelAddress(item) || {}).key === address.key);
    const root = own || document.querySelector("main article") || document.querySelector("article") || document.querySelector("main") || document;
    const article = root !== document && (root === own || root.matches("article")) ? igArticle(root, false, address) : null;
    // The page's own tags describe the page as it was opened (igTagsName). A page without og:url keeps the old rule, except
    // for a reel in the Reels tab.
    const reel = !!own && !own.matches("article");
    const tagsOwn = meta("og:url") ? igTagsName(address) : !reel;
    let pictures = pictureList(root.querySelectorAll("img"), igPicture);
    const poster = [...root.querySelectorAll("video[poster]")].map(v => v.getAttribute("poster")).find(p => https(p) && igFile(p));
    if (!pictures.length && poster) pictures = [poster];
    if (!pictures.length && root !== document) pictures = igCoverElsewhere(root, address);
    if (!pictures.length && tagsOwn && https(meta("og:image"))) pictures = [meta("og:image")];
    const handleLink = root.querySelector('header a[href^="/"]');
    const handle = (handleLink ? igHandleOf("/" + (handleLink.getAttribute("href").split("/").filter(Boolean)[0] || "") + "/") : "")
      || (article ? article.handle : "");
    const time = article ? null : root.querySelector("time[datetime]");
    const videoUrl = igVideoUrl(root, address);
    return { ...address, author: ((tagsOwn && igAuthorFromTitle()) || handle).slice(0, 200), handle,
      text: (textOf(root.querySelector("h1")) || (tagsOwn && meta("og:description")) || (article ? article.text : "")).slice(0, 5000),
      takenAt: article ? article.takenAt : time ? time.getAttribute("datetime") : "", pictures,
      video: !!root.querySelector("video") || !!videoUrl, videoUrl };
  }

  // ── TikTok: grid items and feed items carry data-e2e names; the open video has its own ──
  const TT_CARDS = ['[data-e2e="user-post-item"]', '[data-e2e="user-liked-item"]', '[data-e2e="search_top-item"]',
    '[data-e2e="search_video-item"]', '[data-e2e="challenge-item"]', '[data-e2e="music-item"]', '[data-e2e="recommend-list-item-container"]'].join(", ");
  const TT_LINKS = 'a[href*="/video/"], a[href*="/photo/"]';
  /** A grid picture's text is "<caption> created by <name> with <sound>". */
  const ttAlt = alt => {
    const m = /^([\s\S]*?) created by (.+?) with .*$/.exec(alt || "");
    return m ? { text: m[1].trim(), author: m[2].trim() } : { text: (alt || "").trim(), author: "" };
  };
  const ttPicture = (_img, src) => onHosts(src, /(^|\.)(tiktokcdn(-us|-eu)?\.com|ibyteimg\.com|byteimg\.com)$/i);
  /** The creator's name in TikTok's 2026 layout, which has no data-e2e for it: the creator link's text on a video's own
   *  card, or in the For You feed's panel. */
  const ttCreatorName = root => textOf(root.querySelector('[class*="DivCreatorInfoContainer"] a p, [class*="DivCreatorUsername"] a p'), 200);
  /** A video's cover: its poster, or (2026) the picture its player shows before it plays. */
  const ttCover = root => [...root.querySelectorAll("video[poster]")].map(v => v.getAttribute("poster")).find(https)
    || [...root.querySelectorAll('[data-e2e="feed-video"] picture img')].map(best).find(https) || "";
  function ttAddress(card) {
    const link = card.matches(TT_LINKS) ? card : [...card.querySelectorAll(TT_LINKS)].find(a => postAddress(a.getAttribute("href")));
    if (link) return postAddress(link.getAttribute("href"));
    // A video's own page shows it without a link to itself (2026): the first player on that page is the open video. In
    // the For You feed no video has its address on the page.
    const here = postAddress(location.href);
    const first = document.querySelector('[data-e2e="feed-video"]');
    return here && here.site === "tiktok" && first && card.contains(first) ? here : null;
  }
  function ttPost(card) {
    const address = ttAddress(card);
    if (!address) return null;
    const img = card.querySelector("img");
    const alt = ttAlt(img && img.getAttribute("alt"));
    const desc = card.querySelector('[data-e2e="video-desc"], [data-e2e="search-card-video-caption"], [data-e2e="search-card-desc"]');
    const handle = address.url.split("/@")[1].split("/")[0];
    const nickname = textOf(card.querySelector('[data-e2e="video-author-nickname"], [data-e2e="search-card-user-nickname"]'), 200);
    const pageName = handle.toLowerCase() === (location.pathname.split("/@")[1] || "").split("/")[0].toLowerCase()
      ? textOf(document.querySelector('[data-e2e="user-subtitle"]'), 200) : "";
    return { ...address, author: nickname || ttCreatorName(card) || alt.author || pageName, handle, text: desc ? textOf(desc) : alt.text.slice(0, 5000),
      takenAt: "", pictures: img ? pictureList([img], ttPicture) : [], video: address.url.includes("/video/") };
  }
  function ttOpenPost(address) {
    const desc = document.querySelector('[data-e2e="browse-video-desc"], [data-e2e="video-desc"]');
    const nick = document.querySelector('[data-e2e="browser-nickname"], [data-e2e="video-author-nickname"]');
    const player = document.querySelector('[data-e2e="feed-video"]');
    const card = (player && player.closest(TT_CARDS)) || document;
    const nickname = nick ? textOf(nick.querySelector("span") || nick, 200) : ttCreatorName(card);
    const cover = ttCover(document) || meta("og:image");
    return { ...address, author: nickname, handle: address.url.split("/@")[1].split("/")[0],
      text: textOf(desc), takenAt: "", pictures: https(cover) && ttPicture(null, cover) ? [cover] : [],
      video: address.url.includes("/video/") };
  }

  /** The post cards on the page, in page order (each one once). */
  function cards(site = siteOf(location.hostname)) {
    if (site === "x") return [...document.querySelectorAll(X_CARDS)];
    if (site === "instagram") {
      const tiles = [...document.querySelectorAll(IG_POST_LINKS)]
        .filter(a => !a.closest("article") && a.querySelector("img") && postAddress(a.getAttribute("href")));
      return [...document.querySelectorAll("article"), ...igReelItems(), ...tiles];
    }
    if (site === "tiktok") {
      const items = [...document.querySelectorAll(TT_CARDS)];
      const loose = [...document.querySelectorAll(TT_LINKS)].filter(a => !a.closest(TT_CARDS));
      return [...items, ...loose];
    }
    return [];
  }

  /** What one card shows, or null when it isn't a post. `media`: also the address of an Instagram post's video
   *  (for saving that one post; a list never looks for media). */
  function postOf(card, site = siteOf(location.hostname), media = true) {
    if (site === "x") return xPost(card);
    if (site === "instagram") {
      return card.matches("article") ? igArticle(card, media) : card.matches("a") ? igTile(card, media) : igArticle(card, media, igReelAddress(card));
    }
    if (site === "tiktok") return ttPost(card);
    return null;
  }

  /** Only a card's post address (for the Download buttons' "already saved"): nothing else is read. */
  function addressOf(card, site = siteOf(location.hostname)) {
    let address = null;
    if (site === "x") address = xAddress(card).address;
    else if (site === "instagram") {
      address = card.matches("article") ? igArticleAddress(card) : card.matches("a") ? postAddress(card.getAttribute("href")) : igReelAddress(card);
    }
    else if (site === "tiktok") address = ttAddress(card);
    return address ? address.url : "";
  }

  /** Where a post's Download button goes: on the post's own box, except for a reel (in the Reels tab, or opened in a
   *  dialog, which cuts off its article's corner): on the box its video plays in, the largest one of the video's size. */
  function anchorOf(card, site = siteOf(location.hostname)) {
    if (site !== "instagram" || card.matches("a") || (card.matches("article") && !card.closest('[role="dialog"]'))) return card;
    const video = card.querySelector("video");
    const size = video && video.getBoundingClientRect();
    if (!size || !size.width || !size.height) return card;
    let frame = video.parentElement;
    for (let el = video.parentElement; el && el !== card; el = el.parentElement) {
      const box = el.getBoundingClientRect();
      if (Math.abs(box.width - size.width) > 2 || Math.abs(box.height - size.height) > 2) break;
      frame = el;
    }
    return frame;
  }

  const plain = post => post && { url: post.url, site: post.site, author: post.author, handle: post.handle, text: post.text,
    takenAt: post.takenAt, pictures: post.pictures, video: post.video, ...(post.videoUrl ? { videoUrl: post.videoUrl } : {}) };

  /** The open post (on a post's own page), or the posts already loaded on a profile, feed or search page. */
  function readPage() {
    const site = siteOf(location.hostname);
    const page = { url: location.href, title: document.title };
    if (!site) return { site: null, page, single: null, posts: [] };
    const here = postAddress(location.href);
    if (here) {
      let single = null;
      if (site === "instagram") single = igOpenPost(here);
      else if (site === "tiktok") single = ttOpenPost(here);
      else single = cards(site).map(card => xPost(card)).find(post => post && post.key === here.key) || null;
      return { site, page, single: plain(single || { ...here, author: "", handle: "", text: "", takenAt: "", pictures: [], video: false }), posts: [] };
    }
    const posts = [];
    const seen = new Set();
    for (const card of cards(site)) {
      const post = postOf(card, site, false);
      if (!post || seen.has(post.key)) continue;
      seen.add(post.key);
      posts.push(plain(post));
      if (posts.length >= MAX_POSTS) break;
    }
    return { site, page, single: null, posts };
  }

  globalThis.sbmReaders = { readPage, cards, postOf: (card, site) => plain(postOf(card, site)), addressOf, anchorOf, postAddress, siteOf };
})();
