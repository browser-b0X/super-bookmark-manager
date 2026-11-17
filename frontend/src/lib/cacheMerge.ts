import type { ActivityEvent, Category, SavedView } from "../types";

/**
 * Two open tabs (the Save window counts) share one library cache. When one writes it, the other
 * re-reads it and merges (store/library.ts `merge`). Links were always merged one by one; the rest
 * used to be taken whole from the tab that wrote last, so a saved view, a shelf change, an import
 * undo or a queued shelf change made in the other tab meanwhile was lost. These merge item by item
 * instead (owner, 2026-10-23: "Merge them, like links").
 */

/** A deleted view or shelf is remembered this long, so the deletion reaches tabs that still have it. */
export const FORGET_DELETIONS_MS = 30 * 86400000;

type Stamped = { id: string; updatedAt?: string };
export type Deletions = Record<string, string>;
/** Own keys only: a tag or view called "constructor" isn't a deletion of Object's. */
const own = (map: object, key: string) => Object.prototype.hasOwnProperty.call(map, key);

/** The newer of each pair of deletion times; ones older than FORGET_DELETIONS_MS are dropped. */
export function mergeDeletions(a: Deletions = {}, b: Deletions = {}, now = Date.now()): Deletions {
  const out: Deletions = {};
  for (const [id, at] of [...Object.entries(a), ...Object.entries(b)]) {
    if (typeof at !== "string" || now - Date.parse(at) > FORGET_DELETIONS_MS) continue;
    if (!own(out, id) || at > out[id]) out[id] = at;
  }
  return out;
}

/** Per id, the copy changed last wins; one deleted after its last change is left out. Order: `mine`'s, then the others'. */
export function mergeById<T extends Stamped>(mine: T[] = [], theirs: T[] = [], deleted: Deletions = {}): T[] {
  const byId = new Map<string, T>();
  for (const item of [...mine, ...theirs]) {
    const known = byId.get(item.id);
    if (!known || (item.updatedAt ?? "") > (known.updatedAt ?? "")) byId.set(item.id, item);
  }
  return [...byId.values()].filter(item => !(own(deleted, item.id) && deleted[item.id] >= (item.updatedAt ?? "")));
}

export function mergeViews(mine: SavedView[] = [], theirs: SavedView[] = [], deleted: Deletions = {}): SavedView[] {
  return mergeById(mine, theirs, deleted);
}

/** Shelves by id; the merged list keeps each shelf's own `order`. */
export function mergeCategories(mine: Category[] = [], theirs: Category[] = [], deleted: Deletions = {}): Category[] {
  return mergeById(mine, theirs, deleted).sort((a, b) => a.order - b.order);
}

interface ImportLike { id: string; at: string; undone?: { at: string } }
/** Import history by id; an undone import stays undone. Newest first, at most `limit`. */
export function mergeImports<T extends ImportLike>(mine: T[] = [], theirs: T[] = [], limit = 50): T[] {
  const byId = new Map<string, T>();
  for (const record of [...mine, ...theirs]) {
    const known = byId.get(record.id);
    if (!known || (record.undone && (!known.undone || record.undone.at > known.undone.at))) byId.set(record.id, record);
  }
  return [...byId.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/** The activity list from both tabs, each event once, newest first. */
export function mergeActivity(mine: ActivityEvent[] = [], theirs: ActivityEvent[] = [], limit = 60): ActivityEvent[] {
  const seen = new Set<string>();
  return [...mine, ...theirs].filter(event => {
    const key = `${event.time}|${event.kind}|${event.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => b.time.localeCompare(a.time)).slice(0, limit);
}

/** Queued changes for SQLite from both tabs, each once, minus the ones either tab already had acknowledged. */
export function mergeQueue<T extends { id?: string }>(mine: T[] = [], theirs: T[] = [], done: string[] = []): T[] {
  const sent = new Set(done);
  const seen = new Set<string>();
  return [...mine, ...theirs].filter(item => {
    const key = item.id ?? JSON.stringify(item);
    if (sent.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Acknowledged queue ids from both tabs, the most recent `limit` (enough to outlast any open tab's queue). */
export const mergeDone = (a: string[] = [], b: string[] = [], limit = 300) => [...new Set([...b, ...a])].slice(-limit);

export const union = (a: string[] = [], b: string[] = []) => [...new Set([...a, ...b])];
