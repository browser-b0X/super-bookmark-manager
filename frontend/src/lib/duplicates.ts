import type { SavedPost } from "../types";
import { postAddress } from "./pagePosts";

/**
 * The same post saved twice (v0.4.0): one key per post whatever the address (x.com or twitter.com, a share link,
 * tracking added), so two links of one post can be merged into one.
 */
export function postKey(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const social = postAddress(`https://${u.host}${u.pathname}${u.search}`);
  if (social) return social.key;
  const host = u.hostname.toLowerCase().replace(/^(www|m|old|new)\./, "");
  let m: RegExpExecArray | null;
  if (host === "reddit.com" && (m = /\/comments\/([a-z0-9]{3,12})(?:\/|$)/i.exec(u.pathname))) return `reddit:${m[1].toLowerCase()}`;
  if (host === "redd.it" && (m = /^\/([a-z0-9]{3,12})\/?$/i.exec(u.pathname))) return `reddit:${m[1].toLowerCase()}`;
  if (host === "youtube.com") {
    const v = u.searchParams.get("v");
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return `yt:${v}`;
    if ((m = /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})(?:\/|$)/.exec(u.pathname))) return `yt:${m[1]}`;
  }
  if (host === "youtu.be" && (m = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(u.pathname))) return `yt:${m[1]}`;
  return null;
}

const SITE: Record<string, string> = { x: "X post", ig: "Instagram post", tt: "TikTok video", reddit: "Reddit post", yt: "YouTube video" };
export const keyLabel = (key: string) => `${SITE[key.split(":")[0]] ?? "Post"} ${key.split(":")[1]}`;

export interface DuplicateGroup { key: string; posts: SavedPost[] }

/** Links that are one post, two or more to a group, the groups with the newest link first. */
export function findDuplicates(posts: SavedPost[]): DuplicateGroup[] {
  const groups = new Map<string, SavedPost[]>();
  for (const post of posts) {
    const key = postKey(post.url);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), post]);
  }
  return [...groups.entries()].filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({ key, posts: [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) }))
    .sort((a, b) => b.posts[b.posts.length - 1].createdAt.localeCompare(a.posts[a.posts.length - 1].createdAt));
}

/** The link a merge keeps: one with a saved copy, else the one saved first. */
export function keeperOf(posts: SavedPost[]): SavedPost {
  return posts.find(p => p.archiveStatus === "saved") ?? [...posts].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
}

const PLACEHOLDERS = new Set(["uncategorized", "other"]);
const unique = (values: string[]) => [...new Set(values)];

/** The kept link with what the others hold folded in: tags, shelves and notes of all, the earliest saved date,
 *  marks any of them had; the kept link's title, address and saved copy. */
export function mergedPost(keep: SavedPost, others: SavedPost[], at: string): SavedPost {
  const all = [keep, ...others];
  const shelves = unique(all.flatMap(p => p.categories));
  const real = shelves.filter(c => !PLACEHOLDERS.has(c));
  const notes = unique(all.map(p => p.userNotes?.trim() ?? "").filter(Boolean));
  const first = <K extends keyof SavedPost>(key: K) => all.map(p => p[key]).find(v => v !== undefined && v !== "") as SavedPost[K] | undefined;
  return {
    ...keep,
    tags: unique(all.flatMap(p => p.tags)),
    categories: real.length ? real : shelves,
    ...(real.length && shelves.length !== keep.categories.length ? { categoryMode: "manual" as const, categoryReview: false } : {}),
    ...(notes.length ? { userNotes: notes.join("\n\n") } : {}),
    createdAt: all.map(p => p.createdAt).sort()[0],
    favorite: all.some(p => p.favorite) || undefined,
    pinned: all.some(p => p.pinned) || undefined,
    useOften: all.some(p => p.useOften) || undefined,
    reviewed: all.some(p => p.reviewed) || undefined,
    followUpAt: first("followUpAt"),
    creatorId: first("creatorId"),
    projectIds: unique(all.flatMap(p => p.projectIds)),
    folderPath: all.map(p => p.folderPath).find(f => f?.length),
    description: first("description"),
    thumbnailUrl: first("thumbnailUrl"),
    openCount: all.reduce((n, p) => n + (p.openCount ?? 0), 0) || undefined,
    lastOpenedAt: all.map(p => p.lastOpenedAt ?? "").sort().pop() || undefined,
    updatedAt: at,
  };
}
