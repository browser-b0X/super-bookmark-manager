import { create } from "zustand";
import type { SavedPost } from "../types";
import { CAT_COLORS, libraryUrl, useLibrary, type CategoryOp, type RejectedChange } from "../store/library";
import { appendBoundedShelves } from "./shelves";
import { idForUrl } from "./platform";
import { onOtherTabWrite } from "./libraryStorage";

interface Rejection { url: string; id: string; reason: string; error?: string }

interface LibrarySnapshot {
  posts: SavedPost[];
  deletedUrls: string[];
  legacyRows: Record<string, unknown>[];
  categories?: string[];
  rejected?: Rejection[];
  rejectedOps?: (CategoryOp & { reason: string })[];
  /** Server change counter; with `since` the response holds only changes after it. */
  rev?: number;
  since?: number;
  purgedUrls?: string[];
}

interface LibraryDelta {
  posts: SavedPost[];
  deletedUrls: string[];
  categoryOps?: CategoryOp[];
  undeleteUrls?: string[];
  adoptedUrls?: string[];
  purgeUrls?: string[];
  since?: number;
}

const without = (list: string[], sent: string[]) => {
  const done = new Set(sent);
  return list.filter(u => !done.has(u));
};

/** Large imports are written in slices so one request never carries the whole library. */
const CHUNK = 500;

export const useLibraryPersistence = create<{ status: "idle" | "syncing" | "saved" | "error"; error: string }>(() => ({ status: "idle", error: "" }));
let running: Promise<boolean> | undefined;

async function requestLibrary(delta?: LibraryDelta): Promise<LibrarySnapshot> {
  // Ask only for what changed since the last revision we merged (delta sync):
  // a 20k-link library is no longer downloaded on every save.
  const since = useLibrary.getState().syncRev;
  const body = delta && since ? { ...delta, since } : delta;
  const response = await fetch(!delta && since ? `/api/library?since=${since}` : "/api/library", {
    method: delta ? "POST" : "GET",
    headers: delta ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok || (delta && data?.ok !== true)) throw new Error(data?.error || `SQLite request failed (${response.status}).`);
  if (!data || !Array.isArray(data.posts) || !Array.isArray(data.deletedUrls) || !Array.isArray(data.legacyRows)) {
    throw new Error("Invalid SQLite response; changes remain pending.");
  }
  return data;
}

function mergeSnapshot(data: LibrarySnapshot, sent: Record<string, SavedPost | null> = {}) {
  const state = useLibrary.getState();
  const pending = { ...state.pending };
  // A link the owner re-added is no longer deleted, even before SQLite hears so.
  const reAdded = new Set(state.undeleteUrls.map(libraryUrl));
  const serverDeleted = data.deletedUrls.map(libraryUrl).filter(url => !reAdded.has(url));
  const deletedUrls = [...new Set([...state.deletedUrls, ...serverDeleted])];
  const deleted = new Set(deletedUrls);
  for (const [url, post] of Object.entries(sent)) {
    // Acknowledging an older payload must not clear a newer edit made in flight.
    if (JSON.stringify(pending[url]) === JSON.stringify(post)) delete pending[url];
  }
  serverDeleted.forEach(url => { delete pending[url]; });
  const posts = new Map((state.demo ? [] : state.posts).map(p => [libraryUrl(p.url), p]));
  const purging = new Set(state.purgeUrls.map(libraryUrl));
  for (const post of data.posts) {
    const url = libraryUrl(post.url);
    if (!(url in pending) && !purging.has(url)) posts.set(url, post);
  }
  for (const [url, post] of Object.entries(pending)) {
    if (post) posts.set(url, post);
  }
  deleted.forEach(url => posts.delete(url));
  // Links removed by undoing an import in another tab.
  for (const url of (data.purgedUrls ?? []).map(libraryUrl)) {
    if (!(url in pending)) posts.delete(url);
  }
  let categories = [...state.categories];
  const known = new Set(categories.map(c => c.name));
  // Shelves SQLite already has (including ones renamed or added elsewhere) count
  // toward the same 12-shelf limit the server enforces.
  for (const name of [...(data.categories ?? []), ...[...posts.values()].flatMap(p => p.categories)]) {
    if (known.has(name)) continue;
    known.add(name);
    categories = appendBoundedShelves(categories, [{ id: name, name, order: categories.length, color: CAT_COLORS[categories.length % CAT_COLORS.length] }]);
  }
  useLibrary.setState({
    posts: [...posts.values()], pending, deletedUrls, categories, demo: false, migrated: true,
    // A server without revisions (older build or a test double) keeps full snapshots.
    syncRev: Number.isSafeInteger(data.rev) && data.rev! >= 0 ? data.rev! : 0,
  });
}

/**
 * Turn per-item rejections into a recoverable state instead of an endless
 * retry of the same batch:
 *  - an ID collision gets a fresh ID and is sent again;
 *  - deleted / duplicate / stale items take SQLite's version (already merged);
 *  - anything else is parked in `rejected` for the owner to see and retry.
 */
function applyRejections(rejections: Rejection[], sent: Record<string, SavedPost | null>, retried: Set<string>) {
  if (!rejections.length) return;
  const state = useLibrary.getState();
  const pending = { ...state.pending };
  const rejected = { ...state.rejected };
  let posts = state.posts;
  for (const item of rejections) {
    const url = libraryUrl(item.url);
    const local = sent[url];
    // Not ours, or the owner already edited it again since this was sent.
    if (!local || (url in pending && JSON.stringify(pending[url]) !== JSON.stringify(local))) continue;
    if (item.reason === "id_conflict" && !retried.has(url)) {
      retried.add(url);
      const id = `${idForUrl(url)}-${Math.random().toString(36).slice(2, 7)}`;
      const next = { ...local, id };
      pending[url] = next;
      posts = posts.map(p => (libraryUrl(p.url) === url ? next : p));
      continue;
    }
    delete pending[url];
    if (item.reason === "deleted" || item.reason === "duplicate_url" || item.reason === "stale") continue;
    rejected[url] = { post: local, reason: item.reason, error: item.error, at: new Date().toISOString() } satisfies RejectedChange;
  }
  useLibrary.setState({ pending, rejected, posts });
}

function waitForHydration(): Promise<void> {
  const persist = useLibrary.persist;
  if (!persist || persist.hasHydrated()) return Promise.resolve();
  return new Promise(resolve => {
    const stop = persist.onFinishHydration(() => { stop(); resolve(); });
  });
}

function hasOutgoing() {
  const s = useLibrary.getState();
  return Object.keys(s.pending).length > 0 || s.categoryOps.length > 0 || s.undeleteUrls.length > 0
    || s.adoptedUrls.length > 0 || s.purgeUrls.length > 0;
}

export function syncLibrary(): Promise<boolean> {
  if (running) return running;
  useLibraryPersistence.setState({ status: "syncing", error: "" });
  running = (async () => {
    try {
      await waitForHydration();
      const snapshot = await requestLibrary();
      mergeSnapshot(snapshot);
      if (snapshot.legacyRows.length) useLibrary.getState().migrateLegacy(snapshot.legacyRows, []);
      const retried = new Set<string>();
      let rounds = 0;
      let opWarning = "";
      while (hasOutgoing()) {
        const state = useLibrary.getState();
        if (++rounds > 20 + Math.ceil(Object.keys(state.pending).length / CHUNK)) {
          throw new Error("SQLite kept refusing the same changes; they remain pending.");
        }
        const sent = Object.fromEntries(Object.entries(state.pending).slice(0, CHUNK));
        const categoryOps = [...state.categoryOps];
        const undeleteUrls = [...state.undeleteUrls];
        const adoptedUrls = [...state.adoptedUrls];
        const purgeUrls = [...state.purgeUrls];
        const posts = Object.values(sent).filter((post): post is SavedPost => post !== null);
        const deletedUrls = Object.keys(sent).filter(url => sent[url] === null);
        const saved = await requestLibrary({
          posts, deletedUrls,
          ...(categoryOps.length ? { categoryOps } : {}),
          ...(undeleteUrls.length ? { undeleteUrls } : {}),
          ...(adoptedUrls.length ? { adoptedUrls } : {}),
          ...(purgeUrls.length ? { purgeUrls } : {}),
        });
        // Drop exactly what was acknowledged; anything queued meanwhile stays.
        const after = useLibrary.getState();
        useLibrary.setState({
          categoryOps: after.categoryOps.slice(categoryOps.length),
          undeleteUrls: without(after.undeleteUrls, undeleteUrls),
          adoptedUrls: without(after.adoptedUrls, adoptedUrls),
          purgeUrls: without(after.purgeUrls, purgeUrls),
        });
        mergeSnapshot(saved, sent);
        applyRejections(saved.rejected ?? [], sent, retried);
        if (saved.rejectedOps?.length) {
          opWarning = saved.rejectedOps.some(op => op.reason === "shelf_limit")
            ? "SQLite already has 12 shelves, so a new shelf was not saved."
            : "A shelf change could not be saved.";
        }
      }
      useLibraryPersistence.setState({ status: "saved", error: opWarning });
      return true;
    } catch (error) {
      useLibraryPersistence.setState({ status: "error", error: error instanceof Error ? error.message : "SQLite unavailable." });
      return false;
    } finally {
      running = undefined;
    }
  })();
  return running;
}

export function startLibraryPersistence() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void syncLibrary(); }, 300);
  };
  const unsubscribe = useLibrary.subscribe((state, previous) => {
    const queued = state.categoryOps !== previous.categoryOps || state.undeleteUrls !== previous.undeleteUrls
      || state.adoptedUrls !== previous.adoptedUrls || state.purgeUrls !== previous.purgeUrls;
    if (queued && hasOutgoing()) { schedule(); return; }
    if (state.pending === previous.pending || !Object.keys(state.pending).length
      || JSON.stringify(state.pending) === JSON.stringify(previous.pending)) return;
    schedule();
  });
  const retry = () => { void syncLibrary(); };
  window.addEventListener("online", retry);
  // Another tab wrote the shared cache: re-read it (merge keeps our own
  // unsaved edits), so two tabs never silently overwrite each other.
  const stopTabs = onOtherTabWrite(useLibrary.persist?.getOptions().name ?? "", () => {
    void useLibrary.persist?.rehydrate();
  });
  void syncLibrary();
  return () => {
    unsubscribe();
    stopTabs();
    if (timer) clearTimeout(timer);
    window.removeEventListener("online", retry);
  };
}
