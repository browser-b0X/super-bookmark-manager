// SuperBookmarks extension: the toolbar button and the right-click entry open the app's Save window
// (the app's own page, so nothing is saved until the owner clicks Save there). On X, Instagram and
// TikTok the toolbar button first reads the tab (readers.js, put there by the click: activeTab) and
// hands the open post, or the posts loaded on the page, to that window; for one Instagram post it also
// fetches the post's pictures and video in that tab (media.js) and passes them on as files. On the sites the owner switches
// on in the options (each asked for then), marks.js puts a Download button on every post. With the
// owner's "check mark" switch on (and the tab-address permission granted then), the button shows a
// check on pages already saved, and saved posts' Download buttons turn green: the extension asks the
// app on this computer, never anything else. While SuperBookmarks isn't running, what the owner saves is
// kept in the extension (queue.js), the button shows how many wait, and the next Save window hands them over.
// One file for Chrome (service worker) and Firefox (event page).

// Chrome runs this as a service worker (verify.js and queue.js come in here); Firefox loads them first itself.
if (typeof importScripts === "function") importScripts("verify.js", "queue.js");

const DEFAULTS = { app: "http://127.0.0.1:5001", token: "", connId: "", checkMark: false, marks: { x: false, instagram: false, tiktok: false } };
const TITLE = "Save to SuperBookmarks";
// The sites whose posts can get a Download button: each one asked for when the owner switches it on.
const SITES = {
  x: ["https://x.com/*", "https://twitter.com/*"],
  instagram: ["https://www.instagram.com/*"],
  tiktok: ["https://www.tiktok.com/*"],
};

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
}

function setupMenu() {
  chrome.contextMenus.removeAll(async () => {
    chrome.contextMenus.create({ id: "save-link", title: "Save link to SuperBookmarks", contexts: ["link"] });
    // Only once the owner turns it on in the options (For support).
    const { structureMenu } = await chrome.storage.local.get("structureMenu");
    if (structureMenu) {
      chrome.contextMenus.create({ id: "structure", title: "Copy page structure (for SuperBookmarks support)",
        contexts: ["page", "link", "image", "video", "selection"] });
    }
  });
}

/** What this tab's page is built of, without anything it says or links to (snapshot.js), in a window to copy it from. */
async function copyStructure(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["readers.js", "snapshot.js"] });
  const [done] = await chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.sbmSnapshot() });
  await chrome.storage.local.set({ snapshot: String((done && done.result) || "") });
  return chrome.windows.create({ url: chrome.runtime.getURL("snapshot.html"), type: "popup", width: 680, height: 680 });
}

/** The app's Save window for this address, in a small window of its own. With `posts` (what readers.js read),
 *  the window is told to wait for them, and a small script hands them over from inside it. `source`: the tab
 *  an Instagram post was read in, to fetch its pictures and video from when the window asks. */
async function openSaveWindow(url, title, posts = null, source = null) {
  const { app, connId, token } = await settings();
  const web = typeof url === "string" && /^https?:\/\//i.test(url);
  // Posts, this page's address and anything kept for later go only to the app this browser paired with, once it has
  // proved itself. Otherwise they are kept for later, and the app's address isn't opened at all: a page from whatever
  // answers there would load in this browser. Before pairing there is nothing to prove with, so nothing is sent and
  // nothing is kept: the extension's own window says how to pair.
  if (!token) return openKept("pair");
  const proof = await checkApp(app, connId, token);
  if (proof !== "ok") return web ? keepWhileAway(url, title, posts, source, proof) : openKept(`list&why=${proof}`);
  const kept = await readQueue();
  const payload = posts || kept.items.length
    ? { single: posts ? posts.single : null, posts: posts ? posts.posts : [], waiting: kept.items, notices: kept.notices } : null;
  const query = web ? `?url=${encodeURIComponent(url.slice(0, 4096))}&title=${encodeURIComponent(String(title || "").slice(0, 500))}${payload ? "&from=extension" : ""}` : "";
  const media = web && posts && posts.single && source !== null ? startMedia(source, posts.single) : null;
  const win = await chrome.windows.create({ url: `${app}/add${query}`, type: "popup", width: 480, height: 640 });
  const tabId = win.tabs && win.tabs[0] && win.tabs[0].id;
  if (media && tabId !== undefined) waiting.set(tabId, media);
  if (web && payload && tabId !== undefined) await handOver(tabId, app, payload).catch(() => {});
  return win;
}

/** SuperBookmarks isn't there to take it (`why`, from checkApp): keep the open post (its files from the tab) or the
 *  page, and say so. A feed's list isn't kept: nothing was chosen yet. */
async function keepWhileAway(url, title, posts, source, why) {
  if (posts && !posts.single && posts.posts && posts.posts.length) return openKept(`list&why=${why}`);
  const single = posts && posts.single ? posts.single : null;
  const blobs = new Map();
  const files = [];
  const media = single && source !== null ? startMedia(source, single) : null;
  if (media) {
    for (const item of await media.fetched) {
      if (item.error) continue;
      const blob = await pullFile(source, item).catch(() => null);
      if (blob) { blobs.set(item.url, blob); files.push(item); }
    }
    chrome.scripting.executeScript({ target: { tabId: source }, func: () => globalThis.sbmMedia && globalThis.sbmMedia.drop() }).catch(() => {});
  }
  const items = await keepForLater({ url: single ? single.url : url, title, single, files }, blobs);
  await showQueue(items);
  return openKept(`kept=${encodeURIComponent(queueName({ single, title }))}&why=${why}`);
}

function openKept(hash) {
  return chrome.windows.create({ url: chrome.runtime.getURL(`kept.html#${hash}`), type: "popup", width: 480, height: 300 });
}

/** One fetched file from the tab, as a Blob (for keeping). */
async function pullFile(source, item) {
  const parts = [];
  for (let start = 0; start < item.size; start += CHUNK) {
    const [piece] = await chrome.scripting.executeScript({ target: { tabId: source }, args: [item.url, start, Math.min(item.size, start + CHUNK)],
      func: (url, a, b) => globalThis.sbmMedia.chunk(url, a, b) });
    if (!piece || typeof piece.result !== "string") return null;
    const binary = atob(piece.result);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    parts.push(bytes);
  }
  return new Blob(parts, { type: item.type || "" });
}

async function base64Of(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** How many wait, on the button (every tab; a tab's own check mark still wins there). */
async function showQueue(items) {
  const count = items.length;
  await chrome.action.setBadgeBackgroundColor({ color: "#b45309" }).catch(() => {});
  await chrome.action.setBadgeText({ text: count ? String(count) : "" }).catch(() => {});
  await chrome.action.setTitle({ title: count ? `SuperBookmarks: ${count} waiting for the app` : TITLE }).catch(() => {});
}

// ── An Instagram post's pictures and video, from the tab it was read in to the Save window ──
const CHUNK = 2 * 1024 * 1024;
const waiting = new Map();           // Save window tab -> { source, post, fetched }

/** Start fetching one Instagram post's files in its tab (media.js); null when there's nothing to fetch. */
function startMedia(source, post) {
  if (post.site !== "instagram") return null;
  const items = [...(post.pictures || []).slice(0, 10).map(url => ({ url, kind: "picture" })),
    ...(post.videoUrl ? [{ url: post.videoUrl, kind: "video" }] : [])];
  if (!items.length) return null;
  const fetched = chrome.scripting.executeScript({ target: { tabId: source }, files: ["media.js"] })
    .then(() => chrome.scripting.executeScript({ target: { tabId: source }, func: list => globalThis.sbmMedia.fetchAll(list), args: [items] }))
    .then(([done]) => (done && Array.isArray(done.result) ? done.result : items.map(item => ({ ...item, error: "unavailable" }))))
    .catch(() => items.map(item => ({ ...item, error: "unavailable" })));
  return { source, post: post.url, fetched };
}

/** The window asked for posts' files: the open post's from its tab, kept posts' from the extension's storage;
 *  each in pieces (or why it can't come). */
async function sendMedia(windowTab, posts) {
  // Files go only to the app this browser paired with: it proves itself again first.
  const { app, connId, token } = await settings();
  if (await checkApp(app, connId, token) !== "ok") return;
  const job = waiting.get(windowTab);
  if (job && posts.includes(job.post)) await sendTabMedia(windowTab, job);
  const { items } = await readQueue();
  for (const item of items.filter(entry => posts.includes(entry.url) && (!job || entry.url !== job.post))) {
    const tell = message => chrome.tabs.sendMessage(windowTab, { post: item.url, ...message });
    for (const file of (item.files || []).filter(f => !f.dropped)) {
      try {
        const blob = await getQueueFile(file.fileId);
        if (!blob) throw new Error("gone");
        for (let start = 0; start < blob.size; start += CHUNK) {
          const end = Math.min(blob.size, start + CHUNK);
          await tell({ type: "media-chunk", url: file.url, kind: file.kind, mime: file.type, total: blob.size, data: await base64Of(blob.slice(start, end)), last: end >= blob.size });
        }
      } catch {
        await tell({ type: "media-failed", url: file.url, kind: file.kind, error: "unavailable", total: file.size }).catch(() => {});
      }
    }
  }
}

async function sendTabMedia(windowTab, job) {
  waiting.delete(windowTab);
  const tell = message => chrome.tabs.sendMessage(windowTab, { post: job.post, ...message });
  for (const item of await job.fetched) {
    if (item.error) { await tell({ type: "media-failed", url: item.url, kind: item.kind, error: item.error, total: item.size || 0 }).catch(() => {}); continue; }
    let sent = false;
    try {
      for (let start = 0; start < item.size; start += CHUNK) {
        const end = Math.min(item.size, start + CHUNK);
        const [piece] = await chrome.scripting.executeScript({ target: { tabId: job.source }, args: [item.url, start, end],
          func: (url, a, b) => globalThis.sbmMedia.chunk(url, a, b) });
        if (!piece || typeof piece.result !== "string") throw new Error("gone");
        await tell({ type: "media-chunk", url: item.url, kind: item.kind, mime: item.type, total: item.size, data: piece.result, last: end >= item.size });
      }
      sent = true;
    } catch { /* the tab or the window went away */ }
    if (!sent) await tell({ type: "media-failed", url: item.url, kind: item.kind, error: "unavailable", total: item.size }).catch(() => {});
  }
  chrome.scripting.executeScript({ target: { tabId: job.source }, func: () => globalThis.sbmMedia && globalThis.sbmMedia.drop() }).catch(() => {});
}

/** Is this the app's Save window (where the extension's helper runs)? */
async function fromSaveWindow(sender) {
  try {
    const { app } = await settings();
    const url = new URL(sender.url);
    return url.origin === new URL(app).origin && url.pathname === "/add";
  } catch { return false; }
}

/** The toolbar button. On X, Instagram or TikTok: read the open post, or the posts already loaded on the page,
 *  in this tab only and only now (the click lets the extension in: activeTab); anywhere else, the page itself. */
async function saveFromTab(tab) {
  let read = null;
  if (tab && tab.id !== undefined && siteOf(tab.url)) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["readers.js"] });
      const [done] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => globalThis.sbmReaders.readPage() });
      read = done && done.result;
    } catch { read = null; }   // the page didn't let the reader in: save the page as usual
  }
  if (read && read.single) return openSaveWindow(read.single.url, tab.title, { single: read.single, posts: [] }, tab.id);
  if (read && read.posts && read.posts.length) return openSaveWindow(tab.url, tab.title, { single: null, posts: read.posts });
  return openSaveWindow(tab && tab.url, tab && tab.title);
}

function siteOf(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return /^(www\.|mobile\.)?(x|twitter)\.com$|^(www\.|m\.)?instagram\.com$|^(www\.|m\.)?tiktok\.com$/.test(host);
  } catch { return false; }
}

/** Until the tab has loaded its page (at most 15 seconds): a web page, since a browser can call a new tab's first,
 *  empty page loaded before it goes to the app's. */
function loaded(tabId) {
  return new Promise(resolve => {
    let timer = 0;
    const done = () => { chrome.tabs.onUpdated.removeListener(listen); clearTimeout(timer); resolve(); };
    const there = tab => !!tab && tab.status === "complete" && typeof tab.url === "string" && tab.url.startsWith("http");
    const listen = (id, change, tab) => { if (id === tabId && change.status === "complete" && there(tab)) done(); };
    chrome.tabs.onUpdated.addListener(listen);
    timer = setTimeout(done, 15000);
    chrome.tabs.get(tabId).then(tab => { if (there(tab)) done(); }).catch(done);
  });
}

/** Put the extension's helper (handover.js) in the Save window (the app's own page at the app's address): it
 *  answers the window's "ready" with the posts and passes files on. The window takes those messages only from
 *  itself, so no website can send it posts. */
async function handOver(tabId, app, posts) {
  await loaded(tabId);
  await chrome.scripting.executeScript({ target: { tabId }, files: ["handover.js"] });
  // The check and the hand-over in one call: the window is still the paired app's Save window at that moment.
  await chrome.scripting.executeScript({ target: { tabId }, args: [posts, new URL(app).origin],
    func: (payload, origin) => location.pathname === "/add" && !!globalThis.sbmHandover && globalThis.sbmHandover.start(payload, origin) });
}

/** The check mark: only with the switch on, a pairing token and a web page. */
async function checkTab(tabId, url) {
  const s = await settings();
  // No check mark: the tab shows what every tab shows (how many wait for the app, if any). Chrome can't reset a
  // tab's title, so it gets the current one for every tab.
  const clear = async () => {
    await chrome.action.setBadgeText({ tabId, text: null });
    await chrome.action.setTitle({ tabId, title: await chrome.action.getTitle({}) });
  };
  if (!s.checkMark || !s.token || typeof url !== "string" || !/^https?:\/\//i.test(url)) return clear();
  // Nothing (not the token, not the address) goes to a program that isn't the paired app.
  if (await checkApp(s.app, s.connId, s.token) !== "ok") return clear();
  try {
    const response = await fetch(`${s.app}/api/extension/status?url=${encodeURIComponent(url.slice(0, 4096))}`,
      { headers: { "X-SBM-Pair": s.token }, cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.saved) return clear();
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#1e8e3e" });
    await chrome.action.setBadgeText({ tabId, text: "✓" });
    await chrome.action.setTitle({ tabId, title: `SuperBookmarks: already saved${data.shelf ? `, on ${data.shelf}` : ""}` });
    return true;
  } catch {
    return clear();    // the app isn't running: no check mark, no message
  }
}

/** The Download buttons: marks.js on each site the owner switched on and the browser allows. Sites switched on just
 *  now get the buttons in their open tabs too. One at a time (a switch fires both a permission and a storage event). */
let syncing = Promise.resolve();
function syncMarks() {
  syncing = syncing.then(syncMarksNow, syncMarksNow);
  return syncing;
}
async function syncMarksNow() {
  const { marks } = await settings();
  const want = [];
  for (const [site, origins] of Object.entries(SITES)) {
    if (marks && marks[site] && await chrome.permissions.contains({ origins }).catch(() => false)) {
      want.push({ id: `marks-${site}`, matches: origins, js: ["readers.js", "marks.js"], runAt: "document_idle" });
    }
  }
  const have = (await chrome.scripting.getRegisteredContentScripts()).map(s => s.id).filter(id => id.startsWith("marks-"));
  const drop = have.filter(id => !want.some(w => w.id === id));
  if (drop.length) await chrome.scripting.unregisterContentScripts({ ids: drop });
  const add = want.filter(w => !have.includes(w.id));
  if (add.length) await chrome.scripting.registerContentScripts(add);
  for (const script of add) {
    for (const tab of await chrome.tabs.query({ url: script.matches })) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: script.js }).catch(() => {});
    }
  }
}

/** Which of these posts are saved, for the Download buttons: only with the check mark switched on, and only from
 *  the paired app (it proves itself first). Null when there's no answer to give. */
async function savedPosts(urls) {
  const s = await settings();
  if (!s.checkMark || !s.token || !Array.isArray(urls) || !urls.length) return null;
  if (await checkApp(s.app, s.connId, s.token) !== "ok") return null;
  try {
    const response = await fetch(`${s.app}/api/extension/saved`, {
      method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", "X-SBM-Pair": s.token },
      body: JSON.stringify({ urls: urls.slice(0, 50).map(u => String(u).slice(0, 4096)) }),
    });
    const data = await response.json();
    return response.ok && Array.isArray(data.items) ? data.items : null;
  } catch { return null; }
}

async function checkActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) await checkTab(tab.id, tab.url);
  } catch { /* no window */ }
}

chrome.runtime.onInstalled.addListener(() => { setupMenu(); void syncMarks(); void sweepQueueFiles().then(readQueue).then(q => showQueue(q.items)); });
chrome.runtime.onStartup?.addListener(() => { setupMenu(); void syncMarks(); void sweepQueueFiles().then(readQueue).then(q => showQueue(q.items)); });
chrome.permissions.onAdded.addListener(() => { void syncMarks(); });
chrome.tabs.onRemoved.addListener(tabId => {
  const job = waiting.get(tabId);
  if (!job) return;
  waiting.delete(tabId);
  chrome.scripting.executeScript({ target: { tabId: job.source }, func: () => globalThis.sbmMedia && globalThis.sbmMedia.drop() }).catch(() => {});
});
chrome.permissions.onRemoved.addListener(() => { void syncMarks(); });
/** Is the tab a message came from on a site whose Download buttons are switched on (and allowed)? A tab that
 *  still had them when the owner switched its site off gets no answer. */
async function marksOn(sender) {
  let host = "";
  try { host = new URL(sender.url).hostname.toLowerCase(); } catch { return false; }
  const site = /^(www\.|mobile\.)?(x|twitter)\.com$/.test(host) ? "x" : /^(www\.|m\.)?instagram\.com$/.test(host) ? "instagram"
    : /^(www\.|m\.)?tiktok\.com$/.test(host) ? "tiktok" : null;
  if (!site) return false;
  const { marks } = await settings();
  return !!(marks && marks[site]) && await chrome.permissions.contains({ origins: SITES[site] }).catch(() => false);
}

// From a post's Download button (marks.js, in a tab of a site the owner switched on).
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.tab || !message) return;
  if (message.type === "save-post" && message.post && typeof message.post.url === "string") {
    void marksOn(sender).then(on => on && openSaveWindow(message.post.url, String(message.title || "").slice(0, 500),
      { single: message.post, posts: [] }, sender.tab.id));
  } else if (message.type === "want-media" && Array.isArray(message.posts)) {
    void fromSaveWindow(sender).then(ok => ok && sendMedia(sender.tab.id, message.posts.map(String)));
  } else if (message.type === "queue-done" && Array.isArray(message.ids)) {
    // The owner saved, or let go of, what was kept: it leaves the extension.
    void fromSaveWindow(sender).then(ok => ok && queueDone(message.ids.map(String)).then(showQueue));
  } else if (message.type === "saved?") {
    marksOn(sender).then(on => (on ? savedPosts(message.urls) : null)).then(reply, () => reply(null));
    return true;    // the answer comes later
  }
});
chrome.action.onClicked.addListener(tab => { void saveFromTab(tab); });
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "save-link") void openSaveWindow(info.linkUrl, info.linkText || "");
  else if (info.menuItemId === "structure" && tab && tab.id !== undefined) void copyStructure(tab.id).catch(() => {});
});
// Without the tab-address permission these events carry no address, and checkTab does nothing.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(tab => checkTab(tabId, tab.url)).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => { if (change.status === "complete") void checkTab(tabId, tab.url); });
// Back from the Save window: the page may have just been saved.
chrome.windows.onFocusChanged.addListener(() => { void checkActiveTab(); });
chrome.storage.onChanged.addListener(changes => {
  if (changes.checkMark || changes.token) void checkActiveTab();
  if (changes.marks) void syncMarks();
  if (changes.structureMenu) setupMenu();
});

// For the extension's own tests (Playwright drives the service worker); nothing else uses it.
globalThis.sbm = { openSaveWindow, saveFromTab, checkTab, settings, syncMarks, savedPosts, keepForLater, readQueue, queueDone, getQueueFile, showQueue,
  copyStructure };
