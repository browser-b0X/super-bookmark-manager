/**
 * Posts the browser extension read in the owner's tab (v0.4.0): the open post, or the posts already
 * loaded on a profile, feed or search page of X, Instagram or TikTok. They come from the page, so the
 * Save window checks them all again here: one address per post (the spelling the library keeps), capped
 * text, https pictures only, at most 50 posts.
 */
import type { SavedPost } from "../types";
import { readInstagramData, type InstagramData } from "./instagram";
import { RESERVED_SHELVES } from "./shelves";

export type PostSite = "x" | "instagram" | "tiktok";

export interface PagePost {
  url: string;
  /** The same for every spelling of the post's address (x.com or twitter.com, any handle case, /user/p/ or /p/). */
  key: string;
  site: PostSite;
  author: string;
  handle: string;
  text: string;
  takenAt: string;
  pictures: string[];
  video: boolean;
  /** An Instagram video read in the tab: whether the page held the video's file (the extension takes it from there). */
  videoFile?: boolean;
}

export interface PagePosts { single: PagePost | null; posts: PagePost[] }

export const MAX_POSTS = 50;
export const SITE_NAMES: Record<PostSite, string> = { x: "X", instagram: "Instagram", tiktok: "TikTok" };

/** The address the library keeps for a post on X, Instagram or TikTok, with its key; null for anything else.
 *  The extension's readers.js spells addresses the same way (tests compare the two). */
export function postAddress(raw: string): { url: string; key: string; site: PostSite } | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  let m: RegExpExecArray | null;
  if (/^(www\.|mobile\.)?(x|twitter)\.com$/.test(host) && (m = /^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{1,25})(?:\/|$)/.exec(u.pathname)))
    return { site: "x", url: `https://x.com/${m[1]}/status/${m[2]}`, key: `x:${m[2]}` };
  if (/^(www\.|m\.)?instagram\.com$/.test(host) && (m = /^\/(?:[A-Za-z0-9._]{1,30}\/)?(p|reels?|tv)\/(?!audio\/)([A-Za-z0-9_-]{5,64})(?:\/|$)/.exec(u.pathname)))
    return { site: "instagram", url: `https://www.instagram.com/${m[1] === "p" ? "p" : m[1] === "tv" ? "tv" : "reel"}/${m[2]}/`, key: `ig:${m[2]}` };
  if (/^(www\.|m\.)?tiktok\.com$/.test(host) && (m = /^\/@([A-Za-z0-9._]{1,40})\/(video|photo)\/(\d{5,25})(?:\/|$)/.exec(u.pathname)))
    return { site: "tiktok", url: `https://www.tiktok.com/@${m[1]}/${m[2]}/${m[3]}`, key: `tt:${m[3]}` };
  return null;
}

const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

function readPagePost(value: unknown): PagePost | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const address = typeof v.url === "string" && v.url.length <= 4096 ? postAddress(v.url) : null;
  if (!address) return null;
  const pictures = Array.isArray(v.pictures)
    ? [...new Set(v.pictures.slice(0, 40).filter((p): p is string => typeof p === "string" && p.length <= 4096 && /^https:\/\/[^\s]+$/.test(p)))].slice(0, 10)
    : [];
  return { ...address, author: text(v.author, 200), handle: text(v.handle, 40).replace(/^@/, ""), text: text(v.text, 5000),
    takenAt: text(v.takenAt, 40), pictures, video: v.video === true,
    ...(address.site === "instagram" && v.video === true
      ? { videoFile: typeof v.videoUrl === "string" && v.videoUrl.length <= 4096 && /^https:\/\/[^\s]+$/.test(v.videoUrl) } : {}) };
}

/** Accept the extension's hand-over only in this shape; anything else is dropped. */
export function readPagePosts(value: unknown): PagePosts | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const single = readPagePost(v.single);
  const seen = new Set<string>();
  const posts: PagePost[] = [];
  for (const raw of Array.isArray(v.posts) ? v.posts.slice(0, MAX_POSTS) : []) {
    const post = readPagePost(raw);
    if (!post || seen.has(post.key)) continue;
    seen.add(post.key);
    posts.push(post);
  }
  return single || posts.length ? { single, posts } : null;
}

/** Posts and pages the extension kept while SuperBookmarks wasn't running (v0.4.0 phase 4). */
export interface KeptFile { url: string; kind: "picture" | "video"; size: number; dropped: boolean }
export interface KeptItem { id: string; keptAt: string; url: string; title: string; post: PagePost | null; files: KeptFile[] }
/** "The video of haleandcrumb's post (kept Oct 20) was left out to stay under 200 MB." */
export interface KeptNotice { name: string; keptAt: string; kind: "picture" | "video" }

const MAX_KEPT = 100;

function readKeptItem(value: unknown): KeptItem | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const id = typeof v.id === "string" && /^[0-9a-z-]{4,40}$/.test(v.id) ? v.id : "";
  let url = "";
  try { if (typeof v.url === "string" && v.url.length <= 4096 && ["http:", "https:"].includes(new URL(v.url).protocol)) url = v.url; } catch { /* not a web address */ }
  if (!id || !url) return null;
  const post = v.single ? readPagePost(v.single) : null;
  if (v.single && (!post || post.url !== url)) return null;
  const files = (Array.isArray(v.files) ? v.files.slice(0, 11) : []).flatMap((f): KeptFile[] => {
    const file = f as Record<string, unknown>;
    if (!file || typeof file.url !== "string" || file.url.length > 4096 || (file.kind !== "picture" && file.kind !== "video")) return [];
    return [{ url: file.url, kind: file.kind, size: typeof file.size === "number" && file.size >= 0 ? file.size : 0, dropped: file.dropped === true }];
  });
  return { id, keptAt: text(v.keptAt, 40), url, title: text(v.title, 500), post, files };
}

/** The kept items and notices in a hand-over, checked like the posts, and the ids of kept items refused (so the
 *  extension can let them go); null when there are none. */
export function readKept(value: unknown): { items: KeptItem[]; notices: KeptNotice[]; rejected: string[] } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const items: KeptItem[] = [];
  const rejected: string[] = [];
  for (const raw of Array.isArray(v.waiting) ? v.waiting.slice(0, MAX_KEPT) : []) {
    const item = readKeptItem(raw);
    const id = raw && typeof raw === "object" ? (raw as Record<string, unknown>).id : undefined;
    if (item) items.push(item);
    else if (typeof id === "string" && /^[0-9a-z-]{4,40}$/.test(id)) rejected.push(id);
  }
  if (!items.length && !rejected.length) return null;
  const notices = (Array.isArray(v.notices) ? v.notices.slice(-20) : []).flatMap((n): KeptNotice[] => {
    const notice = n as Record<string, unknown>;
    return notice && (notice.kind === "picture" || notice.kind === "video")
      ? [{ name: text(notice.name, 120), keptAt: text(notice.keptAt, 40), kind: notice.kind }] : [];
  });
  return { items, notices, rejected };
}

/** What the Instagram copy is made from (the server checks it again): the same shape the bookmark button sends. */
export function instagramDataOf(post: PagePost): InstagramData | null {
  return readInstagramData({ caption: post.text, author: post.author, handle: post.handle, takenAt: post.takenAt, pictures: post.pictures, video: post.video });
}

/** Library links by post key, for "Already saved" whatever spelling the link was saved with. */
export function savedByKey(posts: SavedPost[]): Map<string, SavedPost> {
  const out = new Map<string, SavedPost>();
  for (const post of posts) {
    const key = postAddress(post.url)?.key ?? (post.canonicalUrl ? postAddress(post.canonicalUrl)?.key : undefined);
    if (key && !out.has(key)) out.set(key, post);
  }
  return out;
}

/** The shelf a saved link is on, for "Already saved · Recipes" ("" when it is on none of the owner's own). */
export const shelfOf = (post: SavedPost) => post.categories.find(c => !RESERVED_SHELVES.has(c)) ?? "";

export const firstLine = (value: string) => value.split("\n").map(line => line.trim()).find(Boolean) ?? "";

/** "2h", "3d", "24 Oct", or "" without a time. */
export function postAge(iso: string, now = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const minutes = Math.max(0, Math.round((now - time) / 60000));
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h`;
  if (minutes < 7 * 24 * 60) return `${Math.round(minutes / (24 * 60))}d`;
  return new Date(time).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** The name an Instagram link gets (Instagram's own tab title is just "Instagram"). */
export const instagramTitle = (post: Pick<PagePost, "author" | "handle">) =>
  post.author || post.handle ? `${post.author || "@" + post.handle} on Instagram` : "";
