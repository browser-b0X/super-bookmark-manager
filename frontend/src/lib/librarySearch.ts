import type { SavedPost } from "../types";
import { isDue } from "./followUp";

/**
 * Library search with a few operators, all optional and combinable:
 *   site:github.com   #recipes   is:unread|later|reference|archived|favorite|pinned|gone|unfiled|reviewed
 *                     is:followup (has a follow-up day)|due (today or overdue)|often (use often)
 *   shelf:travel      in:"Bookmarks bar"   no:notes|tags|shelf|description|picture|title (empty), has:… (not empty)
 *   saved:7d  saved:>2026-10-01  saved:<2026-10-01  saved:2026-10-01..2026-10-20  saved:2026-10-01  (also opened:)
 *   "a phrase"   a or b   ( … ) to group   plus any free text.
 * A leading "-" leaves out what follows: -site:x.com, -is:archived, -#video, -( … ), -word (a whole word: -video
 * doesn't leave out "videos"). Saved Views and smart shelves store the raw string, so all of this works there too.
 */
export type Field = "site" | "is" | "shelf" | "in" | "tag" | "no" | "has" | "saved" | "opened" | "creator";
export type QueryNode =
  | { kind: "and"; items: QueryNode[] }
  | { kind: "or"; items: QueryNode[] }
  | { kind: "not"; item: QueryNode }
  | { kind: "text"; value: string; phrase: boolean }
  | { kind: "op"; field: Field; value: string };

export interface ParsedQuery {
  tree: QueryNode | null;
}

/** Other names a tag goes by and the tags under it (nested tags): a search for one finds the others too. */
export interface TagLookup { expand(tag: string): string[] }

const FIELDS = new Set<Field>(["site", "is", "shelf", "in", "tag", "no", "has", "saved", "opened", "creator"]);
/** A post's creator's names, main and other (creator:ana finds Ana Field). */
export type CreatorNames = (post: SavedPost) => string[];
const TOKEN = /\s*(?:(-?)\(|(\))|(-?)([a-z]+):("[^"]*"?|[^\s()]+)|(-?)#("[^"]*"?|[^\s()]+)|(-?)("[^"]*"?)|(-?)([^\s()]+))/giy;
const unquote = (v: string) => v.replace(/^"|"$/g, "").trim().toLowerCase();

type Token = { type: "open"; not: boolean } | { type: "close" } | { type: "or" } | { type: "atom"; node: QueryNode; not: boolean };

function tokenize(raw: string): Token[] {
  const tokens: Token[] = [];
  TOKEN.lastIndex = 0;
  for (let match = TOKEN.exec(raw); match && match[0].trim(); match = TOKEN.exec(raw)) {
    const [, openNot, close, opNot, key, opValue, tagNot, tag, phraseNot, phrase, wordNot, word] = match;
    if (openNot !== undefined) tokens.push({ type: "open", not: openNot === "-" });
    else if (close) tokens.push({ type: "close" });
    else if (key !== undefined && FIELDS.has(key.toLowerCase() as Field)) {
      const value = unquote(opValue);
      if (value) tokens.push({ type: "atom", not: opNot === "-", node: { kind: "op", field: key.toLowerCase() as Field, value } });
    } else if (key !== undefined) {
      // Not an operator (a word with a colon, such as "note:"): searched as text.
      const value = unquote(`${key}:${opValue}`);
      tokens.push({ type: "atom", not: opNot === "-", node: { kind: "text", value, phrase: false } });
    } else if (tag !== undefined) {
      const value = unquote(tag);
      if (value) tokens.push({ type: "atom", not: tagNot === "-", node: { kind: "op", field: "tag", value } });
    } else if (phrase !== undefined) {
      const value = unquote(phrase);
      if (value) tokens.push({ type: "atom", not: phraseNot === "-", node: { kind: "text", value, phrase: true } });
    } else if (word !== undefined) {
      if (!wordNot && word.toLowerCase() === "or") { tokens.push({ type: "or" }); continue; }
      const value = word.toLowerCase();
      if (value) tokens.push({ type: "atom", not: wordNot === "-", node: { kind: "text", value, phrase: false } });
    }
  }
  return tokens;
}

/** Joins items into one node: one item stays itself, none is null. */
const join = (kind: "and" | "or", items: QueryNode[]): QueryNode | null =>
  items.length === 0 ? null : items.length === 1 ? items[0] : { kind, items: items.flatMap(i => (i.kind === kind ? i.items : [i])) };

/** Brackets deeper than this are read as plain grouping-free text: a very deep search can't overflow the stack. */
const MAX_DEPTH = 32;

export function parseQuery(raw: string): ParsedQuery {
  const tokens = tokenize(raw);
  let at = 0;
  let depth = 0;
  const parseOr = (): QueryNode | null => {
    const items: QueryNode[] = [];
    for (;;) {
      const item = parseAnd();
      if (item) items.push(item);
      if (tokens[at]?.type !== "or") break;
      at++;
    }
    return join("or", items);
  };
  const parseAnd = (): QueryNode | null => {
    const items: QueryNode[] = [];
    while (at < tokens.length && tokens[at].type !== "or" && tokens[at].type !== "close") {
      const token = tokens[at++];
      if (token.type === "atom") items.push(token.not ? { kind: "not", item: token.node } : token.node);
      else if (token.type === "open" && depth >= MAX_DEPTH) continue;   // too deep: the bracket is dropped
      else if (token.type === "open") {
        depth++;
        const inner = parseOr();
        depth--;
        if (tokens[at]?.type === "close") at++;            // a missing ")" closes at the end
        if (inner) items.push(token.not ? { kind: "not", item: inner } : inner);
      }
    }
    return join("and", items);
  };
  const items: QueryNode[] = [];
  while (at < tokens.length) {
    const item = parseOr();
    if (item) items.push(item);
    if (tokens[at]?.type === "close" || tokens[at]?.type === "or") at++;   // a stray ")" or "or" is skipped
  }
  return { tree: join("and", items) };
}

export const isEmptyQuery = (q: ParsedQuery) => !q.tree;

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

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wholeWords = new Map<string, RegExp>();
/** The word on its own, not inside a longer one ("video" in "a video", not in "videos"). */
function hasWholeWord(text: string, word: string) {
  let pattern = wholeWords.get(word);
  if (!pattern) {
    pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${escape(word)}(?=$|[^\\p{L}\\p{N}_])`, "u");
    wholeWords.set(word, pattern);
  }
  return pattern.test(text);
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
    case "reviewed": case "locked": return !!post.reviewed;
    default: return false;
  }
}

/** Is this field empty? (no:notes, has:tags …) */
function isEmpty(post: SavedPost, field: string): boolean | null {
  switch (field) {
    case "notes": case "note": return !post.userNotes?.trim();
    case "tags": case "tag": return !post.tags.length;
    case "shelf": case "shelves": return isMatch(post, "unfiled");
    case "description": case "summary": return !(post.description?.trim() || post.aiSummary?.trim());
    case "picture": case "image": case "thumbnail": return !post.thumbnailUrl;
    case "title": return !post.title?.trim();
    case "copy": return post.archiveStatus !== "saved";
    case "followup": return !post.followUpAt;
    default: return null;
  }
}

/** The local calendar day of a time, as YYYY-MM-DD. */
const dayOf = (time: number) => {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** saved:7d, saved:2w, saved:3m (in the last …), saved:>D (after day D), saved:<D (before), saved:D..E, saved:D. */
export function dateMatches(iso: string | undefined, value: string, now = Date.now()): boolean {
  const time = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(time)) return false;
  const recent = /^(\d{1,4})([dwmy])$/.exec(value);
  if (recent) {
    const days = Number(recent[1]) * { d: 1, w: 7, m: 30, y: 365 }[recent[2] as "d" | "w" | "m" | "y"];
    return time >= now - days * 86400000;
  }
  const day = dayOf(time);
  if (value.startsWith(">") && DAY.test(value.slice(1))) return day > value.slice(1);
  if (value.startsWith("<") && DAY.test(value.slice(1))) return day < value.slice(1);
  const range = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(value);
  if (range) return day >= range[1] && day <= range[2];
  return DAY.test(value) && day === value;
}

function evaluate(post: SavedPost, node: QueryNode, negated: boolean, tags?: TagLookup, creators?: CreatorNames): boolean {
  switch (node.kind) {
    case "and": return node.items.every(item => evaluate(post, item, negated, tags, creators));
    case "or": return node.items.some(item => evaluate(post, item, negated, tags, creators));
    case "not": return !evaluate(post, node.item, !negated, tags, creators);
    case "text": {
      const text = haystack(post);
      // Left out with "-": a whole word only, so -video keeps "videos" (a phrase is matched as written).
      return negated && !node.phrase ? hasWholeWord(text, node.value) : text.includes(node.value);
    }
    case "op": {
      const v = node.value;
      switch (node.field) {
        case "site": return onSite((post.domain || "").toLowerCase(), v);
        case "is": return isMatch(post, v);
        case "shelf": return post.categories.some(c => c.toLowerCase() === v);
        case "in": return (post.folderPath ?? []).some(name => name.toLowerCase() === v);
        case "tag": {
          const wanted = tags ? tags.expand(v) : [v];
          return post.tags.some(tag => { const t = tag.toLowerCase(); return wanted.some(w => t === w || t.startsWith(w + "/")); });
        }
        case "no": return isEmpty(post, v) === true;
        case "has": return isEmpty(post, v) === false;
        case "saved": return dateMatches(post.createdAt, v);
        case "opened": return dateMatches(post.lastOpenedAt, v);
        case "creator": return !!creators && creators(post).some(name => name.toLowerCase().includes(v));
      }
    }
  }
  return false;
}

export function matchesQuery(post: SavedPost, q: ParsedQuery, tags?: TagLookup, creators?: CreatorNames): boolean {
  return !q.tree || evaluate(post, q.tree, false, tags, creators);
}

// ── Saying how a search was read (the chips under the search box) ──

const quoted = (v: string) => (/[\s()"]/.test(v) ? `"${v}"` : v);
function label(node: QueryNode): string {
  if (node.kind === "text") return node.phrase ? `the phrase “${node.value}”` : `“${node.value}”`;
  if (node.kind === "op") {
    switch (node.field) {
      case "tag": return `#${node.value}`;
      case "site": return `site ${node.value}`;
      case "shelf": return `shelf ${node.value}`;
      case "in": return `folder ${node.value}`;
      case "is": return node.value;
      case "no": return `no ${node.value}`;
      case "has": return `has ${node.value}`;
      case "saved": return `saved ${node.value}`;
      case "opened": return `opened ${node.value}`;
      case "creator": return `by ${node.value}`;
    }
  }
  if (node.kind === "not") return `not ${label(node.item)}`;
  if (node.kind === "or") return `any of: ${node.items.map(label).join(", ")}`;
  return node.items.map(label).join(" and ");
}

/** One short phrase per part of the search, in order: what the library is filtered by. */
export function describeQuery(q: ParsedQuery): string[] {
  if (!q.tree) return [];
  const parts = q.tree.kind === "and" ? q.tree.items : [q.tree];
  return parts.map(part => {
    if (part.kind === "not" && part.item.kind === "text" && !part.item.phrase) return `not the word “${part.item.value}”`;
    if (part.kind === "not" && part.item.kind === "or") return `none of: ${part.item.items.map(label).join(", ")}`;
    return label(part);
  });
}

/** The search text for a node (smart shelves write their rules this way). */
export function queryText(node: QueryNode | null, top = true): string {
  if (!node) return "";
  switch (node.kind) {
    case "text": return node.phrase || /[\s()]/.test(node.value) ? `"${node.value}"` : node.value;
    case "op": return node.field === "tag" ? `#${quoted(node.value)}` : `${node.field}:${quoted(node.value)}`;
    case "not": {
      const inner = queryText(node.item, false);
      return node.item.kind === "and" || node.item.kind === "or" ? `-${inner.startsWith("(") ? inner : `(${inner})`}` : `-${inner}`;
    }
    case "or": { const text = node.items.map(i => queryText(i, false)).join(" or "); return top ? text : `(${text})`; }
    case "and": { const text = node.items.map(i => queryText(i, false)).join(" "); return top ? text : `(${text})`; }
  }
}
