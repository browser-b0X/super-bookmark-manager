/**
 * The "Save to SuperBookmarks" bookmark: one line of JavaScript the
 * owner drags to the bookmarks bar. It only opens the app's own Save window
 * (/add) with the page's address, title and selected text; nothing is saved
 * until Save is clicked there.
 *
 * On an Instagram post it also reads what the page shows (caption, author,
 * date, the post's pictures) and hands it to that window by postMessage,
 * addressed to the app's origin, once the window says it is ready. The page's
 * Instagram login never leaves the page.
 */

export const DEFAULT_ORIGIN = "http://127.0.0.1:5001";

// Runs inside the page the owner is looking at. Kept readable here; packed into the bookmark below.
const SOURCE = String.raw`(() => {
  const A = "%ORIGIN%", e = encodeURIComponent, l = location;
  const w = window.open(A + "/add?url=" + e(l.href) + "&title=" + e(document.title.slice(0, 500)) +
    "&note=" + e(String(getSelection()).slice(0, 500)), "sbm-add", "width=460,height=640");
  if (!w || !/(^|\.)instagram\.com$/.test(l.hostname) || !/\/(p|reel|reels|tv)\//.test(l.pathname)) return;
  const read = () => {
    const root = document.querySelector("main article") || document.querySelector("article") || document.querySelector("main") || document;
    const meta = n => (document.querySelector('meta[property="' + n + '"]') || {}).content || "";
    const best = img => {
      const set = (img.getAttribute("srcset") || "").split(",").map(s => s.trim().split(/\s+/)).filter(p => p[0]);
      set.sort((a, b) => parseInt(b[1] || "0") - parseInt(a[1] || "0"));
      return (set[0] && set[0][0]) || img.currentSrc || img.src;
    };
    const pictures = [];
    for (const img of root.querySelectorAll("img")) {
      const alt = (img.getAttribute("alt") || "").toLowerCase();
      if (alt.includes("profile picture") || (img.naturalWidth && img.naturalWidth < 150)) continue;
      const src = best(img);
      if (/^https:\/\/[^/]*(cdninstagram\.com|fbcdn\.net)\//.test(src) && !pictures.includes(src)) pictures.push(src);
      if (pictures.length >= 10) break;
    }
    if (!pictures.length && meta("og:image")) pictures.push(meta("og:image"));
    const caption = ((root.querySelector("h1") || {}).innerText || "").trim() || meta("og:description");
    const handleLink = root.querySelector('header a[href^="/"]');
    const handle = handleLink ? handleLink.getAttribute("href").split("/").filter(Boolean)[0] || "" : "";
    const author = (meta("og:title").split(" on Instagram")[0] || handle).trim();
    const time = root.querySelector("time[datetime]");
    return { caption: caption.slice(0, 5000), author: author.slice(0, 200), handle: handle.slice(0, 40),
      takenAt: time ? time.getAttribute("datetime") : "", pictures, video: !!root.querySelector("video") };
  };
  const on = ev => {
    if (ev.origin !== A || ev.source !== w || !ev.data || ev.data.type !== "sbm-ready") return;
    removeEventListener("message", on);
    w.postMessage({ type: "sbm-instagram", post: read() }, A);
  };
  addEventListener("message", on);
  setTimeout(() => removeEventListener("message", on), 60000);
})()`;

/** Squeeze the readable source onto one line (no comments in it, so this is safe). */
function pack(source: string): string {
  return source.split("\n").map(line => line.trim()).filter(Boolean).join(" ");
}

export function bookmarkletFor(origin: string): string {
  if (!/^https?:\/\/[A-Za-z0-9.[\]:-]+$/.test(origin)) throw new Error("unexpected app address");
  return "javascript:" + encodeURIComponent(pack(SOURCE.replace("%ORIGIN%", origin)));
}

/** The source as it runs, for tests: the same text the bookmark carries. */
export const bookmarkletSource = (origin: string) => pack(SOURCE.replace("%ORIGIN%", origin));
