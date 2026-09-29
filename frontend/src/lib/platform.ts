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
  if (/\.(pdf|docx?|epub)$/i.test(new URL(url).pathname)) return "pdf";
  if (d.includes(".")) return "web";
  return "other";
}

export function detectMediaType(url: string, platform: Platform): SavedPost["mediaType"] {
  if (platform === "youtube") return "video";
  if (platform === "instagram" || platform === "tiktok") return "post";
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
