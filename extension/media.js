// The pictures and the video of one Instagram post, fetched inside the owner's tab when the owner saves that
// post (the toolbar button on the open post, or its Download button): from the browser's cache or Instagram's
// picture servers, without cookies, within the app's limits. The extension then passes them, in pieces, to the
// app's Save window, so the app itself doesn't contact Instagram. Nothing is kept once the window is done.
(() => {
  if (globalThis.sbmMedia && typeof globalThis.sbmMedia.fetchAll === "function") return;
  const LIMITS = { picture: 4 * 1024 * 1024, video: 50 * 1024 * 1024 };
  const KEEP_FOR = 5 * 60 * 1000;    // a window that never asks: the files go anyway
  const held = new Map();            // address -> Blob, until the Save window has it
  /** Instagram's own picture servers, by the address's real host (not a pattern over the whole address). */
  const instagramFile = url => {
    try {
      const u = new URL(url);
      return u.protocol === "https:" && /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i.test(u.hostname);
    } catch { return false; }
  };

  async function fetchOne(url, kind) {
    if (!instagramFile(url) || !LIMITS[kind]) return { url, kind, error: "unavailable" };
    let response;
    try {
      response = await fetch(url, { credentials: "omit", cache: "force-cache", referrerPolicy: "strict-origin-when-cross-origin" });
    } catch { return { url, kind, error: "unavailable" }; }
    // A file that came from somewhere else in the end (the address sent the browser on) isn't the post's.
    if (!response.ok || !response.body || (response.url && !instagramFile(response.url))) return { url, kind, error: "unavailable" };
    const length = Number(response.headers.get("content-length") || 0);
    if (length > LIMITS[kind]) return { url, kind, error: "too_large", size: length };
    const reader = response.body.getReader();
    const parts = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > LIMITS[kind]) {
        reader.cancel().catch(() => {});
        return { url, kind, error: "too_large", size };
      }
      parts.push(value);
    }
    const type = (response.headers.get("content-type") || "").split(";")[0].trim();
    const blob = new Blob(parts, { type });
    held.set(url, blob);
    setTimeout(() => { if (held.get(url) === blob) held.delete(url); }, KEEP_FOR);
    return { url, kind, size: blob.size, type };
  }

  /** Fetch the post's files; what came of each: { url, kind, size, type } or { url, kind, error }. */
  async function fetchAll(items) {
    const list = Array.isArray(items) ? items.slice(0, 11) : [];
    return Promise.all(list.map(item => fetchOne(String(item.url), item.kind).catch(() => ({ url: String(item.url), kind: item.kind, error: "unavailable" }))));
  }

  /** Bytes start..end of a fetched file, as base64 (extension messages carry text), or null. Read with a FileReader:
   *  in a Firefox content script the bytes of a page-made file can't be sliced as a typed array. */
  async function chunk(url, start, end) {
    const blob = held.get(url);
    if (!blob) return null;
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob.slice(start, end));
    });
    return dataUrl.slice(dataUrl.indexOf(",") + 1);
  }

  function drop(url) {
    if (url) held.delete(url); else held.clear();
  }

  globalThis.sbmMedia = { fetchAll, chunk, drop };
})();
