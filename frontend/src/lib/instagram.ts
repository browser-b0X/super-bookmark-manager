/** Instagram posts: recognised here the same way instagram_post.py does on the server. */
import { remembered } from "./platform";

const POST_PATH = /^\/(?:[A-Za-z0-9._]{1,30}\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,64})\/?$/;
const HOSTS = new Set(["www.instagram.com", "instagram.com", "m.instagram.com"]);

// Asked for every link whenever the library changes (copy counts, the copy queue): remembered.
export const instagramCode = remembered((url: string): string | null => {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || !HOSTS.has(parsed.hostname.toLowerCase())) return null;
    return POST_PATH.exec(parsed.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
});

export const isInstagramPost = (url: string) => instagramCode(url) !== null;

/** What the bookmark button reads on an open Instagram post. The server checks it all again. */
export interface InstagramData {
  caption: string;
  author: string;
  handle: string;
  takenAt: string;
  pictures: string[];
  video: boolean;
}

const PICTURE_HOST = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;

/** Accept a message from the button only in exactly this shape; anything else is ignored. */
export function readInstagramData(value: unknown): InstagramData | null {
  const v = value as Record<string, unknown>;
  if (!v || typeof v !== "object") return null;
  const text = (key: string, max: number) => (typeof v[key] === "string" ? (v[key] as string).slice(0, max) : "");
  const pictures = Array.isArray(v.pictures) ? v.pictures.slice(0, 40).filter((p): p is string => {
    if (typeof p !== "string" || p.length > 4096) return false;
    try { const u = new URL(p); return u.protocol === "https:" && PICTURE_HOST.test(u.hostname); } catch { return false; }
  }) : [];
  return {
    caption: text("caption", 5000), author: text("author", 200), handle: text("handle", 40), takenAt: text("takenAt", 40),
    pictures: [...new Set(pictures)].slice(0, 10), video: v.video === true,
  };
}
