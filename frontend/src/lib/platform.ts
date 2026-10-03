import type { Platform, SavedPost } from "../types";

/** Normalize a URL for dedup: lowercase host, strip tracking params, drop fragment. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
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

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function detectPlatform(url: string): Platform {
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

/** Derive a best-effort display title from the URL itself (no network). */
export function titleFromUrl(url: string): string {
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
export function libraryUrl(url: string): string {
  try { return new URL(url.trim()).href; } catch { return url.trim(); }
}

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
