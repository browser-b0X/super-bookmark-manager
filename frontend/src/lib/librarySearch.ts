import type { SavedPost } from "../types";
import { isDue } from "./followUp";

/**
 * Library search with a few operators, all optional and combinable:
 *   site:github.com   #recipes   is:unread|later|reference|archived|favorite|pinned|gone|unfiled
 *                     is:followup (has a follow-up day)|due (today or overdue)|often (use often)
 *   shelf:travel      in:"Bookmarks bar"   plus any free text. A leading "-" excludes: -site:x.com, -is:archived.
 * Saved Views store the raw string, so operators work there too.
 */
export interface ParsedQuery {
  text: string[];
  sites: string[];
  tags: string[];
  is: string[];
  shelves: string[];
  folders: string[];
  /** Operators written with a leading "-" (-site:x.com, -tag:recipes, -is:archived): leave those out. */
  not: { sites: string[]; tags: string[]; is: string[]; shelves: string[]; folders: string[] };
}

const TOKEN = /(-?)(site|is|shelf|in|tag):("[^"]*"|\S+)|#("[^"]*"|\S+)|("[^"]*"|\S+)/gi;
const unquote = (v: string) => v.replace(/^"|"$/g, "").toLowerCase();

export function parseQuery(raw: string): ParsedQuery {
  const parsed: ParsedQuery = { text: [], sites: [], tags: [], is: [], shelves: [], folders: [],
    not: { sites: [], tags: [], is: [], shelves: [], folders: [] } };
  for (const match of raw.matchAll(TOKEN)) {
    const [, minus, key, value, hashTag, word] = match;
    if (key && value !== undefined) {
      const v = unquote(value);
      if (!v) continue;
      const into = minus ? parsed.not : parsed;
      ({ site: into.sites, is: into.is, shelf: into.shelves, in: into.folders, tag: into.tags } as Record<string, string[]>)[key.toLowerCase()].push(v);
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
  !q.text.length && !q.sites.length && !q.tags.length && !q.is.length && !q.shelves.length && !q.folders.length
  && !Object.values(q.not).some(list => list.length);

/** site:x.com matches x.com and its subdomains, never netflix.com; site:wikipedia matches any wikipedia.* host. */
const onSite = (host: string, site: string) =>
  host === site || host.endsWith("." + site) || (!site.includes(".") && host.split(".").includes(site));

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
    case "followup": case "follow-up": return !!post.followUpAt && post.status !== "archived";
    case "due": case "overdue": return isDue(post);
    case "often": case "use-often": return !!post.useOften;
    default: return false;
  }
}

export function matchesQuery(post: SavedPost, q: ParsedQuery): boolean {
  const host = (post.domain || "").toLowerCase();
  const hasTag = (t: string) => post.tags.some(tag => tag.toLowerCase() === t || tag.toLowerCase().startsWith(t + "/"));
  const onShelf = (s: string) => post.categories.some(c => c.toLowerCase() === s);
  const inFolder = (f: string) => (post.folderPath ?? []).some(name => name.toLowerCase() === f);
  if (q.sites.length && !q.sites.some(s => onSite(host, s))) return false;
  if (q.tags.length && !q.tags.every(hasTag)) return false;
  if (q.is.length && !q.is.every(flag => isMatch(post, flag))) return false;
  if (q.shelves.length && !q.shelves.every(onShelf)) return false;
  if (q.folders.length && !q.folders.every(inFolder)) return false;
  const not = q.not ?? { sites: [], tags: [], is: [], shelves: [], folders: [] };
  if (not.sites.some(s => onSite(host, s)) || not.tags.some(hasTag) || not.is.some(flag => isMatch(post, flag))
    || not.shelves.some(onShelf) || not.folders.some(inFolder)) return false;
  if (q.text.length) {
    const text = haystack(post);
    if (!q.text.every(word => text.includes(word))) return false;
  }
  return true;
}
