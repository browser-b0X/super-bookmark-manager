import { storageKey } from "../lib/publicRuntime";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ActivityEvent, Category, Creator, Project, RemovedLink, SavedPost, SavedView, TagInfo } from "../types";
import { libraryUrl, normalizeUrl, slugId } from "../lib/platform";
import { libraryStorage } from "../lib/libraryStorage";
import { postFromUrl } from "../lib/providers";
import { CANONICAL_SHELVES, migrateToCanonicalShelves, reopenRecentQueue } from "./migrations";
import { appendBoundedShelves, needsCategory, RESERVED_SHELVES, TOPICAL_SHELF_LIMIT } from "../lib/shelves";
import { viewName, viewCriteria } from "../lib/savedViews";
import { editPost, type BulkEdit, type EditRecord } from "../lib/bulkEdit";
import { fitTag, infoOf, mergePlan } from "../lib/tags";
import { authorOf, fitCreator, mergeCreators, newCreatorId, withAuthor, type MergeChoices } from "../lib/creators";
import { mergedPost, postKey } from "../lib/duplicates";
import { capMarks, keptPost, reattachPatch, rememberRemoved, REMOVED_LIMIT } from "../lib/removedLinks";

/** A creator change as Undo needs it: the creator records before it, the ones it made, and the posts it moved
 *  (with the creator each had). Undo leaves alone what changed since. */
export interface CreatorChange { at: string; before: Creator[]; created: string[]; links: { id: string; creatorId?: string }[] }

/** A tag merge as Undo needs it: the links that changed (with their tags before), the tag records before, and the
 *  records the merge made. */
export interface TagMerge { source: string; target: string; at: string; links: { id: string; at: string; tags: string[] }[]; before: TagInfo[]; created: string[] }

/** Links of one post merged into one, as Undo needs it: the kept link before, and the removed links' records. */
export interface DuplicateMerge { at: string; keep: SavedPost; removed: string[] }

/** A batch in the History list (v0.4.0), and how to undo it. Any of them can be undone, not only the last; links and
 *  records changed since are left as they are. */
export type HistoryUndo =
  | { kind: "edit"; records: EditRecord[] }
  | { kind: "tags"; merge: TagMerge }
  | { kind: "creators"; change: CreatorChange }
  | { kind: "duplicates"; merge: DuplicateMerge }
  | { kind: "removed"; ids: string[] }
  | { kind: "ai"; changes: AiChange[] };
export interface HistoryEntry { id: string; at: string; text: string; count: number; undo: HistoryUndo; undone?: { at: string; restored: number; skipped: number } }
export const HISTORY_LIMIT = 50;
/** The time of the change an undo payload belongs to: an Undo from a note marks its History entry undone too. */
const stampOf = (undo: HistoryUndo) => undo.kind === "edit" ? undo.records[0]?.at : undo.kind === "tags" ? undo.merge.at
  : undo.kind === "creators" ? undo.change.at : undo.kind === "duplicates" ? undo.merge.at : undefined;
const tagList = (values: string[]) => values.map(v => `#${v}`).join(" ");
/** A bulk edit in words, for History ("added #to-bake; status reference"). */
function editText(edit: BulkEdit): string {
  const verb = { add: "added", remove: "took off", replace: "set" } as const;
  return [
    edit.tags?.values.length ? `${verb[edit.tags.mode]} ${tagList(edit.tags.values)}` : "",
    edit.shelves?.values.length ? `${verb[edit.shelves.mode]} the shelf ${edit.shelves.values.join(", ")}` : "",
    edit.status ? `status ${edit.status}` : "",
  ].filter(Boolean).join("; ");
}
import { mergeActivity, mergeById, mergeCategories, mergeDeletions, mergeDone, mergeImports, mergeQueue, mergeViews, union, type Deletions } from "../lib/cacheMerge";
import { wantsCopyOfNewLinks } from "../lib/copyAvailability";
import { isInstagramPost } from "../lib/instagram";

// Legacy source values (SQLite `source` column) → canonical platform.
const LEGACY_PLATFORM: Record<string, SavedPost["platform"]> = {
  instagram: "instagram",
  "x.com": "x",
  x: "x",
  youtube: "youtube",
  reddit: "reddit",
  tiktok: "tiktok",
  github: "github",
};

export const CAT_COLORS = ["#6c8cff", "#3ddad7", "#ffb454", "#a78bfa", "#ff8f50", "#4ade80", "#e1306c", "#7ec8ff"];

/** A shelf change for SQLite. `id` (this browser only, never sent) lets two tabs' queues merge without repeats. */
export type CategoryOp = ({ op: "add"; name: string } | { op: "delete"; name: string } | { op: "rename"; from: string; to: string }) & { id?: string };

/** One import run, for the history list and undo. */
export interface ImportRecord {
  id: string;
  at: string;
  source: "html" | "chromium" | "firefox-db" | "firefox-json" | "telegram" | "whatsapp" | "pocket" | "pocket-html" | "instapaper";
  fileName: string;
  added: number;
  updated: number;
  skipped: number;
  filed: number;
  undone?: { at: string; removed: number; kept: number };
}

/** A post the owner has worked with since import (undo keeps these unless asked). */
/** The saved link for `url` in any spelling: exact href, or the canonical form a browser
 * import stores as its own href (`https://a.com/` vs `https://a.com`). */
export function findSavedByUrl(posts: SavedPost[], url: string): SavedPost | undefined {
  let wanted: SavedPost;
  try { wanted = postFromUrl(url, "manual"); } catch { return undefined; }
  const exact = libraryUrl(wanted.url);
  return posts.find(p => libraryUrl(p.url) === exact
    || (p.canonicalUrl || normalizeUrl(p.url)) === wanted.canonicalUrl
    || normalizeUrl(p.canonicalUrl || p.url) === wanted.canonicalUrl);
}

/**
 * A status the owner chose (Keep, Later, Archive, Done) marks the link as worked
 * with, so "Undo import" keeps it: an import's own "reference" looks the same.
 */
function ownerStatus(post: SavedPost, patch: Partial<SavedPost>): Partial<SavedPost> {
  return patch.status && patch.status !== post.status ? { ...patch, fieldSources: { ...post.fieldSources, ...patch.fieldSources, status: "user" } } : patch;
}

/** A background job's change to one link, worked out from the link as it is when applied. */
export type BackgroundChange = Partial<SavedPost> | ((post: SavedPost) => Partial<SavedPost> | null);

/** The automatic shelf for a link, or null when it has one already (or the owner filed it). */
function automaticCategory(post: SavedPost, category: string, shelves: Category[]): Partial<SavedPost> | null {
  if (!needsCategory(post)) return null;
  const name = shelves.some(c => c.name === category && !c.archived && category !== "uncategorized") ? category : "other";
  const review = name === "other";
  if (post.categoryMode === "automatic" && post.categoryReview === review && post.categories.length === 1 && post.categories[0] === name) return null;
  return { categories: [name], categoryMode: "automatic", categoryReview: review };
}

/** "My order": the owner's places first (lower first), then links never put in order, newest first. */
export function byMyOrder(a: SavedPost, b: SavedPost): number {
  return (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) || b.createdAt.localeCompare(a.createdAt);
}

export function touchedSinceImport(post: SavedPost): boolean {
  return !!(post.userNotes?.trim() || post.favorite || post.pinned || post.lastOpenedAt || post.followUpAt || post.useOften
    || !["inbox", "reference"].includes(post.status)
    || Object.values(post.fieldSources ?? {}).includes("user"));
}

/** One reviewed suggestion from Settings > AI & previews. */
export interface AiSuggestion { id: string; shelf?: string; tags?: string[]; title?: string; summary?: string }

/** What one background AI change did to a link, kept so the run can be undone. */
export interface AiChange { id: string; before: Partial<SavedPost>; after: Partial<SavedPost> }
/** The fields an AI suggestion can change (and an undo puts back). */
export const AI_FIELDS = ["categories", "categoryMode", "categoryReview", "tags", "title", "originalTitle", "fieldSources", "aiSummary", "aiCheckedAt"] as const;

/** A change SQLite refused; kept visible until the owner retries or discards it. */
export interface RejectedChange { post: SavedPost; reason: string; error?: string; at: string }

interface LibraryState {
  posts: SavedPost[];
  categories: Category[];
  projects: Project[];
  views: SavedView[];
  activity: ActivityEvent[];
  migrated: boolean;
  demo: boolean;
  pending: Record<string, SavedPost | null>;
  deletedUrls: string[];
  /** Shelf changes not yet acknowledged by SQLite, in order. */
  categoryOps: CategoryOp[];
  /** Links the owner explicitly re-added after deleting them. */
  undeleteUrls: string[];
  /** Legacy Telegram rows folded into an existing post (or skipped as deleted). */
  adoptedUrls: string[];
  rejected: Record<string, RejectedChange>;
  /** Links removed by undoing an import: deleted from SQLite without a tombstone. */
  purgeUrls: string[];
  /** When each link in purgeUrls was last changed as this tab saw it: SQLite keeps a link
   *  changed since (in another tab or window) instead of removing it. */
  purgeSeen?: Record<string, string>;
  imports: ImportRecord[];
  /** Saved views and shelves deleted in this browser, and when (see lib/cacheMerge). */
  deletedViews?: Deletions;
  deletedCategories?: Deletions;
  /** Ids of shelf changes SQLite has acknowledged, so another tab's copy of the queue doesn't send them again. */
  doneOps?: string[];
  /** The views and view deletions SQLite last acknowledged (as JSON): different means they need sending. */
  viewsSent?: string;
  /** Tags' own records (nested tags, other names), tags deleted here and when, and what SQLite last acknowledged. */
  tagInfo: TagInfo[];
  deletedTags?: Deletions;
  tagsSent?: string;
  /** Creators (v0.4.0), creators deleted here and when, and what SQLite last acknowledged. */
  creators: Creator[];
  deletedCreators?: Deletions;
  creatorsSent?: string;
  /** Removed links, remembered (v0.4.0, lib/removedLinks), records forgotten here and when, and what SQLite last acknowledged. */
  removed: RemovedLink[];
  deletedRemoved?: Deletions;
  removedSent?: string;
  /** What changed many links at once, newest first, in this browser. */
  history: HistoryEntry[];
  /** Last SQLite revision merged into this cache (0 = ask for everything). */
  syncRev: number;
  /** Which library this cache holds: SQLite's epoch when last read. A restore replaces the
   *  library and moves it on (absent: never read from a server that has one, counts as 0). */
  syncEpoch?: number;

  // posts
  importPosts(incoming: SavedPost[]): { added: number; updated: number; skipped: number };
  /** `copy: false` keeps a new link from being queued for a saved copy (the Save window's box). */
  addByUrl(url: string, options?: { copy?: boolean }): SavedPost | null;
  retryRejected(url: string): void;
  recordImport(record: Omit<ImportRecord, "at">): void;
  undoImport(batchId: string, includeTouched: boolean): { removed: number; kept: number };
  discardRejected(url: string): void;
  updatePost(id: string, patch: Partial<SavedPost>): void;
  applyAutomaticCategory(id: string, category: string): void;
  /** Background results for many links at once (see updatePostInBackground). */
  applyBackgroundChanges(changes: Map<string, BackgroundChange[]>): void;
  bulkPatch(ids: string[], patch: Partial<SavedPost>): void;
  /** Put many links on one more shelf in a single write (their other shelves stay; "other" and "uncategorized" go). */
  addToShelf(ids: string[], shelf: string): number;
  /** Move many links from one shelf to another in a single write (their other shelves stay). */
  moveToShelf(ids: string[], from: string, to: string): number;
  /** Put shelves back exactly as they were (undo for a move). */
  restoreCategories(before: { id: string; categories: string[]; categoryMode?: SavedPost["categoryMode"]; categoryReview?: boolean }[]): void;
  /** Apply AI suggestions in one write; `checked` are the links this run looked at (they stop coming back).
   *  Reviewed ones file links like a manual choice; `automatic` ones (sorted in the background, not reviewed)
   *  keep the shelf automatic. Returns what changed on each link, before and after. */
  applyAiSuggestions(items: AiSuggestion[], checked?: string[], options?: { automatic?: boolean }): AiChange[];
  /** Undo background AI changes; a field the owner has changed since is left as it is. Returns links restored. */
  restoreAiChanges(changes: AiChange[]): number;
  restoreOriginalTitle(id: string): void;
  /** Save a hand-arranged order: the given ids, first to last. */
  reorderPosts(orderedIds: string[]): void;
  /** Remove links. Each is remembered with what it held (lib/removedLinks), so it can come back; returns the History entry. */
  deletePosts(ids: string[]): string | null;
  /** Removed links back as they were; one whose address is in the library again is left. */
  bringBack(ids: string[]): { restored: number; skipped: number };
  /** A link takes back what a removed link of the same post held; the record goes. */
  reattachRemoved(removedId: string, postId: string): void;
  forgetRemoved(ids: string[]): void;
  /** Links of one post merged into `keepId` (lib/duplicates mergedPost); the others are removed and remembered. */
  mergeDuplicates(keepId: string, otherIds: string[]): DuplicateMerge | null;
  undoDuplicateMerge(merge: DuplicateMerge): { restored: number; skipped: number };
  recordHistory(text: string, count: number, undo: HistoryUndo): string;
  /** Undo one History entry, any of them; null when it is gone or already undone. */
  undoHistory(id: string): { restored: number; skipped: number } | null;
  touchOpened(id: string): void;

  // categories
  addCategory(name: string): Category | null;
  renameCategory(id: string, name: string): void;
  recolorCategory(id: string, color: string): void;
  reorderCategories(orderedIds: string[]): void;
  archiveCategory(id: string, archived: boolean): void;
  deleteCategory(id: string): void;

  // tags / projects / views
  allTags(): string[];
  bulkTag(ids: string[], add: string[], remove: string[]): void;
  /** Bulk edit: one write for the selection; what each changed link held before, for Undo. */
  bulkEdit(ids: string[], edit: BulkEdit): EditRecord[];
  /** Put back a bulk edit, for links nobody changed since; how many came back and how many were left. */
  undoEdit(records: EditRecord[]): { restored: number; skipped: number };
  /** Set a tag's parents or other names (checked by the caller with lib/tags). */
  setTagInfo(name: string, change: { parents?: string[]; aliases?: string[] }): void;
  /** Merge one tag into another (also a rename): its links take the target, its name stays as another name. */
  mergeTag(source: string, target: string): TagMerge;
  undoTagMerge(merge: TagMerge): { restored: number; skipped: number };
  /** New or changed creators, and posts that now say who made them (post id -> creator id). */
  saveCreators(changed: Creator[], attach: Record<string, string>): void;
  /** Change a creator; returns the change's time, so an Undo can leave alone a creator changed again since. */
  updateCreator(id: string, patch: Partial<Creator>): string;
  /** Put a creator back as it was, only if it hasn't changed since `at`. */
  revertCreator(id: string, at: string, before: Partial<Creator>): boolean;
  /** When each creator's page was last looked at, in this browser ("new since you looked"). Not synced, so opening a
   *  page never writes over another browser's changes to that creator. */
  creatorSeen: Record<string, string>;
  seeCreator(id: string): void;
  /** "Same person": `fromId` merged into `intoId`; its posts move over. */
  mergeCreator(fromId: string, intoId: string, choices: MergeChoices): CreatorChange;
  /** Posts moved to another creator, or to a new one (by name); handles no other post uses go with them. */
  moveToCreator(postIds: string[], to: { id: string } | { name: string }): CreatorChange;
  undoCreatorChange(change: CreatorChange): { restored: number; skipped: number };
  addProject(name: string): void;
  saveView(name: string, filter: SavedView["filter"]): string;
  renameView(id: string, name: string): void;
  updateView(id: string, filter: SavedView["filter"]): void;
  deleteView(id: string): void;

  // misc
  logActivity(kind: ActivityEvent["kind"], text: string, detail?: string): void;
  migrateLegacy(rows: Record<string, unknown>[], cats: { name: string; count: number; description?: string }[]): void;
  adoptServerCategories(rows: Record<string, unknown>[]): { categories: number; thumbnails: number };
  seedDemo(): void;
}

const nowIso = () => new Date().toISOString();
const uid = () => "id-" + Math.random().toString(36).slice(2, 10);

export { libraryUrl };

/** Set by the first read of the cache (see `merge`); later reads are other tabs' writes. */
let hydratedOnce = false;

export const useLibrary = create<LibraryState>()(
  persist(
    (rawSet, get) => {
      const set = (patch: Partial<LibraryState>) => {
        if (patch.posts && !(patch.demo ?? get().demo)) {
          // Every change replaces only the posts it touches (`posts.map(p => p.id === id ? {...} : p)`),
          // so a post that is the same object as before is unchanged: only new objects are
          // compared field by field. Comparing all of them on every write froze the page
          // for seconds after a big import, when previews and shelves arrive many per second.
          const before = get().posts;
          const kept = new Set(before);
          let byId: Map<string, SavedPost> | undefined;
          let pending: Record<string, SavedPost | null> | undefined;
          for (const post of patch.posts) {
            if (kept.has(post)) continue;
            byId ??= new Map(before.map(p => [p.id, p]));
            const previous = byId.get(post.id);
            if (previous && previous.url === post.url && JSON.stringify(previous) === JSON.stringify(post)) continue;
            pending ??= { ...get().pending, ...patch.pending };
            pending[libraryUrl(post.url)] = post;
          }
          if (pending) patch = { ...patch, pending };
        }
        rawSet(patch);
      };
      /** Links removed (or merged into `into`): gone from the library with deletion marks for SQLite, and remembered
       *  (lib/removedLinks). Demo cards are not the owner's links: neither marked nor remembered. */
      const removing = (gone: SavedPost[], at: string, into?: SavedPost): RemovedLink[] => {
        if (!gone.length) return [];
        const state = get();
        const ids = new Set(gone.map(p => p.id));
        const urls = gone.map(p => libraryUrl(p.url));
        const pending = { ...state.pending };
        if (state.demo) {
          set({ posts: state.posts.filter(p => !ids.has(p.id)) });
          return [];
        }
        urls.forEach(url => { pending[url] = null; });
        // At most REMOVED_LIMIT of a batch are remembered (and can be brought back).
        const memories = gone.slice(0, REMOVED_LIMIT).map(p => rememberRemoved(p, at, into));
        const fresh = new Set(memories.map(m => m.id));
        const all = [...memories, ...(state.removed ?? []).filter(r => !fresh.has(r.id))].sort((a, b) => b.removedAt.localeCompare(a.removedAt));
        // The oldest records beyond the limit go, in SQLite too.
        const deletedRemoved = { ...state.deletedRemoved, ...Object.fromEntries(all.slice(REMOVED_LIMIT).map(r => [r.id, at])) };
        for (const r of all.slice(0, REMOVED_LIMIT)) delete deletedRemoved[r.id];
        set({
          posts: state.posts.filter(p => !ids.has(p.id)),
          deletedUrls: [...new Set([...state.deletedUrls, ...urls])],
          pending,
          removed: all.slice(0, REMOVED_LIMIT),
          deletedRemoved: capMarks(deletedRemoved),
        });
        return all.slice(0, REMOVED_LIMIT).filter(r => fresh.has(r.id));
      };
      const forgetting = (ids: string[], at: string) => {
        const gone = new Set(ids);
        set({ removed: (get().removed ?? []).filter(r => !gone.has(r.id)),
          deletedRemoved: capMarks({ ...get().deletedRemoved, ...Object.fromEntries(ids.map(id => [id, at])) }) });
      };
      const markUndone = (stamp: string, result: { restored: number; skipped: number }) => {
        if (!(get().history ?? []).some(h => !h.undone && stampOf(h.undo) === stamp)) return;
        set({ history: get().history.map(h => (!h.undone && stampOf(h.undo) === stamp ? { ...h, undone: { at: nowIso(), ...result } } : h)) });
      };

      return {
      posts: [],
      pending: {},
      deletedUrls: [],
      categoryOps: [],
      undeleteUrls: [],
      adoptedUrls: [],
      rejected: {},
      purgeUrls: [],
      imports: [],
      syncRev: 0,
      // A fresh install starts on the default shelves rather than growing a
      // category per link.
      categories: [
        ...CANONICAL_SHELVES.map((s, i) => ({
          id: s.name, name: s.name, description: s.description,
          color: CAT_COLORS[i % CAT_COLORS.length], order: i,
        })),
        { id: "other", name: "other", description: "No shelf fits these yet.", color: "#63636f", order: 900 },
        { id: "uncategorized", name: "uncategorized", description: "Not sorted yet.", color: "#63636f", order: 999 },
      ],
      projects: [],
      views: [],
      tagInfo: [],
      creators: [],
      creatorSeen: {},
      removed: [],
      history: [],
      activity: [],
      migrated: false,
      demo: false,

      importPosts(incoming) {
        if (incoming.length && get().demo) rawSet({ posts: [], pending: {}, deletedUrls: [], demo: false });
        // Copy-on-write: a post is copied only when the import changes it, and lookups go
        // by index and id sets (one scan of the library, not one per imported link).
        const posts = get().posts.slice();
        // Canonical keys are normalized on both sides: a browser import stores its exact
        // href as canonicalUrl, a WhatsApp or pasted link the normalized form.
        const byCanonical = new Map(posts.map((p, i) => [normalizeUrl(p.canonicalUrl || p.url), i]));
        // File imports retain fragments/query values. Match older records by
        // their original URL too, without replacing their IDs or curated fields.
        const byExactUrl = new Map(posts.map((p, i) => [libraryUrl(p.url), i]));
        const ids = new Set(posts.map(p => p.id));
        let added = 0, updated = 0, skipped = 0;
        const copies = wantsCopyOfNewLinks();
        const deleted = new Set(get().deletedUrls);
        // A post the owner removed (or merged into another link) stays out at any of its addresses.
        // By the record's address (its stored key is not trusted: a backup could carry any).
        const removedPosts = new Set((get().removed ?? []).map(r => postKey(r.url)).filter(Boolean));
        for (const item of incoming) {
          if (deleted.has(libraryUrl(item.url))) { skipped++; continue; }
          if (removedPosts.size && !byExactUrl.has(libraryUrl(item.url)) && removedPosts.has(postKey(item.url) ?? "")) { skipped++; continue; }
          const key = normalizeUrl(item.canonicalUrl || item.url);
          // The exact link always matches first: two posts with one URL would make
          // SQLite refuse every later edit to that link as a duplicate.
          const at = byExactUrl.get(libraryUrl(item.url))
            ?? (item.telegramMessage || item.source === "browser" ? undefined : byCanonical.get(key));
          if (at !== undefined) {
            const existing = posts[at];
            // Idempotent: refresh source metadata only, preserve organization.
            const patch: Partial<SavedPost> = { sourceMessageId: existing.sourceMessageId ?? item.sourceMessageId };
            if (item.telegramMessage && !existing.telegramMessage) patch.telegramMessage = item.telegramMessage;
            if (item.excerpt && !existing.excerpt) patch.excerpt = item.excerpt;
            if (item.folderPath?.length && !existing.folderPath?.length) patch.folderPath = item.folderPath;
            if ((Object.keys(patch) as (keyof SavedPost)[]).some(k => existing[k] !== patch[k])) posts[at] = { ...existing, ...patch };
            updated++;
          } else if (ids.has(item.id)) {
            skipped++;
          } else {
            // The copy queue (lib/savedCopies) picks up links marked "pending".
            const fresh = copies && !item.archiveStatus && !isInstagramPost(item.url) ? { ...item, archiveStatus: "pending" as const } : item;
            posts.push(fresh);
            byCanonical.set(key, posts.length - 1);
            byExactUrl.set(libraryUrl(item.url), posts.length - 1);
            ids.add(item.id);
            added++;
          }
        }
        if (added) {
          set({ posts });
          get().logActivity("import", `Imported ${added} saved link${added === 1 ? "" : "s"}`, updated ? `${updated} already present` : undefined);
        } else if (updated) {
          set({ posts });
        }
        return { added, updated, skipped };
      },

      addByUrl(url, options = {}) {
        try { if (!["http:", "https:"].includes(new URL(url.trim()).protocol)) return null; } catch { return null; }
        if (get().demo) rawSet({ posts: [], pending: {}, deletedUrls: [], demo: false });
        const post = postFromUrl(url, "manual");
        const exact = libraryUrl(post.url);
        const dup = findSavedByUrl(get().posts, url);
        if (dup) return dup;
        // Typing a deleted link back in is an explicit request to keep it again.
        if (get().deletedUrls.includes(exact)) {
          rawSet({
            deletedUrls: get().deletedUrls.filter(u => u !== exact),
            undeleteUrls: [...new Set([...get().undeleteUrls, exact])],
          });
        }
        // Instagram posts are saved only through the bookmark button, which brings what the page shows.
        if (wantsCopyOfNewLinks() && options.copy !== false && !isInstagramPost(post.url)) post.archiveStatus = "pending";
        set({ posts: [post, ...get().posts] });
        get().logActivity("post", "Added link", post.title);
        return post;
      },

      recordImport(record) {
        set({ imports: [{ ...record, at: nowIso() }, ...get().imports].slice(0, 50) });
      },

      undoImport(batchId, includeTouched) {
        const batch = get().posts.filter(p => p.importBatchId === batchId);
        const remove = batch.filter(p => includeTouched || !touchedSinceImport(p));
        const urls = remove.map(p => libraryUrl(p.url));
        const gone = new Set(urls);
        const pending = { ...get().pending };
        urls.forEach(url => { delete pending[url]; });
        // Not a delete: no tombstone, so the same file can be imported again.
        rawSet({
          posts: get().posts.filter(p => !gone.has(libraryUrl(p.url))),
          pending,
          purgeUrls: get().demo ? get().purgeUrls : [...new Set([...get().purgeUrls, ...remove.map(p => p.url)])],
          purgeSeen: get().demo ? get().purgeSeen : { ...get().purgeSeen, ...Object.fromEntries(remove.map(p => [p.url, p.updatedAt])) },
          imports: get().imports.map(r => (r.id === batchId
            ? { ...r, undone: { at: nowIso(), removed: remove.length, kept: batch.length - remove.length } } : r)),
        });
        get().logActivity("import", `Undid an import`, `${remove.length} removed, ${batch.length - remove.length} kept`);
        return { removed: remove.length, kept: batch.length - remove.length };
      },

      retryRejected(url) {
        const item = get().rejected[url];
        if (!item) return;
        const rejected = { ...get().rejected };
        delete rejected[url];
        // Re-apply the owner's edit (SQLite's version is what is shown meanwhile).
        const next = { ...item.post, updatedAt: nowIso() };
        const exists = get().posts.some(p => libraryUrl(p.url) === url);
        rawSet({
          rejected,
          pending: { ...get().pending, [url]: next },
          posts: exists ? get().posts.map(p => (libraryUrl(p.url) === url ? next : p)) : [next, ...get().posts],
        });
      },

      discardRejected(url) {
        const rejected = { ...get().rejected };
        delete rejected[url];
        // "Discard to keep the saved version": the refused edit is still what this
        // tab shows, so read the whole library from SQLite again (syncRev 0).
        rawSet({ rejected, syncRev: 0 });
        void import("../lib/libraryPersistence").then(m => m.syncLibrary());
      },

      updatePost(id, patch) {
        if (patch.categories) patch = { ...patch, categoryMode: "manual", categoryReview: false };
        set({ posts: get().posts.map(p => (p.id === id ? { ...p, ...ownerStatus(p, patch), updatedAt: nowIso() } : p)) });
      },

      applyAutomaticCategory(id, category) {
        const post = get().posts.find(p => p.id === id);
        const patch = post && !post.reviewed && automaticCategory(post, category, get().categories);
        if (!patch) return;
        set({ posts: get().posts.map(p => p.id === id ? { ...p, ...patch, updatedAt: nowIso() } : p) });
      },

      applyBackgroundChanges(changes) {
        let touched = false;
        const posts = get().posts.map(p => {
          const list = changes.get(p.id);
          if (!list) return p;
          let next = p;
          for (const change of list) {
            const patch = typeof change === "function" ? change(next) : change;
            if (patch) next = { ...next, ...patch };
          }
          if (next === p) return p;
          touched = true;
          return { ...next, updatedAt: nowIso() };
        });
        if (touched) set({ posts });
      },

      addToShelf(ids, shelf) {
        const idSet = new Set(ids);
        const at = nowIso();
        // Filing a link takes it out of the "not filed yet" places.
        const placeholder = (c: string) => c === "uncategorized" || (c === "other" && shelf !== "other");
        let n = 0;
        const posts = get().posts.map(p => {
          if (!idSet.has(p.id) || (p.categories.includes(shelf) && !p.categories.some(placeholder))) return p;
          n += 1;
          return { ...p, categories: [...p.categories.filter(c => !placeholder(c) && c !== shelf), shelf], categoryMode: "manual" as const, categoryReview: false, updatedAt: at };
        });
        if (n) set({ posts });
        return n;
      },

      moveToShelf(ids, from, to) {
        if (from === to) return 0;
        const idSet = new Set(ids);
        const at = nowIso();
        let n = 0;
        const posts = get().posts.map(p => {
          if (!idSet.has(p.id) || !p.categories.includes(from)) return p;
          n += 1;
          const rest = p.categories.filter(c => c !== from && c !== to && c !== "uncategorized" && !(c === "other" && to !== "other"));
          return { ...p, categories: [...rest, to], categoryMode: "manual" as const, categoryReview: false, updatedAt: at };
        });
        if (n) set({ posts });
        return n;
      },

      restoreCategories(before) {
        const byId = new Map(before.map(b => [b.id, b]));
        const at = nowIso();
        let n = 0;
        const posts = get().posts.map(p => {
          const b = byId.get(p.id);
          if (!b) return p;
          n += 1;
          return { ...p, categories: b.categories, categoryMode: b.categoryMode, categoryReview: b.categoryReview, updatedAt: at };
        });
        if (n) set({ posts });
      },

      bulkPatch(ids, patch) {
        if (patch.categories) patch = { ...patch, categoryMode: "manual", categoryReview: false };
        const idSet = new Set(ids);
        set({ posts: get().posts.map(p => (idSet.has(p.id) ? { ...p, ...ownerStatus(p, patch), updatedAt: nowIso() } : p)) });
      },

      applyAiSuggestions(items, checked = [], options = {}) {
        const byId = new Map(items.map(item => [item.id, item]));
        const seen = new Set(checked);
        const at = nowIso();
        let marked = 0;
        const changes: AiChange[] = [];
        const record = (before: SavedPost, after: SavedPost) => {
          const was: Partial<SavedPost> = {}, now: Partial<SavedPost> = {};
          for (const field of AI_FIELDS) {
            if (JSON.stringify(before[field]) === JSON.stringify(after[field])) continue;
            (was as Record<string, unknown>)[field] = before[field];
            (now as Record<string, unknown>)[field] = after[field];
          }
          changes.push({ id: before.id, before: was, after: now });
        };
        const posts = get().posts.map(p => {
          const s = byId.get(p.id);
          if (!s) {
            if (!seen.has(p.id)) return p;
            marked += 1;
            const next = { ...p, aiCheckedAt: at, updatedAt: at };
            if (options.automatic) record(p, next);
            return next;
          }
          const next: SavedPost = { ...p, ...(seen.has(p.id) ? { aiCheckedAt: at } : {}) };
          if (s.shelf && get().categories.some(c => c.name === s.shelf && !c.archived)) {
            if (options.automatic) {
              // Sorted in the background, not reviewed: an automatic shelf ("other" still asks for a look).
              next.categories = [s.shelf];
              next.categoryMode = "automatic";
              next.categoryReview = s.shelf === "other";
            } else {
              // Reviewed and accepted by the owner: treated like a manual choice.
              next.categories = [s.shelf];
              next.categoryMode = "manual";
              next.categoryReview = false;
            }
          }
          if (s.tags?.length) next.tags = [...new Set([...p.tags, ...s.tags])];
          if (s.title && s.title !== p.title && p.fieldSources?.title !== "user") {
            next.originalTitle = p.originalTitle ?? p.title ?? "";
            next.title = s.title;
            next.fieldSources = { ...p.fieldSources, title: "ai" };
          }
          if (s.summary) next.aiSummary = s.summary;
          if (JSON.stringify(next) === JSON.stringify(p)) return p;
          // Only the checked-mark changed: counted as looked at, not as a changed link.
          if (JSON.stringify({ ...next, aiCheckedAt: p.aiCheckedAt }) === JSON.stringify(p)) marked += 1;
          record(p, next);
          return { ...next, updatedAt: at };
        });
        if (changes.length || marked) set({ posts });
        // Reviewed runs report real changes only; a background run also keeps the checked marks (to undo them).
        return options.automatic ? changes : changes.filter(c => Object.keys(c.after).some(f => f !== "aiCheckedAt"));
      },

      restoreAiChanges(changes) {
        const byId = new Map(changes.map(c => [c.id, c]));
        const at = nowIso();
        let n = 0;
        const posts = get().posts.map(p => {
          const c = byId.get(p.id);
          if (!c) return p;
          const next = { ...p } as Record<string, unknown>;
          let touched = false;
          for (const [field, value] of Object.entries(c.after)) {
            // The owner changed it since the AI did: theirs stays.
            if (JSON.stringify(next[field]) !== JSON.stringify(value)) continue;
            const before = (c.before as Record<string, unknown>)[field];
            if (before === undefined) delete next[field]; else next[field] = before;
            touched = true;
          }
          if (!touched) return p;
          n += 1;
          return { ...(next as unknown as SavedPost), updatedAt: at };
        });
        if (n) set({ posts });
        return n;
      },

      reorderPosts(orderedIds) {
        // The ids may be a filtered view's links (a shelf, a search): they take the places those links
        // already hold in "My order", so the links around and between them keep theirs.
        const order = [...get().posts].sort(byMyOrder);
        const moving = new Set(orderedIds);
        const slots = order.flatMap((p, i) => (moving.has(p.id) ? [i] : []));
        const known = new Set(order.map(p => p.id));
        const placed = [...new Set(orderedIds)].filter(id => known.has(id));
        if (!slots.length || slots.length !== placed.length) return;
        const next = order.map(p => p.id);
        slots.forEach((slot, k) => { next[slot] = placed[k]; });
        // Each place keeps its number; links never put in order (no number) get one after the
        // highest, up to the last moved link. Numbers that tie or go backwards are renumbered.
        const last = slots[slots.length - 1];
        const highest = order.reduce((max, p) => Math.max(max, p.position ?? 0), 0);
        let numbered = 0;
        let values = order.slice(0, last + 1).map(p => p.position ?? highest + 16 * ++numbered);
        let end = last;
        if (values.some((value, i) => i > 0 && value <= values[i - 1])) {
          values = order.map((_, i) => (i + 1) * 16);
          end = order.length - 1;
        }
        const position = new Map(next.slice(0, end + 1).map((id, i) => [id, values[i]]));
        const now = nowIso();
        set({ posts: get().posts.map(p => {
          const value = position.get(p.id);
          return value === undefined || p.position === value ? p : { ...p, position: value, updatedAt: now };
        }) });
      },

      restoreOriginalTitle(id) {
        set({ posts: get().posts.map(p => {
          if (p.id !== id || p.originalTitle === undefined) return p;
          const { originalTitle, ...rest } = p;
          return { ...rest, title: originalTitle || undefined, fieldSources: { ...p.fieldSources, title: "user" }, updatedAt: nowIso() };
        }) });
      },

      deletePosts(ids) {
        const idSet = new Set(ids);
        const gone = get().posts.filter(p => idSet.has(p.id));
        const memories = removing(gone, nowIso());
        get().logActivity("organize", `Deleted ${ids.length} item${ids.length === 1 ? "" : "s"}`);
        const text = gone.length > memories.length ? `Removed ${gone.length} links (${memories.length} can be brought back)`
          : `Removed ${memories.length} link${memories.length === 1 ? "" : "s"}`;
        return memories.length ? get().recordHistory(text, memories.length, { kind: "removed", ids: memories.map(m => m.id) }) : null;
      },

      bringBack(ids) {
        const at = nowIso();
        const state = get();
        const wanted = new Set(ids);
        const live = new Set(state.posts.map(p => libraryUrl(p.url)));
        const liveIds = new Set(state.posts.map(p => p.id));
        const back = (state.removed ?? []).filter(r => wanted.has(r.id) && !live.has(libraryUrl(r.url)) && !liveIds.has(r.post.id)
          && (liveIds.add(r.post.id), live.add(libraryUrl(r.url))));       // one link per id and address, also within the batch
        if (back.length) {
          // As typing a removed link back in: SQLite drops its deletion mark.
          const urls = new Set(back.map(r => libraryUrl(r.url)));
          rawSet({ deletedUrls: state.deletedUrls.filter(u => !urls.has(u)), undeleteUrls: [...new Set([...state.undeleteUrls, ...urls])] });
          set({ posts: [...back.map(r => ({ ...keptPost(r.post), updatedAt: at })), ...get().posts] });
          forgetting(back.map(r => r.id), at);
        }
        return { restored: back.length, skipped: ids.length - back.length };
      },

      reattachRemoved(removedId, postId) {
        const record = (get().removed ?? []).find(r => r.id === removedId);
        if (!record) return;
        const at = nowIso();
        set({ posts: get().posts.map(p => (p.id === postId ? { ...p, ...reattachPatch(p, record.post, at) } : p)) });
        forgetting([removedId], at);
      },

      forgetRemoved(ids) {
        forgetting(ids, nowIso());
      },

      mergeDuplicates(keepId, otherIds) {
        const state = get();
        const keep = state.posts.find(p => p.id === keepId);
        const others = state.posts.filter(p => p.id !== keepId && otherIds.includes(p.id));
        if (!keep || !others.length) return null;
        const at = nowIso();
        const merged = mergedPost(keep, others, at);
        set({ posts: get().posts.map(p => (p.id === keepId ? merged : p)) });
        const memories = removing(others, at, keep);
        const merge = { at, keep, removed: memories.map(m => m.id) };
        get().recordHistory(`Merged ${others.length + 1} links of one post into “${keep.title || keep.url}”`, others.length + 1, { kind: "duplicates", merge });
        get().logActivity("organize", "Merged links of one post", keep.title);
        return merge;
      },

      undoDuplicateMerge(merge) {
        const now = get().posts.find(p => p.id === merge.keep.id);
        const kept = !!now && now.updatedAt === merge.at;              // changed again since: left as it is
        if (kept) set({ posts: get().posts.map(p => (p.id === merge.keep.id ? { ...merge.keep, updatedAt: nowIso() } : p)) });
        const back = get().bringBack(merge.removed);
        const result = { restored: back.restored + (kept ? 1 : 0), skipped: back.skipped + (kept ? 0 : 1) };
        markUndone(merge.at, result);
        return result;
      },

      recordHistory(text, count, undo) {
        const entry: HistoryEntry = { id: `h-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: nowIso(), text, count, undo };
        set({ history: [entry, ...(get().history ?? [])].slice(0, HISTORY_LIMIT) });
        return entry.id;
      },

      undoHistory(id) {
        const entry = (get().history ?? []).find(h => h.id === id);
        if (!entry || entry.undone) return null;
        const undo = entry.undo;
        const result = undo.kind === "edit" ? get().undoEdit(undo.records)
          : undo.kind === "tags" ? get().undoTagMerge(undo.merge)
          : undo.kind === "creators" ? get().undoCreatorChange(undo.change)
          : undo.kind === "duplicates" ? get().undoDuplicateMerge(undo.merge)
          : undo.kind === "removed" ? get().bringBack(undo.ids)
          : (() => { const n = get().restoreAiChanges(undo.changes); return { restored: n, skipped: undo.changes.length - n }; })();
        set({ history: get().history.map(h => (h.id === id && !h.undone ? { ...h, undone: { at: nowIso(), ...result } } : h)) });
        return result;
      },

      touchOpened(id) {
        const post = get().posts.find(p => p.id === id);
        if (post) get().updatePost(id, { lastOpenedAt: nowIso(), openCount: (post.openCount ?? 0) + 1 });
      },

      addCategory(name) {
        const clean = name.trim().toLowerCase().replace(/\s+/g, "-");
        if (!clean) return null;
        if (get().categories.some(c => c.name === clean)) return null;
        if (!RESERVED_SHELVES.has(clean) && get().categories.filter(c => !RESERVED_SHELVES.has(c.name)).length >= TOPICAL_SHELF_LIMIT) return null;
        // A renamed shelf keeps its old id, so a new shelf with that old name needs another one.
        let id = clean;
        for (let n = 2; get().categories.some(c => c.id === id); n++) id = `${clean}-${n}`;
        const cat: Category = {
          id, name: clean, order: get().categories.length,
          color: CAT_COLORS[get().categories.length % CAT_COLORS.length], updatedAt: nowIso(),
        };
        set({ categories: [...get().categories, cat], categoryOps: [...get().categoryOps, { op: "add", name: clean, id: uid() }] });
        return cat;
      },

      renameCategory(id, name) {
        const clean = name.trim().toLowerCase().replace(/\s+/g, "-");
        const cat = get().categories.find(c => c.id === id);
        if (!cat || !clean || clean === cat.name || RESERVED_SHELVES.has(cat.name) || RESERVED_SHELVES.has(clean)
          || get().categories.some(c => c.id !== id && c.name === clean)) return;
        // The ID stays put: saved views and /library/category/<id> links keep
        // working, and only the display name (which posts reference) changes.
        // A rename is not a judgement on the filing, so auto-filed posts keep
        // their automatic mode and review flag.
        set({
          categories: get().categories.map(c => (c.id === id ? { ...c, name: clean, updatedAt: nowIso() } : c)),
          posts: get().posts.map(p => (p.categories.includes(cat.name)
            ? { ...p, categories: p.categories.map(c => (c === cat.name ? clean : c)), updatedAt: nowIso() }
            : p)),
          categoryOps: [...get().categoryOps, { op: "rename", from: cat.name, to: clean, id: uid() }],
        });
      },

      recolorCategory(id, color) {
        set({ categories: get().categories.map(c => (c.id === id ? { ...c, color, updatedAt: nowIso() } : c)) });
      },

      reorderCategories(orderedIds) {
        const byId = new Map(get().categories.map(c => [c.id, c]));
        const next: Category[] = [];
        const at = nowIso();
        orderedIds.forEach((cid, i) => {
          const c = byId.get(cid);
          if (c) next.push(c.order === i ? c : { ...c, order: i, updatedAt: at });
        });
        get().categories.forEach(c => { if (!orderedIds.includes(c.id)) next.push(c); });
        set({ categories: next });
      },

      archiveCategory(id, archived) {
        set({ categories: get().categories.map(c => (c.id === id ? { ...c, archived, updatedAt: nowIso() } : c)) });
      },

      deleteCategory(id) {
        const cat = get().categories.find(c => c.id === id);
        if (!cat || RESERVED_SHELVES.has(cat.name)) return;
        set({
          categories: get().categories.filter(c => c.id !== id),
          deletedCategories: { ...get().deletedCategories, [id]: nowIso() },
          posts: get().posts.map(p => (p.categories.includes(cat.name)
            ? { ...p, categories: p.categories.filter(c => c !== cat.name), categoryMode: "manual", categoryReview: false, updatedAt: nowIso() }
            : p)),
          categoryOps: [...get().categoryOps, { op: "delete", name: cat.name, id: uid() }],
        });
      },

      allTags() {
        const s = new Set<string>();
        get().posts.forEach(p => p.tags.forEach(t => s.add(t)));
        return [...s].sort();
      },

      bulkEdit(ids, edit) {
        const idSet = new Set(ids);
        const at = nowIso();
        const records: EditRecord[] = [];
        const posts = get().posts.map(p => {
          if (!idSet.has(p.id)) return p;
          const patch = editPost(p, edit);
          if (!patch) return p;
          records.push({ id: p.id, at, before: { tags: p.tags, categories: p.categories, categoryMode: p.categoryMode, categoryReview: p.categoryReview, status: p.status } });
          return { ...p, ...ownerStatus(p, patch), updatedAt: at };
        });
        if (records.length) {
          set({ posts });
          get().recordHistory(`Bulk edit: ${editText(edit) || "changed"}`, records.length, { kind: "edit", records });
        }
        return records;
      },

      undoEdit(records) {
        const byId = new Map(records.map(r => [r.id, r]));
        const at = nowIso();
        let restored = 0;
        const posts = get().posts.map(p => {
          const record = byId.get(p.id);
          if (!record || p.updatedAt !== record.at) return p;      // changed again since: left as it is
          restored += 1;
          return { ...p, ...record.before, updatedAt: at };
        });
        if (restored) set({ posts });
        const result = { restored, skipped: records.length - restored };
        if (records[0]) markUndone(records[0].at, result);
        return result;
      },

      setTagInfo(name, change) {
        const at = nowIso();
        const current = infoOf(get().tagInfo, name);
        const next = fitTag({ ...current, ...change, id: name, name, updatedAt: at });
        if (!next) return;
        const deletedTags = { ...get().deletedTags };
        delete deletedTags[name];
        set({ tagInfo: [...get().tagInfo.filter(t => t.name !== name), next], deletedTags });
      },

      mergeTag(source, target) {
        const at = nowIso();
        const state = get();
        const links: TagMerge["links"] = [];
        const posts = state.posts.map(p => {
          if (!p.tags.includes(source)) return p;
          links.push({ id: p.id, at, tags: p.tags });
          return { ...p, tags: [...new Set(p.tags.map(t => (t === source ? target : t)))], updatedAt: at };
        });
        const planned = mergePlan(state.tagInfo, source, target, at);
        const plan = { ...planned, write: planned.write.map(fitTag).filter((t): t is TagInfo => !!t) };
        const written = new Set(plan.write.map(t => t.name));
        const before = state.tagInfo.filter(t => written.has(t.name) || plan.remove.includes(t.name));
        const created = plan.write.filter(t => !state.tagInfo.some(s => s.name === t.name)).map(t => t.name);
        const deletedTags = { ...state.deletedTags, ...Object.fromEntries(plan.remove.map(name => [name, at])) };
        for (const name of written) delete deletedTags[name];
        set({ posts, deletedTags,
          tagInfo: [...state.tagInfo.filter(t => !written.has(t.name) && !plan.remove.includes(t.name)), ...plan.write] });
        const merge = { source, target, at, links, before, created };
        get().recordHistory(`Merged #${source} into #${target}`, links.length, { kind: "tags", merge });
        return merge;
      },

      undoTagMerge(merge) {
        const at = nowIso();
        const byId = new Map(merge.links.map(l => [l.id, l]));
        let restored = 0;
        const posts = get().posts.map(p => {
          const link = byId.get(p.id);
          if (!link || p.updatedAt !== merge.at) return p;        // changed again since: left as it is
          restored += 1;
          return { ...p, tags: link.tags, updatedAt: at };
        });
        // Tag records changed since the merge (here or in another tab) are left as they are, as links are.
        // A record gone since counts as untouched only when this merge removed it (its deletion mark is the merge's).
        const untouched = (name: string) => { const now = get().tagInfo.find(t => t.name === name); return now ? now.updatedAt === merge.at : get().deletedTags?.[name] === merge.at; };
        const back = merge.before.filter(t => untouched(t.name)).map(t => ({ ...t, updatedAt: at }));
        const created = merge.created.filter(name => get().tagInfo.find(t => t.name === name)?.updatedAt === merge.at);
        const names = new Set([...back.map(t => t.name), ...created]);
        const deletedTags = { ...get().deletedTags, ...Object.fromEntries(created.map(name => [name, at])) };
        for (const t of back) delete deletedTags[t.name];
        set({ posts, deletedTags, tagInfo: [...get().tagInfo.filter(t => !names.has(t.name)), ...back] });
        const result = { restored, skipped: merge.links.length - restored };
        markUndone(merge.at, result);
        return result;
      },

      saveCreators(changed, attach) {
        const at = nowIso();
        const ids = new Set(changed.map(c => c.id));
        const deletedCreators = { ...get().deletedCreators };
        for (const id of ids) delete deletedCreators[id];
        set({
          creators: [...get().creators.filter(c => !ids.has(c.id)), ...changed.map(c => fitCreator({ ...c, updatedAt: at }))],
          deletedCreators,
          posts: get().posts.map(p => (attach[p.id] && attach[p.id] !== p.creatorId ? { ...p, creatorId: attach[p.id], updatedAt: at } : p)),
        });
      },

      updateCreator(id, patch) {
        const at = nowIso();
        set({ creators: get().creators.map(c => (c.id === id ? fitCreator({ ...c, ...patch, id, updatedAt: at }) : c)) });
        return at;
      },

      revertCreator(id, at, before) {
        const now = get().creators.find(c => c.id === id);
        if (!now || now.updatedAt !== at) return false;              // changed again since: left as it is
        get().updateCreator(id, before);
        return true;
      },

      seeCreator(id) {
        set({ creatorSeen: { ...(get().creatorSeen ?? {}), [id]: nowIso() } });
      },

      mergeCreator(fromId, intoId, choices) {
        const at = nowIso();
        const state = get();
        const from = state.creators.find(c => c.id === fromId)!;
        const into = state.creators.find(c => c.id === intoId)!;
        const links: CreatorChange["links"] = [];
        const posts = state.posts.map(p => {
          if (p.creatorId !== fromId) return p;
          links.push({ id: p.id, creatorId: fromId });
          return { ...p, creatorId: intoId, updatedAt: at };
        });
        set({ posts, deletedCreators: { ...state.deletedCreators, [fromId]: at },
          creators: state.creators.filter(c => c.id !== fromId).map(c => (c.id === intoId ? fitCreator(mergeCreators(into, from, choices, at)) : c)) });
        const change = { at, before: [into, from], created: [], links };
        get().recordHistory(`Merged ${from.name} into ${into.name}`, links.length, { kind: "creators", change });
        return change;
      },

      moveToCreator(postIds, to) {
        const at = nowIso();
        const state = get();
        const moving = new Set(postIds);
        let creators = [...state.creators];
        const targetId = "id" in to ? to.id : newCreatorId();
        const created = "id" in to ? [] : [targetId];
        if (!("id" in to)) creators.push({ id: targetId, name: to.name, aliases: [], handles: [], urls: [], updatedAt: at });
        const touched = new Map<string, Creator>();
        const links: CreatorChange["links"] = [];
        const posts = state.posts.map(p => {
          if (!moving.has(p.id) || p.creatorId === targetId) return p;
          links.push({ id: p.id, creatorId: p.creatorId });
          return { ...p, creatorId: targetId, updatedAt: at };
        });
        // A moved post's handle goes with it when no post left with its old creator uses it.
        for (const link of links) {
          const post = state.posts.find(p => p.id === link.id)!;
          const author = authorOf(post);
          if (!author) continue;
          const target = creators.find(c => c.id === targetId)!;
          if (!touched.has(targetId) && !created.includes(targetId)) touched.set(targetId, target);
          creators = creators.map(c => (c.id === targetId ? { ...withAuthor(c, author), updatedAt: at } : c));
          const old = creators.find(c => c.id === link.creatorId);
          const stillUsed = posts.some(p => p.creatorId === link.creatorId && authorOf(p)?.handle === author.handle && authorOf(p)?.platform === author.platform);
          if (old && author.handle && !stillUsed) {
            if (!touched.has(old.id)) touched.set(old.id, state.creators.find(c => c.id === old.id)!);
            creators = creators.map(c => (c.id === old.id ? { ...c, handles: c.handles.filter(h => !(h.platform === author.platform && h.handle === author.handle)),
              urls: c.urls.filter(u => u !== author.profile), updatedAt: at } : c));
          }
        }

        creators = creators.map(c => (c.updatedAt === at ? fitCreator(c) : c));
        set({ posts, creators, deletedCreators: Object.fromEntries(Object.entries(state.deletedCreators ?? {}).filter(([id]) => !created.includes(id))) });
        const change = { at, before: [...touched.values()], created, links };
        get().recordHistory(`Moved ${links.length} post${links.length === 1 ? "" : "s"} to ${creators.find(c => c.id === targetId)?.name ?? "another creator"}`, links.length, { kind: "creators", change });
        return change;
      },

      undoCreatorChange(change) {
        const at = nowIso();
        const byId = new Map(change.links.map(l => [l.id, l]));
        let restored = 0;
        const posts = get().posts.map(p => {
          const link = byId.get(p.id);
          if (!link || p.updatedAt !== change.at) return p;          // changed again since: left as it is
          restored += 1;
          return { ...p, creatorId: link.creatorId, updatedAt: at };
        });
        const current = get().creators;
        // A creator gone since counts as untouched only when this change removed it (merged away by it).
        const untouched = (id: string) => { const now = current.find(c => c.id === id); return now ? now.updatedAt === change.at : get().deletedCreators?.[id] === change.at; };
        const back = change.before.filter(c => untouched(c.id)).map(c => ({ ...c, updatedAt: at }));
        const gone = change.created.filter(id => current.find(c => c.id === id)?.updatedAt === change.at);
        const replaced = new Set([...back.map(c => c.id), ...gone]);
        const deletedCreators = { ...get().deletedCreators, ...Object.fromEntries(gone.map(id => [id, at])) };
        for (const c of back) delete deletedCreators[c.id];
        set({ posts, deletedCreators, creators: [...current.filter(c => !replaced.has(c.id)), ...back] });
        const result = { restored, skipped: change.links.length - restored };
        markUndone(change.at, result);
        return result;
      },

      bulkTag(ids, add, remove) {
        const idSet = new Set(ids);
        set({
          posts: get().posts.map(p => {
            if (!idSet.has(p.id)) return p;
            const tags = new Set(p.tags.filter(t => !remove.includes(t)));
            add.forEach(t => tags.add(t));
            return { ...p, tags: [...tags], updatedAt: nowIso() };
          }),
        });
      },

      addProject(name) {
        const clean = name.trim();
        if (!clean || get().projects.some(p => p.name === clean)) return;
        set({ projects: [...get().projects, { id: uid(), name: clean }] });
      },

      saveView(name, filter) {
        const clean = viewName(name, get().views), id = uid();
        set({ views: [...get().views, { id, name: clean, filter: viewCriteria(filter), updatedAt: nowIso() }] });
        return id;
      },

      renameView(id, name) {
        const clean = viewName(name, get().views, id);
        set({ views: get().views.map(v => v.id === id ? { ...v, name: clean, updatedAt: nowIso() } : v) });
      },

      updateView(id, filter) {
        set({ views: get().views.map(v => v.id === id ? { ...v, filter: viewCriteria(filter), updatedAt: nowIso() } : v) });
      },

      deleteView(id) {
        set({ views: get().views.filter(v => v.id !== id), deletedViews: { ...get().deletedViews, [id]: nowIso() } });
      },

      logActivity(kind, text, detail) {
        set({
          activity: [{ kind, text, detail, time: nowIso() }, ...get().activity].slice(0, 60),
        });
      },

      migrateLegacy(rows, cats) {
        const incoming: SavedPost[] = [];
        for (const r of rows) {
          const url = (r.url as string) || "";
          if (!url) continue;
          const platform: SavedPost["platform"] =
            LEGACY_PLATFORM[(r.source as string || "").toLowerCase()] ?? (url.includes(".") ? "web" : "other");
          let tags: string[] = [];
          try { tags = typeof r.tags === "string" && r.tags ? JSON.parse(r.tags) : []; } catch { /* keep [] */ }
          const category = (r.category as string) || "uncategorized";
          // Legacy Instagram thumbnails are session-signed CDN URLs that expire;
          // drop them so re-enrichment swaps in the locally cached /thumb/ path.
          const rawThumb = (r.thumbnail as string) || undefined;
          const deadThumb = !!rawThumb && rawThumb.includes("cdninstagram.com");
          incoming.push({
            id: `tg-${r.tg_msg_id}`,
            url,
            canonicalUrl: normalizeUrl(url),
            source: "telegram",
            sourceMessageId: String(r.tg_msg_id ?? ""),
            platform,
            domain: (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } })(),
            title: (r.title as string) || undefined,
            description: (r.summary as string) || undefined,
            excerpt: (r.text as string) || undefined,
            thumbnailUrl: deadThumb ? undefined : rawThumb,
            categories: [category],
            tags,
            projectIds: [],
            // A link arrives unread whether or not the categorizer found it a shelf.
            // Being auto-filed is a machine act; catching up is a human one, and
            // conflating them is what used to empty this queue.
            status: "inbox",
            createdAt: (r.date_utc as string) || (r.created_at as string) || nowIso(),
            updatedAt: nowIso(),
            metadataStatus: deadThumb ? "pending" : (r.title || r.thumbnail ? "enriched" : "partial"),
          });
        }
        const catList: Category[] = cats.map((c, i) => ({
          id: c.name, name: c.name, order: i,
          description: c.description || CANONICAL_SHELVES.find(s => s.name === c.name)?.description,
          color: CAT_COLORS[i % CAT_COLORS.length],
        }));
        const merged = appendBoundedShelves(get().categories, catList);
        set({ categories: merged, migrated: true });
        const before = new Set(get().posts.map(p => libraryUrl(p.url)));
        get().importPosts(incoming);
        // A legacy row that did not become its own post (merged into an existing
        // link, or skipped because it was deleted) is reported as adopted, so
        // SQLite stops offering it — otherwise backup export stays blocked.
        const after = new Set(get().posts.map(p => libraryUrl(p.url)));
        const adopted = rows.map(r => String(r.url || "")).filter(u => u && (before.has(libraryUrl(u)) || !after.has(libraryUrl(u))));
        if (adopted.length) rawSet({ adoptedUrls: [...new Set([...get().adoptedUrls, ...adopted])] });
      },

      /**
       * Adopt what the server has since worked out about links already in the store.
       *
       * Two things drift. Categorization runs server-side, so SQLite is the source
       * of truth for it while this store owns the human side (status, favourite,
       * tags, notes). And thumbnails get downloaded into a local cache, replacing
       * hotlinked CDN URLs that expire within days.
       *
       * Without this the two never reconcile: the first import latches `migrated`,
       * every later sweep improves the DB, and the browser keeps showing links
       * parked on `other` next to broken images the server fixed long ago.
       *
       * Only unfiled links change shelf, so a category the user picked by hand
       * always wins. Status is never touched — being classified by a machine is not
       * the same as having been read by a person.
       */
      adoptServerCategories(rows) {
        const byId = new Map<string, Record<string, unknown>>();
        for (const r of rows) {
          if (r.tg_msg_id != null) byId.set(`tg-${r.tg_msg_id}`, r);
        }

        let categories = 0;
        let thumbnails = 0;
        const posts = get().posts.map(p => {
          const row = byId.get(p.id);
          if (!row) return p;
          let next = p;

          const dbCat = String((row.category as string) || "").trim().toLowerCase();
          const unfiled = p.categories.length === 0
            || p.categories.every(c => c === "uncategorized");
          if (p.categoryMode !== "manual" && dbCat && dbCat !== "uncategorized" && unfiled && !p.categories.includes(dbCat)) {
            next = { ...next, categories: [dbCat], updatedAt: nowIso() };
            categories++;
          }

          // A cached copy always beats a hotlink, so this one overwrites rather
          // than only filling a gap.
          const dbThumb = String((row.thumbnail as string) || "");
          if (dbThumb.startsWith("/thumb/") && p.thumbnailUrl !== dbThumb) {
            next = { ...next, thumbnailUrl: dbThumb, metadataStatus: "enriched", updatedAt: nowIso() };
            thumbnails++;
          }

          return next;
        });

        if (categories || thumbnails) set({ posts });
        return { categories, thumbnails };
      },

      seedDemo() {
        if (get().posts.length || get().demo) return;
        const demoUrls = [
          "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          "https://github.com/facebook/react",
          "https://www.instagram.com/p/Cxample123/",
          "https://x.com/example/status/1234567890",
          "https://en.wikipedia.org/wiki/Personal_knowledge_base",
        ];
        const posts = demoUrls.map((u, i) => ({ ...postFromUrl(u, "import"), status: "inbox" as const, createdAt: new Date(Date.now() - i * 86400000).toISOString() }));
        set({ demo: true, posts });
        get().logActivity("import", "Seeded demo data", "Clearly-labeled sample records");
      },
      };
    },
    {
      name: storageKey("library-store-v1"),
      storage: libraryStorage<LibraryState>(),
      version: 6,
      // Another tab (or a reload) may hold edits this tab has not seen: never
      // let rehydration drop unsaved work on either side.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<LibraryState>;
        // A restore replaced the library and another tab may still hold the replaced one: the
        // copy of the newer library wins whole, so links and unsaved edits of the replaced
        // library never come back into it. At start-up this tab holds no library yet (only
        // edits made while the cache was loading), so the first read merges as usual.
        const first = !hydratedOnce;
        hydratedOnce = true;
        const epoch = (state: Partial<LibraryState>) => state.syncEpoch ?? 0;
        if (!first && epoch(saved) !== epoch(current)) {
          return (epoch(saved) > epoch(current) ? { ...current, ...saved } : current) as LibraryState;
        }
        // Per link, the newer unsaved edit wins; a deletion beats any edit.
        const newer = (a: SavedPost | null | undefined, b: SavedPost | null | undefined) => {
          if (a === undefined) return b;
          if (b === undefined) return a;
          if (a === null || b === null) return null;
          return a.updatedAt >= b.updatedAt ? a : b;
        };
        const pending: Record<string, SavedPost | null> = {};
        for (const url of new Set([...Object.keys(saved.pending ?? {}), ...Object.keys(current.pending)])) {
          pending[url] = newer(saved.pending?.[url], current.pending[url]) as SavedPost | null;
        }
        const merged = { ...current, ...saved, pending };
        // Views, shelves, import history, activity and the queues for SQLite: item by item too, so a
        // change this tab made while the other tab was writing isn't lost (lib/cacheMerge).
        const deletedViews = mergeDeletions(saved.deletedViews, current.deletedViews);
        const deletedTags = mergeDeletions(saved.deletedTags, current.deletedTags);
        const deletedCreators = mergeDeletions(saved.deletedCreators, current.deletedCreators);
        const deletedRemoved = mergeDeletions(saved.deletedRemoved, current.deletedRemoved);
        const deletedCategories = mergeDeletions(saved.deletedCategories, current.deletedCategories);
        const doneOps = mergeDone(saved.doneOps, current.doneOps);
        Object.assign(merged, {
          views: mergeViews(current.views, saved.views, deletedViews), deletedViews,
          tagInfo: mergeById(current.tagInfo, saved.tagInfo, deletedTags), deletedTags,
          creators: mergeById(current.creators, saved.creators, deletedCreators), deletedCreators,
          removed: mergeById(current.removed, saved.removed, deletedRemoved), deletedRemoved,
          history: mergeImports(current.history, saved.history, HISTORY_LIMIT),
          categories: mergeCategories(current.categories, saved.categories, deletedCategories), deletedCategories,
          imports: mergeImports(current.imports, saved.imports),
          activity: mergeActivity(current.activity, saved.activity),
          categoryOps: mergeQueue(current.categoryOps, saved.categoryOps, doneOps), doneOps,
          undeleteUrls: union(current.undeleteUrls, saved.undeleteUrls),
          adoptedUrls: union(current.adoptedUrls, saved.adoptedUrls),
          purgeUrls: union(current.purgeUrls, saved.purgeUrls),
          purgeSeen: { ...saved.purgeSeen, ...current.purgeSeen },
          // Oldest first, so the later look at each creator is the one kept.
          creatorSeen: Object.fromEntries([...Object.entries(saved.creatorSeen ?? {}), ...Object.entries(current.creatorSeen ?? {})]
            .sort(([, a], [, b]) => a.localeCompare(b))),
        });
        const byUrl = new Map((merged.posts ?? []).map(p => [libraryUrl(p.url), p]));
        for (const [url, post] of Object.entries(pending)) {
          if (post) byUrl.set(url, post); else byUrl.delete(url);
        }
        merged.posts = [...byUrl.values()];
        return merged as LibraryState;
      },
      migrate: (persisted, version) => {
        let state = persisted;
        // v0 stores hold the 31 grown-by-accident categories; fold them onto the
        // shelves the database now uses.
        if (version < 1) {
          state = migrateToCanonicalShelves(state as Parameters<typeof migrateToCanonicalShelves>[0], CAT_COLORS);
        }
        if (version < 2) state = reopenRecentQueue(state as { posts?: SavedPost[] });
        if (version < 3) {
          const cached = state as LibraryState;
          state = { ...cached, deletedUrls: [], pending: cached.demo ? {} : Object.fromEntries(
            (cached.posts || []).map(p => [libraryUrl(p.url), p])
          ) };
        }
        if (version < 6) {
          state = { syncRev: 0, ...(state as object) };
        }
        if (version < 5) {
          state = { purgeUrls: [], imports: [], ...(state as object) };
        }
        if (version < 4) {
          // Shelf IDs became stable across renames; older stores renamed the ID
          // too, so there is nothing to rewrite — just start the new queues.
          state = { categoryOps: [], undeleteUrls: [], adoptedUrls: [], rejected: {}, ...(state as object) };
        }
        return state as LibraryState;
      },
    }
  )
);

export function categoryIdForName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-") || slugId(name);
}

/*
 * Background work — previews, automatic shelves, saved-copy results — changes many
 * links a second after a big import. Applied one by one, every change re-rendered
 * the open page and re-saved the whole library, and the app lagged for minutes.
 * These changes are gathered and applied together, a few times a second. The
 * owner's own edits never wait: they still go through the store directly.
 */
const backlog = new Map<string, BackgroundChange[]>();
const waiting: (() => void)[] = [];
let backlogTimer: ReturnType<typeof setTimeout> | undefined;
const BACKGROUND_EVERY_MS = 250;

export function flushBackgroundUpdates() {
  if (backlogTimer) { clearTimeout(backlogTimer); backlogTimer = undefined; }
  const changes = new Map(backlog);
  backlog.clear();
  const done = waiting.splice(0);
  if (changes.size) useLibrary.getState().applyBackgroundChanges(changes);
  done.forEach(resolve => resolve());
}

/** Queue a background change to one link; the promise settles once it is applied. */
export function updatePostInBackground(id: string, change: BackgroundChange): Promise<void> {
  const list = backlog.get(id);
  if (list) list.push(change); else backlog.set(id, [change]);
  if (!backlogTimer) backlogTimer = setTimeout(flushBackgroundUpdates, BACKGROUND_EVERY_MS);
  return new Promise(resolve => { waiting.push(resolve); });
}

/** A background automatic shelf, checked against the link and the shelves as they are when applied. */
export function applyAutomaticCategoryInBackground(id: string, category: string): Promise<void> {
  return updatePostInBackground(id, post => (post.reviewed ? null : automaticCategory(post, category, useLibrary.getState().categories)));
}

if (typeof window !== "undefined") window.addEventListener("pagehide", flushBackgroundUpdates);
