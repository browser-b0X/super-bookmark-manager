import type { SavedPost } from "../types";

/**
 * Library search with a few operators, all optional and combinable:
 *   site:github.com   #recipes   is:unread|later|reference|archived|favorite|pinned|gone|unfiled
 *   shelf:travel      in:"Bookmarks bar"   plus any free text.
 * Saved Views store the raw string, so operators work there too.
 */
export interface ParsedQuery {
  text: string[];
  sites: string[];
  tags: string[];
  is: string[];
  shelves: string[];
  folders: string[];
}

const TOKEN = /(-?)(site|is|shelf|in|tag):("[^"]*"|\S+)|#("[^"]*"|\S+)|("[^"]*"|\S+)/gi;
const unquote = (v: string) => v.replace(/^"|"$/g, "").toLowerCase();

export function parseQuery(raw: string): ParsedQuery {
  const parsed: ParsedQuery = { text: [], sites: [], tags: [], is: [], shelves: [], folders: [] };
  for (const match of raw.matchAll(TOKEN)) {
    const [, , key, value, hashTag, word] = match;
    if (key && value !== undefined) {
      const v = unquote(value);
      if (!v) continue;
      ({ site: parsed.sites, is: parsed.is, shelf: parsed.shelves, in: parsed.folders, tag: parsed.tags } as Record<string, string[]>)[key.toLowerCase()].push(v);
    } else if (hashTag) {
      const v = unquote(hashTag);
      if (v) parsed.tags.push(v);
    } else if (word) {
      const v = unquote(word);
      if (v) parsed.text.push(v);
    }
  }
  return parsed;
}

export const isEmptyQuery = (q: ParsedQuery) =>
  !q.text.length && !q.sites.length && !q.tags.length && !q.is.length && !q.shelves.length && !q.folders.length;

// One lowercase text blob per post object; posts are replaced (not mutated) on
// every edit, so the cache can never serve stale text.
const haystacks = new WeakMap<SavedPost, string>();
function haystack(post: SavedPost): string {
  let text = haystacks.get(post);
  if (text === undefined) {
    text = [post.title, post.description, post.excerpt, post.userNotes, post.url, post.siteName, post.author, ...post.tags]
      .filter(Boolean).join("\n").toLowerCase();
    haystacks.set(post, text);
  }
  return text;
}

function isMatch(post: SavedPost, flag: string): boolean {
  switch (flag) {
    case "unread": case "inbox": case "new": return post.status === "inbox";
    case "later": case "to-review": return post.status === "to-review";
    case "reading": case "in-progress": return post.status === "in-progress";
    case "reference": case "kept": return post.status === "reference";
    case "archived": return post.status === "archived";
    case "favorite": case "fav": case "starred": return !!post.favorite;
    case "pinned": return !!post.pinned;
    case "gone": case "dead": return post.linkStatus === "gone";
    case "unfiled": case "uncategorized": return !post.categories.length || post.categories.every(c => c === "uncategorized" || c === "other");
    case "opened": return !!post.lastOpenedAt;
    case "unopened": return !post.lastOpenedAt;
    default: return false;
  }
}

export function matchesQuery(post: SavedPost, q: ParsedQuery): boolean {
  if (q.sites.length) {
    const host = (post.domain || "").toLowerCase();
    if (!q.sites.some(s => host === s || host.endsWith("." + s) || host.includes(s))) return false;
  }
  if (q.tags.length && !q.tags.every(t => post.tags.some(tag => tag.toLowerCase() === t || tag.toLowerCase().startsWith(t + "/")))) return false;
  if (q.is.length && !q.is.every(flag => isMatch(post, flag))) return false;
  if (q.shelves.length && !q.shelves.every(s => post.categories.some(c => c.toLowerCase() === s))) return false;
  if (q.folders.length && !q.folders.every(f => (post.folderPath ?? []).some(name => name.toLowerCase() === f))) return false;
  if (q.text.length) {
    const text = haystack(post);
    if (!q.text.every(word => text.includes(word))) return false;
  }
  return true;
}
