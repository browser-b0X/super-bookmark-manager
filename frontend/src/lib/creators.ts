import type { Creator, CreatorHandle, SavedPost } from "../types";

/**
 * Creators (v0.4.0): who made the posts you saved, built only from what the posts already hold (their address,
 * author and title). Nothing is fetched to make them, and nothing is followed: "new since you looked" counts posts
 * that arrived by themselves (imports, Telegram, the extension).
 */
export interface PostAuthor { platform: CreatorHandle["platform"]; handle: string; name: string; profile: string }

const SKIP_X = new Set(["i", "home", "search", "explore", "hashtag", "intent", "share"]);

/** A name as SQLite keeps it: no control or invisible characters (they could make a name show as another, so the app
 *  refuses them), spaces collapsed, at most 200 characters. */
export const cleanName = (value: string) =>
  Array.from(value.replace(/\p{Cc}/gu, " ").replace(/\p{C}/gu, "").replace(/\s+/g, " ").trim()).slice(0, 200).join("").trim();
/** The most one creator holds, as SQLite allows. */
export const LIMITS = { aliases: 50, handles: 20, urls: 20 };

/** Who made a saved post, from its address, author and title (nothing fetched); null when it doesn't say. */
export function authorOf(post: SavedPost): PostAuthor | null {
  let url: URL;
  try { url = new URL(post.url); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^(www|mobile|m|old)\./, "");
  const path = url.pathname.split("/").filter(Boolean);
  const name = cleanName(post.author ?? "");
  if (host === "x.com" || host === "twitter.com") {
    const handle = path[1] === "status" && /^[A-Za-z0-9_]{1,15}$/.test(path[0] ?? "") ? path[0] : "";
    if (!handle || SKIP_X.has(handle.toLowerCase())) return null;
    return { platform: "x", handle: handle.toLowerCase(), name: name || handle, profile: `https://x.com/${handle}` };
  }
  if (host === "tiktok.com") {
    const m = /^@([A-Za-z0-9._]{1,40})$/.exec(path[0] ?? "");
    return m ? { platform: "tiktok", handle: m[1].toLowerCase(), name: name || m[1], profile: `https://www.tiktok.com/@${m[1]}` } : null;
  }
  if (host === "instagram.com") {
    // The Save window and the bookmark button call an Instagram post "<handle> on Instagram".
    const m = /^([A-Za-z0-9._]{1,30}) on Instagram\b/.exec(post.title ?? "") ?? /^@?([A-Za-z0-9._]{1,30})$/.exec(name);
    return m ? { platform: "instagram", handle: m[1].toLowerCase(), name: m[1], profile: `https://www.instagram.com/${m[1]}/` } : null;
  }
  if (host === "reddit.com") {
    const m = /^u\/([A-Za-z0-9_-]{2,30})$/.exec(name) ?? (path[0] === "user" || path[0] === "u" ? /^([A-Za-z0-9_-]{2,30})$/.exec(path[1] ?? "") : null);
    return m ? { platform: "reddit", handle: m[1].toLowerCase(), name: `u/${m[1]}`, profile: `https://www.reddit.com/user/${m[1]}/` } : null;
  }
  if ((host === "youtube.com" || host === "youtu.be") && name) return { platform: "youtube", handle: "", name, profile: "" };
  return null;
}

const lower = (s: string) => s.trim().toLowerCase();
export const handleLabel = (h: CreatorHandle) => (h.platform === "reddit" ? `u/${h.handle}` : h.platform === "instagram" ? h.handle : `@${h.handle}`);
export const PLATFORM_LABEL: Record<CreatorHandle["platform"], string> = { x: "X", instagram: "Instagram", tiktok: "TikTok", reddit: "Reddit", youtube: "YouTube" };

export type Match = { by: "handle" | "name" | "other name"; creator: Creator } | { by: "ambiguous"; options: Creator[] } | { by: "none" };

/** The creator a post's author is: by platform and handle, then name, then another name; only when exactly one
 *  fits (more than one is the owner's to decide). */
export function matchCreator(creators: Creator[], author: PostAuthor): Match {
  const steps: [Match["by"], (c: Creator) => boolean][] = [
    ["handle", c => !!author.handle && c.handles.some(h => h.platform === author.platform && h.handle === author.handle)],
    ["name", c => lower(c.name) === lower(author.name)],
    ["other name", c => c.aliases.some(a => lower(a) === lower(author.name))],
  ];
  for (const [by, test] of steps) {
    const found = creators.filter(test);
    if (found.length === 1) return { by, creator: found[0] } as Match;
    if (found.length > 1) return { by: "ambiguous", options: found };
  }
  return { by: "none" };
}

export interface FindPlan {
  /** Authors no creator has yet: one new creator each (the owner can untick). */
  fresh: { key: string; author: PostAuthor; postIds: string[]; alsoNamed?: string }[];
  /** Posts that join a creator you have, and why. */
  joining: { key: string; creatorId: string; author: PostAuthor; postIds: string[]; by: string }[];
  /** More than one creator fits: the owner picks one, a new creator, or skips. */
  ambiguous: { key: string; author: PostAuthor; postIds: string[]; options: string[] }[];
}

/** What "Find creators in your saved posts" proposes for the posts that have no creator yet. */
export function findCreators(posts: SavedPost[], creators: Creator[]): FindPlan {
  const groups = new Map<string, { author: PostAuthor; postIds: string[] }>();
  for (const post of posts) {
    if (post.creatorId && creators.some(c => c.id === post.creatorId)) continue;
    const author = authorOf(post);
    if (!author) continue;
    const key = `${author.platform}:${author.handle || lower(author.name)}`;
    const group = groups.get(key);
    if (group) group.postIds.push(post.id); else groups.set(key, { author, postIds: [post.id] });
  }
  const plan: FindPlan = { fresh: [], joining: [], ambiguous: [] };
  for (const [key, { author, postIds }] of groups) {
    const match = matchCreator(creators, author);
    if (match.by === "none") plan.fresh.push({ key, author, postIds });
    else if (match.by === "ambiguous") plan.ambiguous.push({ key, author, postIds, options: match.options.map(c => c.id) });
    else plan.joining.push({ key, creatorId: match.creator.id, author, postIds, by: match.by });
  }
  // Two new ones with the same name may be one person: said, never merged without the owner.
  for (const item of plan.fresh) {
    const twin = plan.fresh.find(other => other !== item && lower(other.author.name) === lower(item.author.name));
    if (twin) item.alsoNamed = `${PLATFORM_LABEL[twin.author.platform]} ${handleLabel(twin.author)}`;
  }
  return plan;
}

export const newCreatorId = () => `c-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;

/** A new creator for an author. */
export function creatorFor(author: PostAuthor, at: string): Creator {
  return { id: newCreatorId(), name: author.name, aliases: [], handles: author.handle ? [{ platform: author.platform, handle: author.handle }] : [],
    urls: author.profile ? [author.profile] : [], updatedAt: at };
}

/** A creator as SQLite takes it: names cleaned, lists within their limits. One SQLite refused would not be kept. */
export function fitCreator(creator: Creator): Creator {
  const name = cleanName(creator.name) || creator.handles[0]?.handle || "?";
  const aliases = unique(creator.aliases.map(cleanName).filter(a => a && lower(a) !== lower(name)), lower).slice(0, LIMITS.aliases);
  return { ...creator, name, aliases, handles: creator.handles.slice(0, LIMITS.handles), urls: creator.urls.slice(0, LIMITS.urls),
    ...(creator.notes !== undefined ? { notes: creator.notes.slice(0, 2000) } : {}),
    ...(creator.about !== undefined ? { about: creator.about.slice(0, 1000) } : {}) };
}

/** A creator with an author's handle and profile added (nothing removed). */
export function withAuthor(creator: Creator, author: PostAuthor): Creator {
  const handles = author.handle && !creator.handles.some(h => h.platform === author.platform && h.handle === author.handle)
    ? [...creator.handles, { platform: author.platform, handle: author.handle }] : creator.handles;
  const urls = author.profile && !creator.urls.includes(author.profile) ? [...creator.urls, author.profile] : creator.urls;
  return handles === creator.handles && urls === creator.urls ? creator : { ...creator, handles, urls };
}

/** Who else already goes by this name (main or other), if anyone: then it's a merge, the owner's call. */
export function nameOwner(creators: Creator[], selfId: string, name: string): Creator | null {
  const wanted = lower(name);
  return creators.find(c => c.id !== selfId && (lower(c.name) === wanted || c.aliases.some(a => lower(a) === wanted))) ?? null;
}

export type Keep = "this" | "other";
export interface MergeChoices { notes: Keep; picture: Keep; about: Keep }
const unique = <T,>(items: T[], key: (t: T) => string) => { const seen = new Set<string>(); return items.filter(i => { const k = key(i); if (seen.has(k)) return false; seen.add(k); return true; }); };

/** Sensible starting choices: the kept creator's value, or the other's when the kept one has none. */
export function defaultChoices(into: Creator, from: Creator): MergeChoices {
  const pick = (a?: string, b?: string): Keep => (!a?.trim() && b?.trim() ? "other" : "this");
  return { notes: pick(into.notes, from.notes), picture: pick(into.picture, from.picture), about: pick(into.about, from.about) };
}

/** `from` merged into `into`: the kept name stays, the other's name becomes another name, lists are joined. */
export function mergeCreators(into: Creator, from: Creator, choices: MergeChoices, at: string): Creator {
  return {
    ...into,
    aliases: unique([...into.aliases, from.name, ...from.aliases], lower).filter(a => lower(a) !== lower(into.name)),
    handles: unique([...into.handles, ...from.handles], h => `${h.platform}:${h.handle}`),
    urls: unique([...into.urls, ...from.urls], u => u),
    notes: choices.notes === "this" ? into.notes : from.notes,
    picture: choices.picture === "this" ? into.picture : from.picture,
    about: choices.about === "this" ? into.about : from.about,
    reviewed: into.reviewed || from.reviewed,
    kept: { ...from.kept, ...into.kept },
    updatedAt: at,
  };
}

// ── Refresh from the profile page: what's new, field by field ──

/** What the profile page shows (from the app's /api/creators/profile). */
export interface ProfilePage { name: string; about: string; picture: string }
export type RefreshField = "name" | "about" | "picture";
export type RefreshChoice = "keep" | "take" | "alias";
export interface RefreshRow { field: RefreshField; now: string; page: string; choice: RefreshChoice; options: RefreshChoice[]; clash?: string }

/** Only what differs, and not what the owner chose to keep last time (so a second refresh with nothing new is
 *  "nothing new"). Defaults: keep what the creator has; take only where it has nothing. */
export function refreshRows(creator: Creator, page: ProfilePage, creators: Creator[] = []): RefreshRow[] {
  const rows: RefreshRow[] = [];
  const kept = creator.kept ?? {};
  const known = (v: string) => lower(v) === lower(creator.name) || creator.aliases.some(a => lower(a) === lower(v));
  if (page.name && !known(page.name) && kept.name !== page.name) {
    const other = nameOwner(creators, creator.id, page.name);
    rows.push({ field: "name", now: creator.name, page: page.name, choice: "keep", options: other ? ["keep"] : ["keep", "alias", "take"],
      ...(other ? { clash: other.name } : {}) });
  }
  if (page.about && page.about !== (creator.about ?? "") && kept.about !== page.about) {
    rows.push({ field: "about", now: creator.about ?? "", page: page.about, choice: creator.about?.trim() ? "keep" : "take", options: ["keep", "take"] });
  }
  if (page.picture && page.picture !== (creator.picture ?? "") && kept.picture !== page.picture) {
    rows.push({ field: "picture", now: creator.picture ?? "", page: page.picture, choice: creator.picture ? "keep" : "take", options: ["keep", "take"] });
  }
  return rows;
}

/** The creator's change for the owner's choices; values kept against the page are remembered. */
export function applyRefresh(creator: Creator, rows: RefreshRow[]): Partial<Creator> {
  const patch: Partial<Creator> = {};
  const kept = { ...(creator.kept ?? {}) };
  let aliases = creator.aliases;
  for (const row of rows) {
    if (row.choice === "keep") { kept[row.field] = row.page; continue; }
    delete kept[row.field];
    if (row.field === "name" && row.choice === "take") {
      patch.name = row.page;
      aliases = [creator.name, ...aliases.filter(a => lower(a) !== lower(row.page))];
    } else if (row.field === "name") {
      aliases = [...aliases, row.page];
    } else {
      patch[row.field] = row.page;
    }
  }
  if (aliases !== creator.aliases) patch.aliases = aliases;
  patch.kept = kept;
  return patch;
}
