import type { RemovedLink, SavedPost } from "../types";
import { libraryUrl } from "./platform";
import { postKey } from "./duplicates";

/**
 * Removed links, remembered (v0.4.0): what a link held when it was removed (its notes, tags, shelves, marks and how
 * often it was opened), so it can come back as it was, an import or Telegram doesn't bring the same post back at
 * another address, and a new link of the same post can take back what the old one had. Kept in SQLite beside the
 * links; the most recent REMOVED_LIMIT only.
 */
export const REMOVED_LIMIT = 1000;
/** Deletion marks for removed links' records kept here (each reaches other browsers; SQLite takes at most 5,000). */
export const REMOVED_MARKS_LIMIT = 2000;
/** The newest REMOVED_MARKS_LIMIT marks. */
export function capMarks(marks: Record<string, string>): Record<string, string> {
  const entries = Object.entries(marks);
  return entries.length <= REMOVED_MARKS_LIMIT ? marks
    : Object.fromEntries(entries.sort(([, a], [, b]) => b.localeCompare(a)).slice(0, REMOVED_MARKS_LIMIT));
}
/** A record's size as SQLite measures it (JSON with every non-ASCII character escaped); it takes at most 20,000. */
const RECORD_LIMIT = 18000;
const storedLength = (value: unknown) => { const text = JSON.stringify(value); let n = text.length; for (const ch of text) if (ch.charCodeAt(0) > 127) n += 5; return n; };

/** FNV-1a over the address, twice with different starting points: the same link always gets the same record. */
function hash(text: string): string {
  const one = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, "0");
  };
  return one(0x811c9dc5) + one(0x050c5d1f);
}
export const removedId = (url: string) => `r-${hash(libraryUrl(url))}`;

/** What a removed link keeps: who it is and what the owner gave it. What a preview fetch brings back is left out
 *  (saved copies go with the link). */
const KEPT: (keyof SavedPost)[] = ["id", "url", "source", "platform", "domain", "status", "title", "description", "author", "thumbnailUrl",
  "categories", "categoryMode", "tags", "projectIds", "userNotes", "favorite", "pinned", "useOften", "reviewed", "followUpAt",
  "createdAt", "updatedAt", "openCount", "lastOpenedAt", "creatorId", "folderPath", "metadataStatus", "canonicalUrl"];

/** A link as its removed record keeps it (KEPT fields only), shortened to fit SQLite's limit: the description goes
 *  first, then the end of a long note. */
export function keptPost(post: SavedPost): SavedPost {
  const kept = Object.fromEntries(KEPT.filter(k => post[k] !== undefined).map(k => [k, post[k]])) as unknown as SavedPost;
  if (storedLength(kept) > RECORD_LIMIT) delete kept.description;
  while (storedLength(kept) > RECORD_LIMIT && kept.userNotes) kept.userNotes = kept.userNotes.slice(0, Math.floor(kept.userNotes.length * 0.8));
  return kept;
}

export function rememberRemoved(post: SavedPost, at: string, into?: SavedPost): RemovedLink {
  const kept = keptPost(post);
  const key = postKey(post.url);
  return { id: removedId(post.url), url: post.url, ...(key ? { key } : {}), how: into ? "merged" : "removed",
    ...(into ? { into: into.url } : {}), post: kept, removedAt: at, updatedAt: at };
}

const PLACEHOLDERS = new Set(["uncategorized", "other"]);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What the owner gave a removed link, in words ("a note, 2 tags, the shelf food-drink, a favourite"). */
export function whatItHad(post: SavedPost): string[] {
  const shelves = post.categories.filter(c => !PLACEHOLDERS.has(c));
  return [
    post.userNotes?.trim() ? "a note" : "",
    post.tags.length === 1 ? `#${post.tags[0]}` : post.tags.length ? plural(post.tags.length, "tag") : "",
    shelves.length === 1 ? `the shelf ${shelves[0]}` : shelves.length ? `${shelves.length} shelves` : "",
    post.favorite ? "a favourite" : "",
    post.reviewed ? "the Reviewed mark" : "",
    post.followUpAt ? `a follow-up on ${post.followUpAt}` : "",
    post.openCount ? `opened ${plural(post.openCount, "time")}` : "",
  ].filter(Boolean);
}

/** The removed link a live one is (the same address, or the same post at another address), if any. A link merged
 *  into another counts only at its own address: what it held is already in the link it went into. */
export function removedFor(post: SavedPost, removed: RemovedLink[]): RemovedLink | undefined {
  const key = postKey(post.url);
  const exact = libraryUrl(post.url);
  return removed.find(r => libraryUrl(r.url) === exact) ?? (key ? removed.find(r => r.how === "removed" && postKey(r.url) === key) : undefined);
}

/** What a new link takes back from the removed one: its notes, tags, shelves and marks, added to what it has, and its
 *  title while the new link has only the one made from its address (no preview yet, not typed by the owner). */
export function reattachPatch(post: SavedPost, from: SavedPost, at: string): Partial<SavedPost> {
  const placeholder = post.fieldSources?.title !== "user" && !["enriched", "partial"].includes(post.metadataStatus);
  const shelves = [...new Set([...post.categories, ...from.categories])];
  const real = shelves.filter(c => !PLACEHOLDERS.has(c));
  const notes = [...new Set([post.userNotes?.trim(), from.userNotes?.trim()].filter((n): n is string => !!n))];
  return {
    tags: [...new Set([...post.tags, ...from.tags])],
    categories: real.length ? real : shelves,
    ...(real.length && real.some(c => !post.categories.includes(c)) ? { categoryMode: "manual" as const, categoryReview: false } : {}),
    ...(notes.length ? { userNotes: notes.join("\n\n") } : {}),
    favorite: post.favorite || from.favorite || undefined,
    pinned: post.pinned || from.pinned || undefined,
    useOften: post.useOften || from.useOften || undefined,
    reviewed: post.reviewed || from.reviewed || undefined,
    followUpAt: post.followUpAt ?? from.followUpAt,
    creatorId: post.creatorId ?? from.creatorId,
    openCount: (post.openCount ?? 0) + (from.openCount ?? 0) || undefined,
    lastOpenedAt: [post.lastOpenedAt ?? "", from.lastOpenedAt ?? ""].sort().pop() || undefined,
    createdAt: [post.createdAt, from.createdAt].sort()[0],
    projectIds: [...new Set([...post.projectIds, ...from.projectIds])],
    ...(placeholder && from.title ? { title: from.title } : {}),
    updatedAt: at,
  };
}
