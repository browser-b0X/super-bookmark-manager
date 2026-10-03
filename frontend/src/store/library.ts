import { storageKey } from "../lib/publicRuntime";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ActivityEvent, Category, Project, SavedPost, SavedView } from "../types";
import { libraryUrl, normalizeUrl, slugId } from "../lib/platform";
import { libraryStorage } from "../lib/libraryStorage";
import { postFromUrl } from "../lib/providers";
import { CANONICAL_SHELVES, migrateToCanonicalShelves, reopenRecentQueue } from "./migrations";
import { appendBoundedShelves, needsCategory, RESERVED_SHELVES, TOPICAL_SHELF_LIMIT } from "../lib/shelves";
import { viewName, viewCriteria } from "../lib/savedViews";

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

export type CategoryOp = { op: "add"; name: string } | { op: "delete"; name: string } | { op: "rename"; from: string; to: string };

/** One import run, for the history list and undo. */
export interface ImportRecord {
  id: string;
  at: string;
  source: "html" | "chromium" | "firefox-db" | "firefox-json" | "telegram" | "whatsapp";
  fileName: string;
  added: number;
  updated: number;
  skipped: number;
  filed: number;
  undone?: { at: string; removed: number; kept: number };
}

/** A post the owner has worked with since import (undo keeps these unless asked). */
export function touchedSinceImport(post: SavedPost): boolean {
  return !!(post.userNotes?.trim() || post.favorite || post.pinned || post.lastOpenedAt
    || !["inbox", "reference"].includes(post.status)
    || Object.values(post.fieldSources ?? {}).includes("user"));
}

/** One reviewed suggestion from Settings > AI & previews. */
export interface AiSuggestion { id: string; shelf?: string; tags?: string[]; title?: string; summary?: string }

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
  imports: ImportRecord[];
  /** Last SQLite revision merged into this cache (0 = ask for everything). */
  syncRev: number;

  // posts
  importPosts(incoming: SavedPost[]): { added: number; updated: number; skipped: number };
  addByUrl(url: string): SavedPost | null;
  retryRejected(url: string): void;
  recordImport(record: Omit<ImportRecord, "at">): void;
  undoImport(batchId: string, includeTouched: boolean): { removed: number; kept: number };
  discardRejected(url: string): void;
  updatePost(id: string, patch: Partial<SavedPost>): void;
  applyAutomaticCategory(id: string, category: string): void;
  bulkPatch(ids: string[], patch: Partial<SavedPost>): void;
  /** Save reviewed AI suggestions in one write; returns how many links changed. */
  applyAiSuggestions(items: AiSuggestion[]): number;
  restoreOriginalTitle(id: string): void;
  /** Save a hand-arranged order: the given ids, first to last. */
  reorderPosts(orderedIds: string[]): void;
  deletePosts(ids: string[]): void;
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

export const useLibrary = create<LibraryState>()(
  persist(
    (rawSet, get) => {
      const set = (patch: Partial<LibraryState>) => {
        if (patch.posts && !(patch.demo ?? get().demo)) {
          const previous = new Map(get().posts.map(p => [libraryUrl(p.url), p]));
          const pending = { ...get().pending, ...patch.pending };
          let changed = false;
          for (const post of patch.posts) {
            const url = libraryUrl(post.url);
            if (JSON.stringify(previous.get(url)) !== JSON.stringify(post)) {
              pending[url] = post;
              changed = true;
            }
          }
          if (changed) patch = { ...patch, pending };
        }
        rawSet(patch);
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
      // A fresh install starts on the derived shelves rather than growing a
      // category per link, which is what produced 32 of them for 204 links.
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
      activity: [],
      migrated: false,
      demo: false,

      importPosts(incoming) {
        if (incoming.length && get().demo) rawSet({ posts: [], pending: {}, deletedUrls: [], demo: false });
        const posts = get().posts.map(p => ({ ...p }));
        const byCanonical = new Map(posts.map(p => [p.canonicalUrl || normalizeUrl(p.url), p]));
        const exactUrl = (url: string) => {
          try { return new URL(url).href; } catch { return url; }
        };
        // File imports retain fragments/query values. Match older records by
        // their original URL too, without replacing their IDs or curated fields.
        const byExactUrl = new Map(posts.map(p => [exactUrl(p.url), p]));
        let added = 0, updated = 0, skipped = 0;
        const deleted = new Set(get().deletedUrls);
        for (const item of incoming) {
          if (deleted.has(libraryUrl(item.url))) { skipped++; continue; }
          const key = item.canonicalUrl || normalizeUrl(item.url);
          const existing = item.telegramMessage || item.source === "browser"
            ? byExactUrl.get(exactUrl(item.url)) : byCanonical.get(key);
          if (existing) {
            // Idempotent: refresh source metadata only, preserve organization.
            const patch: Partial<SavedPost> = { sourceMessageId: existing.sourceMessageId ?? item.sourceMessageId };
            if (item.telegramMessage && !existing.telegramMessage) patch.telegramMessage = item.telegramMessage;
            if (item.excerpt && !existing.excerpt) patch.excerpt = item.excerpt;
            if (item.folderPath?.length && !existing.folderPath?.length) patch.folderPath = item.folderPath;
            Object.assign(existing, patch);
            updated++;
          } else if (posts.some(p => p.id === item.id)) {
            skipped++;
          } else {
            posts.push(item);
            byCanonical.set(key, item);
            byExactUrl.set(exactUrl(item.url), item);
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

      addByUrl(url) {
        try { if (!["http:", "https:"].includes(new URL(url.trim()).protocol)) return null; } catch { return null; }
        if (get().demo) rawSet({ posts: [], pending: {}, deletedUrls: [], demo: false });
        const post = postFromUrl(url, "manual");
        const exact = libraryUrl(post.url);
        // Same link in any spelling: exact href, or the canonical form a browser
        // import stores as its own href (`https://a.com/` vs `https://a.com`).
        const dup = get().posts.find(p => libraryUrl(p.url) === exact
          || (p.canonicalUrl || normalizeUrl(p.url)) === post.canonicalUrl
          || normalizeUrl(p.canonicalUrl || p.url) === post.canonicalUrl);
        if (dup) return dup;
        // Typing a deleted link back in is an explicit request to keep it again.
        if (get().deletedUrls.includes(exact)) {
          rawSet({
            deletedUrls: get().deletedUrls.filter(u => u !== exact),
            undeleteUrls: [...new Set([...get().undeleteUrls, exact])],
          });
        }
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
        rawSet({ rejected });
      },

      updatePost(id, patch) {
        if (patch.categories) patch = { ...patch, categoryMode: "manual", categoryReview: false };
        set({ posts: get().posts.map(p => (p.id === id ? { ...p, ...patch, updatedAt: nowIso() } : p)) });
      },

      applyAutomaticCategory(id, category) {
        const post = get().posts.find(p => p.id === id);
        if (!post || !needsCategory(post)) return;
        const name = get().categories.some(c => c.name === category && !c.archived && category !== "uncategorized") ? category : "other";
        const review = name === "other";
        if (post.categoryMode === "automatic" && post.categoryReview === review && post.categories.length === 1 && post.categories[0] === name) return;
        set({ posts: get().posts.map(p => p.id === id
          ? { ...p, categories: [name], categoryMode: "automatic", categoryReview: review, updatedAt: nowIso() } : p) });
      },

      bulkPatch(ids, patch) {
        if (patch.categories) patch = { ...patch, categoryMode: "manual", categoryReview: false };
        const idSet = new Set(ids);
        set({ posts: get().posts.map(p => (idSet.has(p.id) ? { ...p, ...patch, updatedAt: nowIso() } : p)) });
      },

      applyAiSuggestions(items) {
        const byId = new Map(items.map(item => [item.id, item]));
        let changed = 0;
        const posts = get().posts.map(p => {
          const s = byId.get(p.id);
          if (!s) return p;
          const next: SavedPost = { ...p };
          if (s.shelf && get().categories.some(c => c.name === s.shelf && !c.archived)) {
            // Reviewed and accepted by the owner: treated like a manual choice.
            next.categories = [s.shelf];
            next.categoryMode = "manual";
            next.categoryReview = false;
          }
          if (s.tags?.length) next.tags = [...new Set([...p.tags, ...s.tags])];
          if (s.title && s.title !== p.title && p.fieldSources?.title !== "user") {
            next.originalTitle = p.originalTitle ?? p.title ?? "";
            next.title = s.title;
            next.fieldSources = { ...p.fieldSources, title: "ai" };
          }
          if (s.summary) next.aiSummary = s.summary;
          if (JSON.stringify(next) === JSON.stringify(p)) return p;
          changed += 1;
          return { ...next, updatedAt: nowIso() };
        });
        if (changed) set({ posts });
        return changed;
      },

      reorderPosts(orderedIds) {
        const place = new Map(orderedIds.map((id, i) => [id, (i + 1) * 16]));
        set({ posts: get().posts.map(p => {
          const position = place.get(p.id);
          return position === undefined || p.position === position ? p : { ...p, position, updatedAt: nowIso() };
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
        const urls = get().posts.filter(p => idSet.has(p.id)).map(p => libraryUrl(p.url));
        const pending = { ...get().pending };
        const demo = get().demo;
        if (!demo) urls.forEach(url => { pending[url] = null; });
        set({
          posts: get().posts.filter(p => !idSet.has(p.id)),
          // Demo cards are not the owner's links; deleting one must never hide
          // a real bookmark of the same URL later.
          deletedUrls: demo ? get().deletedUrls : [...new Set([...get().deletedUrls, ...urls])],
          pending,
        });
        get().logActivity("organize", `Deleted ${ids.length} item${ids.length === 1 ? "" : "s"}`);
      },

      touchOpened(id) {
        set({ posts: get().posts.map(p => (p.id === id ? { ...p, lastOpenedAt: nowIso() } : p)) });
      },

      addCategory(name) {
        const clean = name.trim().toLowerCase().replace(/\s+/g, "-");
        if (!clean) return null;
        if (get().categories.some(c => c.name === clean)) return null;
        if (!RESERVED_SHELVES.has(clean) && get().categories.filter(c => !RESERVED_SHELVES.has(c.name)).length >= TOPICAL_SHELF_LIMIT) return null;
        const cat: Category = {
          id: clean, name: clean, order: get().categories.length,
          color: CAT_COLORS[get().categories.length % CAT_COLORS.length],
        };
        set({ categories: [...get().categories, cat], categoryOps: [...get().categoryOps, { op: "add", name: clean }] });
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
          categories: get().categories.map(c => (c.id === id ? { ...c, name: clean } : c)),
          posts: get().posts.map(p => (p.categories.includes(cat.name)
            ? { ...p, categories: p.categories.map(c => (c === cat.name ? clean : c)), updatedAt: nowIso() }
            : p)),
          categoryOps: [...get().categoryOps, { op: "rename", from: cat.name, to: clean }],
        });
      },

      recolorCategory(id, color) {
        set({ categories: get().categories.map(c => (c.id === id ? { ...c, color } : c)) });
      },

      reorderCategories(orderedIds) {
        const byId = new Map(get().categories.map(c => [c.id, c]));
        const next: Category[] = [];
        orderedIds.forEach((cid, i) => {
          const c = byId.get(cid);
          if (c) next.push({ ...c, order: i });
        });
        get().categories.forEach(c => { if (!orderedIds.includes(c.id)) next.push(c); });
        set({ categories: next });
      },

      archiveCategory(id, archived) {
        set({ categories: get().categories.map(c => (c.id === id ? { ...c, archived } : c)) });
      },

      deleteCategory(id) {
        const cat = get().categories.find(c => c.id === id);
        if (!cat || RESERVED_SHELVES.has(cat.name)) return;
        set({
          categories: get().categories.filter(c => c.id !== id),
          posts: get().posts.map(p => (p.categories.includes(cat.name)
            ? { ...p, categories: p.categories.filter(c => c !== cat.name), categoryMode: "manual", categoryReview: false, updatedAt: nowIso() }
            : p)),
          categoryOps: [...get().categoryOps, { op: "delete", name: cat.name }],
        });
      },

      allTags() {
        const s = new Set<string>();
        get().posts.forEach(p => p.tags.forEach(t => s.add(t)));
        return [...s].sort();
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
        set({ views: [...get().views, { id, name: clean, filter: viewCriteria(filter) }] });
        return id;
      },

      renameView(id, name) {
        const clean = viewName(name, get().views, id);
        set({ views: get().views.map(v => v.id === id ? { ...v, name: clean } : v) });
      },

      updateView(id, filter) {
        set({ views: get().views.map(v => v.id === id ? { ...v, filter: viewCriteria(filter) } : v) });
      },

      deleteView(id) {
        set({ views: get().views.filter(v => v.id !== id) });
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
