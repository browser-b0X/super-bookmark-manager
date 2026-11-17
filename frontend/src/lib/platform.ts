import type { Platform, SavedPost } from "../types";

/**
 * Remember a pure string → value function's answers. Every write to the library
 * re-reads thousands of links (counts, duplicate checks, sync keys), and parsing a
 * URL each time kept the page busy for seconds after a big import. A link's
 * answers never change, so they are computed once; the table empties itself when
 * it grows past `limit` instead of growing without bound.
 */
export function remembered<T>(fn: (value: string) => T, limit = 50_000): (value: string) => T {
  const known = new Map<string, T>();
  return (value: string) => {
    const seen = known.get(value);
    if (seen !== undefined || known.has(value)) return seen as T;
    const answer = fn(value);       // a throw is passed on and not remembered
    if (known.size >= limit) known.clear();
    known.set(value, answer);
    return answer;
  };
}

/** Normalize a URL for dedup: lowercase host, strip tracking params, drop fragment. */
export const normalizeUrl = remembered(normalizeUrlNow);

function normalizeUrlNow(raw: string): string {
  try {
    const u = new URL(raw.trim());
    // "#section" is a place on the same page; "#/invoice/2002" is a page of a web app.
    if (!/^#!?\//.test(u.hash)) u.hash = "";
    const keep = [...u.searchParams.entries()].filter(
      ([k]) => !["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "igsh", "igshid", "si", "feature"].includes(k.toLowerCase())
    );
    u.search = "";
    keep.forEach(([k, v]) => u.searchParams.set(k, v));
    let s = u.toString();
    if (s.endsWith("/")) s = s.slice(0, -1);
    return s.replace(/^https?:\/\/(www\.|m\.)/i, "https://");
  } catch {
    return raw.trim();
  }
}

/** Parameters that only say where a click came from (ads, newsletters, share buttons). */
const TRACKING = new Set(["fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid", "yclid", "twclid", "ttclid", "li_fat_id",
  "mc_cid", "mc_eid", "_hsenc", "_hsmi", "mkt_tok", "igsh", "igshid"]);
/** Share-button parameters that mean something elsewhere, so only on these sites. */
const SITE_TRACKING: [RegExp, string[]][] = [
  [/(^|\.)(youtube\.com|youtu\.be)$/, ["si", "feature", "pp"]],
  [/(^|\.)spotify\.com$/, ["si"]],
  [/(^|\.)(x\.com|twitter\.com)$/, ["s", "t", "ref_src", "ref_url"]],
];

/** The address to save: the same address without tracking parameters (utm_…, fbclid, a share button's
 *  si=…). Everything else, the order of the rest and the #fragment included, stays as it was. */
export function withoutTracking(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { return raw; }
  const host = url.hostname.toLowerCase();
  const siteKeys = SITE_TRACKING.filter(([pattern]) => pattern.test(host)).flatMap(([, keys]) => keys);
  const drop = (key: string) => { const k = key.toLowerCase(); return k.startsWith("utm_") || TRACKING.has(k) || siteKeys.includes(k); };
  const pairs = url.search.slice(1).split("&").filter(Boolean);
  const name = (pair: string) => { const key = pair.split("=")[0].replace(/\+/g, " "); try { return decodeURIComponent(key); } catch { return key; } };
  const kept = pairs.filter(pair => !drop(name(pair)));
  if (kept.length === pairs.length) return raw;
  url.search = kept.length ? `?${kept.join("&")}` : "";
  return url.href;
}

export const domainOf = remembered((url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
});

export const detectPlatform = remembered(detectPlatformNow);

function detectPlatformNow(url: string): Platform {
  const d = domainOf(url).toLowerCase();
  if (d.includes("instagram.com")) return "instagram";
  if (d === "x.com" || d.includes("twitter.com")) return "x";
  if (d.includes("youtube.com") || d === "youtu.be") return "youtube";
  if (d.includes("github.com")) return "github";
  if (d.includes("reddit.com") || d === "redd.it") return "reddit";
  if (d.includes("tiktok.com")) return "tiktok";
  if (d === "facebook.com" || d.endsWith(".facebook.com") || d === "fb.watch" || d === "fb.com") return "facebook";
  if (d === "threads.net" || d === "threads.com") return "threads";
  if (d === "linkedin.com" || d.endsWith(".linkedin.com") || d === "lnkd.in") return "linkedin";
  if (d === "pinterest.com" || /(^|\.)pinterest\.[a-z.]+$/.test(d) || d === "pin.it") return "pinterest";
  if (d === "bsky.app") return "bluesky";
  if (/\.(pdf|docx?|epub)$/i.test(new URL(url).pathname)) return "pdf";
  if (d.includes(".")) return "web";
  return "other";
}

export function detectMediaType(url: string, platform: Platform): SavedPost["mediaType"] {
  if (platform === "youtube") return "video";
  if (platform === "instagram" || platform === "tiktok" || platform === "facebook" || platform === "threads"
    || platform === "linkedin" || platform === "pinterest" || platform === "bluesky") return "post";
  if (platform === "x") return "thread";
  if (platform === "github") return "repository";
  if (platform === "pdf") return "document";
  if (platform === "reddit") return "post";
  return "article";
}

/**
 * A post on X or TikTok, named after who posted it ("@handle on X"); "" for any other address. A post's address
 * ends in a number, which names nothing, and X's previews bring no title to replace it.
 */
export function postName(url: string): string {
  let path: string;
  try { path = new URL(url).pathname; } catch { return ""; }
  const platform = detectPlatform(url);
  if (platform === "x" && /\/status(es)?\/\d+/.test(path)) {
    const handle = /^\/([^/]+)\/status/.exec(path)?.[1] ?? "";
    return handle && !["i", "home"].includes(handle) ? `@${handle} on X` : "X post";
  }
  const tiktok = platform === "tiktok" ? /^\/(@[^/]+)\/(?:video|photo)\/\d+/.exec(path) : null;
  return tiktok ? `${tiktok[1]} on TikTok` : "";
}

/** Derive a best-effort display title from the URL itself (no network). */
export function titleFromUrl(url: string): string {
  const name = postName(url);
  if (name) return name;
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    const last = segs[segs.length - 1] || "";
    const words = decodeURIComponent(last)
      .replace(/\.(html?|php|aspx?|jsp)$/i, "")
      .replace(/[-_+]/g, " ")
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim();
    return words && words.length > 2 ? words : domainOf(url);
  } catch {
    return url;
  }
}

/** The exact-URL key the library uses everywhere (WHATWG href). */
export const libraryUrl = remembered((url: string): string => {
  try { return new URL(url.trim()).href; } catch { return url.trim(); }
});

/**
 * Stable ID for one exact link. Built from the href, not the canonical form:
 * `…/page/`, `…/page?utm_source=x` and `www.…/page` are different saved links
 * and must not share an ID (that collision used to wedge every later save).
 * Two independent 32-bit FNV-1a passes keep accidental collisions negligible.
 */
export function idForUrl(url: string): string {
  const s = libraryUrl(url);
  let a = 0x811c9dc5, b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
  }
  return "u" + (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

export function slugId(url: string): string {
  const n = normalizeUrl(url);
  let h = 0;
  for (let i = 0; i < n.length; i++) h = ((h << 5) - h + n.charCodeAt(i)) | 0;
  return "u" + Math.abs(h).toString(36) + n.length.toString(36);
}

export function faviconFor(url: string): string {
  const d = domainOf(url);
  return d ? `https://www.google.com/s2/favicons?domain=${d}&sz=32` : "";
}

/** Platform for display and filters: links saved before a platform was recognised are re-read from their URL. */
export function effectivePlatform(post: Pick<SavedPost, "platform" | "url">): Platform {
  return post.platform === "web" || post.platform === "other" ? detectPlatform(post.url) : post.platform;
}
