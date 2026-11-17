// The extension's helper in the app's Save window, put there by background.js (in the extension's own world).
// It answers the window's "ready" with what the extension read in the owner's tab, and when the window asks
// for an Instagram post's files, it passes the pieces the extension sends on to the window as files, with
// progress. It talks only to this window (the app's own page) and to the extension.
(() => {
  if (globalThis.sbmHandover && typeof globalThis.sbmHandover.start === "function") return;
  const app = location.origin;
  if (location.pathname !== "/add") return;
  let payload = null;
  const coming = new Map();          // file address -> { parts, received }

  const decode = text => {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };
  const tell = message => window.postMessage(message, app);

  addEventListener("message", event => {
    if (event.source !== window || event.origin !== app || !event.data) return;
    const data = event.data;
    if (data.type === "sbm-ready" && payload) {
      const posts = payload;
      payload = null;
      tell({ type: "sbm-posts", ...posts });
    } else if (data.type === "sbm-want-media" && Array.isArray(data.posts)) {
      try {
        chrome.runtime.sendMessage({ type: "want-media", posts: data.posts.slice(0, 60).map(String) }).catch(() => {});
      } catch { /* the extension was reloaded */ }
    } else if (data.type === "sbm-queue-done" && Array.isArray(data.ids)) {
      // The owner saved, or let go of, what the extension kept while the app wasn't running.
      try {
        chrome.runtime.sendMessage({ type: "queue-done", ids: data.ids.slice(0, 200).map(String) }).catch(() => {});
      } catch { /* the extension was reloaded */ }
    }
  });

  chrome.runtime.onMessage.addListener((message, sender) => {
    // Only from the extension's own background, never from a tab.
    if (sender.id !== chrome.runtime.id || sender.tab || !message) return;
    const { post, url, kind } = message;
    if (message.type === "media-failed") {
      coming.delete(url);
      tell({ type: "sbm-media", post, url, kind, error: message.error === "too_large" ? "too_large" : "unavailable", total: message.total || 0 });
    } else if (message.type === "media-chunk" && typeof message.data === "string") {
      const entry = coming.get(url) || { parts: [], received: 0 };
      const bytes = decode(message.data);
      entry.parts.push(bytes);
      entry.received += bytes.length;
      coming.set(url, entry);
      if (message.last) {
        coming.delete(url);
        tell({ type: "sbm-media", post, url, kind, blob: new Blob(entry.parts, { type: message.mime || "" }), total: entry.received });
      } else {
        tell({ type: "sbm-media-progress", post, url, kind, received: entry.received, total: message.total || 0 });
      }
    }
  });

  // Only for the app the extension has just checked: the window must still be that app's Save window.
  globalThis.sbmHandover = { start(posts, origin) { if (origin === app) payload = posts; return origin === app; } };
})();
