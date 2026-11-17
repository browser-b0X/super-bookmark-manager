// Download buttons on posts, only on the sites the owner switched on in the extension's options (the browser
// asked for that site then). A small SuperBookmarks button on each post the page shows; a post is read only
// when the owner clicks its button, and the Save window opens for it (nothing is saved until Save there).
// It never scrolls, opens posts or reads anything in the background. With the check mark switched on too,
// the buttons of posts already saved turn green: the extension asks the app on this computer about the
// posts' addresses (only those). Switched off, the buttons go away from the open tabs too.
// Runs after readers.js, in the extension's own world: the page's scripts can't reach the buttons.
(() => {
  const readers = globalThis.sbmReaders;
  // `=== true` and the type check: a page element with id="sbmMarks" or "sbmReaders" also shows up as a global.
  if (globalThis.sbmMarks === true || !readers || typeof readers.cards !== "function") return;
  const site = readers.siteOf(location.hostname);
  if (!site) return;
  globalThis.sbmMarks = true;

  const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="16" height="16" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#9c8cf2"/><stop offset="1" stop-color="#4cc9f0"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="#1a1a2e"/>
    <g transform="translate(6.4 5.6) scale(.8)" fill="none" stroke="url(#g)" stroke-width="3.75" stroke-linecap="round" stroke-linejoin="round">
    <rect x="20" y="6" width="24" height="7" rx="2"/><path d="M22 13 v4 c-6 3 -9 8 -9 15 v18 a8 8 0 0 0 8 8 h22 a8 8 0 0 0 8 -8 v-18 c0 -7 -3 -12 -9 -15 v-4"/>
    <circle cx="32" cy="38" r="10"/><path d="M22 38 h20"/><path d="M32 28 c-4 3 -4 17 0 20 c4 -3 4 -17 0 -20"/></g></svg>`;
  // Drawn, not written: no text a page could find with its own search or selection.
  const CHECK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="#fff"
    stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const STYLE = `button{all:unset;box-sizing:border-box;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;
    justify-content:center;cursor:pointer;background:#fbfbfe;border:1px solid #cfc8ec;box-shadow:0 1px 3px rgba(0,0,0,.2)}
    button:hover,button:focus-visible{outline:2px solid #7c6cff;outline-offset:1px}button.saved{background:#1e8e3e;border-color:#1e8e3e}
    @media (prefers-color-scheme:dark){button:not(.saved){background:#171830;border-color:#3a3d63}}`;
  const TITLE = "Save to SuperBookmarks";
  const marked = new Map();          // card -> { host, button, url }
  const known = new Map();           // post address -> { saved, shelf }, while the page is open
  let stopped = false;

  // The fixed artwork above as DOM nodes (no innerHTML: Firefox's review flags it). Read as XML, so each piece
  // needs its xmlns: without it the element isn't SVG, takes no room, and the button is an empty circle.
  function svgNode(markup) {
    const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
    return document.importNode(doc.documentElement, true);
  }

  function show(entry) {
    const state = known.get(entry.url);
    const saved = !!(state && state.saved);
    if (entry.button.classList.contains("saved") !== saved || !entry.button.firstChild) {
      entry.button.classList.toggle("saved", saved);
      entry.button.replaceChildren(svgNode(saved ? CHECK : LOGO));
    }
    const label = saved ? `Already saved${state.shelf ? `, on ${state.shelf}` : ""} · click to open the Save window` : TITLE;
    entry.button.title = label;
    entry.button.setAttribute("aria-label", label);
  }

  function mark(card) {
    // A reel's button goes on its video, in the top left corner, above the player's own layers (readers.anchorOf).
    const anchor = typeof readers.anchorOf === "function" ? readers.anchorOf(card, site) : card;
    const host = document.createElement("span");
    host.setAttribute("data-sbm-mark", "");
    const corner = anchor !== card ? "left:8px;z-index:2147483000" : `right:${card.matches("article") ? 44 : 8}px;z-index:3`;
    host.style.cssText = `position:absolute;top:8px;${corner};width:28px;height:28px;display:block`;
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    const button = document.createElement("button");
    button.type = "button";
    root.append(style, button);
    // The page never sees these clicks (on X a click on a post opens it; on a grid the post is a link).
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick"]) {
      host.addEventListener(type, event => { event.stopPropagation(); if (type === "click") event.preventDefault(); });
    }
    button.addEventListener("click", event => {
      if (!event.isTrusted || stopped) return;    // only the owner's own click, never one a page script makes up
      const post = readers.postOf(card, site);
      if (!post) return;
      const here = readers.postAddress(location.href);
      try {
        chrome.runtime.sendMessage({ type: "save-post", post, title: here && here.url === post.url ? document.title : "" }).catch(() => {});
      } catch { /* the extension was reloaded: the buttons work again after a page reload */ }
    });
    if (getComputedStyle(anchor).position === "static") anchor.style.position = "relative";
    anchor.appendChild(host);
    const entry = { host, button, url: "" };
    marked.set(card, entry);
    return entry;
  }

  // Asking the app which posts are saved: at most once a second, whatever the page does.
  let asking = false;
  let lastAsk = 0;
  let again = null;                  // asked for meanwhile: sent when allowed
  let waitTimer = 0;
  let off = false;                   // no answer (check mark off, app not running): asked again only when the page is back in front
  function later(urls, refresh) {
    again = { urls: [...new Set([...(again ? again.urls : []), ...urls])], refresh: refresh || !!(again && again.refresh) };
    if (asking || waitTimer) return;
    waitTimer = setTimeout(() => {
      waitTimer = 0;
      const next = again;
      again = null;
      if (next) void ask(next.urls, next.refresh);
    }, Math.max(0, lastAsk + 1000 - Date.now()));
  }
  async function ask(urls, refresh) {
    if (stopped || !urls.length) return;
    if (asking || Date.now() - lastAsk < 1000) { later(urls, refresh); return; }
    if (off && !refresh) return;
    asking = true;
    lastAsk = Date.now();
    try {
      const items = await chrome.runtime.sendMessage({ type: "saved?", urls: urls.slice(0, 50) });
      off = !Array.isArray(items);
      if (!off) urls.slice(0, 50).forEach((url, i) => known.set(url, items[i] && items[i].saved ? items[i] : { saved: false }));
    } catch { off = true; /* the extension was reloaded: the buttons work again after a page reload */ }
    // No answer (the check mark was switched off, the app stopped): every button looks the same again.
    if (off) known.clear();
    asking = false;
    for (const entry of marked.values()) show(entry);
    if (again) later([], again.refresh);
  }

  function scan(refresh = false) {
    if (stopped) return;
    const fresh = [];
    const cards = new Set(readers.cards(site));
    for (const card of cards) {
      // A button the page took away when it redrew a post is put back.
      const had = marked.get(card);
      const entry = had && had.host.isConnected ? had : mark(card);
      // Only the address: a post card the page reused for another post shows that post's state.
      const url = readers.addressOf(card, site);
      if (url !== entry.url || !entry.button.firstChild) { entry.url = url; show(entry); }
      // A post without an address the page shows (TikTok's For You feed) can't be saved from here: no button for it.
      const display = url ? "block" : "none";
      if (entry.host.style.display !== display) entry.host.style.display = display;
      if (url && (refresh || !known.has(url)) && !fresh.includes(url)) fresh.push(url);
    }
    // A box that is no longer a post (Instagram's Reels tab groups its reels anew as more load) loses its button.
    for (const [card, entry] of marked) if (!cards.has(card)) { entry.host.remove(); marked.delete(card); }
    void ask(fresh, refresh);
  }

  let timer = 0;
  const soon = () => { clearTimeout(timer); timer = setTimeout(() => scan(), 400); };
  const observer = new MutationObserver(soon);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  // In Instagram's Reels tab the reel in view has the page's address: the button follows the scroll.
  addEventListener("scroll", soon, { capture: true, passive: true });
  // Back from the Save window (a post may have just been saved); a focus event a page script makes up doesn't count.
  const onFocus = event => { if (event.isTrusted) scan(true); };
  addEventListener("focus", onFocus);

  // Switched off in the options: the buttons leave this tab now, not at its next reload.
  chrome.storage.onChanged.addListener(changes => {
    if (!changes.marks || (changes.marks.newValue && changes.marks.newValue[site])) return;
    stopped = true;
    observer.disconnect();
    clearTimeout(timer);
    clearTimeout(waitTimer);
    removeEventListener("focus", onFocus);
    removeEventListener("scroll", soon, { capture: true });
    for (const entry of marked.values()) entry.host.remove();
    marked.clear();
    known.clear();
    globalThis.sbmMarks = false;    // switched on again, the extension puts the buttons back
  });
  scan();
})();
