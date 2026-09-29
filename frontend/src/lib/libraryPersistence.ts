import { create } from "zustand";
import type { SavedPost } from "../types";
import { CAT_COLORS, libraryUrl, useLibrary } from "../store/library";
import { appendBoundedShelves } from "./shelves";

interface LibrarySnapshot {
  posts: SavedPost[];
  deletedUrls: string[];
  legacyRows: Record<string, unknown>[];
}

export const useLibraryPersistence = create<{ status: "idle" | "syncing" | "saved" | "error"; error: string }>(() => ({ status: "idle", error: "" }));
let running: Promise<boolean> | undefined;

async function requestLibrary(delta?: { posts: SavedPost[]; deletedUrls: string[] }): Promise<LibrarySnapshot> {
  const response = await fetch("/api/library", {
    method: delta ? "POST" : "GET",
    headers: delta ? { "Content-Type": "application/json" } : undefined,
    body: delta ? JSON.stringify(delta) : undefined,
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
  const deletedUrls = [...new Set([...state.deletedUrls, ...data.deletedUrls.map(libraryUrl)])];
  const deleted = new Set(deletedUrls);
  for (const [url, post] of Object.entries(sent)) {
    // Acknowledging an older payload must not clear a newer edit made in flight.
    if (JSON.stringify(pending[url]) === JSON.stringify(post)) delete pending[url];
  }
  data.deletedUrls.forEach(url => { delete pending[libraryUrl(url)]; });
  const posts = new Map((state.demo ? [] : state.posts).map(p => [libraryUrl(p.url), p]));
  for (const post of data.posts) {
    const url = libraryUrl(post.url);
    if (!(url in pending)) posts.set(url, post);
  }
  for (const [url, post] of Object.entries(pending)) {
    if (post) posts.set(url, post);
  }
  deleted.forEach(url => posts.delete(url));
  let categories = [...state.categories];
  for (const post of posts.values()) {
    for (const name of post.categories) {
      categories = appendBoundedShelves(categories, [{ id: name, name, order: categories.length, color: CAT_COLORS[categories.length % CAT_COLORS.length] }]);
    }
  }
  useLibrary.setState({ posts: [...posts.values()], pending, deletedUrls, categories, demo: false, migrated: true });
}

export function syncLibrary(): Promise<boolean> {
  if (running) return running;
  useLibraryPersistence.setState({ status: "syncing", error: "" });
  running = (async () => {
    try {
      const snapshot = await requestLibrary();
      mergeSnapshot(snapshot);
      if (snapshot.legacyRows.length) useLibrary.getState().migrateLegacy(snapshot.legacyRows, []);
      while (Object.keys(useLibrary.getState().pending).length) {
        const sent = { ...useLibrary.getState().pending };
        const posts = Object.values(sent).filter((post): post is SavedPost => post !== null);
        const deletedUrls = Object.keys(sent).filter(url => sent[url] === null);
        const saved = await requestLibrary({ posts, deletedUrls });
        mergeSnapshot(saved, sent);
      }
      useLibraryPersistence.setState({ status: "saved", error: "" });
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
  const unsubscribe = useLibrary.subscribe((state, previous) => {
    if (state.pending === previous.pending || !Object.keys(state.pending).length
      || JSON.stringify(state.pending) === JSON.stringify(previous.pending)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void syncLibrary(); }, 300);
  });
  const retry = () => { void syncLibrary(); };
  window.addEventListener("online", retry);
  void syncLibrary();
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
    window.removeEventListener("online", retry);
  };
}
