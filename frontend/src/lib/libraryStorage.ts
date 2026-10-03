import { create } from "zustand";
import type { PersistStorage, StorageValue } from "zustand/middleware";

/**
 * Browser cache for the library store.
 *
 * Small libraries stay in localStorage exactly as before (synchronous, so the
 * first paint already has them). Once the serialized cache outgrows a safe
 * localStorage budget — about 5k imported bookmarks used to throw
 * QuotaExceededError mid-import and lose the links on reload — it moves to
 * IndexedDB, which has room for tens of thousands of posts. A tiny marker
 * stays in localStorage so the next load knows where to look.
 *
 * Every failure is surfaced through `useStorageHealth`; nothing fails silently.
 */

const LOCAL_BUDGET = 2_000_000; // characters; well under every browser's quota
const DB_NAME = "sbm-library-cache";
const STORE = "kv";
const MARKER = '{"sbmStorage":"indexeddb"}';

export const useStorageHealth = create<{ error: string; backend: "local" | "indexeddb" }>(() => ({ error: "", backend: "local" }));

function reportError(error: unknown) {
  const quota = error instanceof DOMException && (error.name === "QuotaExceededError" || error.code === 22);
  useStorageHealth.setState({
    error: quota
      ? "The browser cache is full. Recent changes are kept in memory and saved to SQLite when it is available; free disk space or export a backup."
      : "The browser cache could not be written. Recent changes are kept in memory and saved to SQLite when it is available.",
  });
}

let dbPromise: Promise<IDBDatabase> | undefined;
function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB unavailable")); return; }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    dbPromise.catch(() => { dbPromise = undefined; });
  }
  return dbPromise;
}

async function idb<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = run(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error ?? request.error);
    tx.onabort = () => reject(tx.error ?? request.error);
  });
}

const channel = typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel("sbm-library-cache");
const tabId = Math.random().toString(36).slice(2);

/** Ask other tabs to re-read the cache after this tab wrote it. */
export function onOtherTabWrite(name: string, listener: () => void): () => void {
  let pending: ReturnType<typeof setTimeout> | undefined;
  // Both signals can arrive for one write; coalesce them into one re-read.
  const notify = () => { if (!pending) pending = setTimeout(() => { pending = undefined; listener(); }, 20); };
  const handler = (event: MessageEvent) => {
    if (event.data?.name === name && event.data?.tab !== tabId) notify();
  };
  // The storage event is the browser's own cross-tab signal for localStorage;
  // the channel also covers IndexedDB writes, which raise no storage event.
  const storageHandler = (event: StorageEvent) => { if (event.key === name) notify(); };
  channel?.addEventListener("message", handler);
  window.addEventListener("storage", storageHandler);
  return () => {
    channel?.removeEventListener("message", handler);
    window.removeEventListener("storage", storageHandler);
    if (pending) clearTimeout(pending);
  };
}

/**
 * Writes are serialized (a later write never lands before an earlier one) and
 * coalesced: a burst of store updates during an import becomes one write.
 */
export function libraryStorage<S>(): PersistStorage<S> {
  let latest: { name: string; value: StorageValue<S> } | undefined;
  let chain: Promise<void> = Promise.resolve();
  let scheduled = false;
  let seq = 0;
  let lastLocalSeq = 0;

  /** localStorage path: synchronous, exactly like the previous persist behaviour. */
  const writeLocal = (name: string, serialized: string): boolean => {
    if (serialized.length > LOCAL_BUDGET) return false;
    try {
      localStorage.setItem(name, serialized);
    } catch {
      return false;
    }
    if (useStorageHealth.getState().backend === "indexeddb") {
      useStorageHealth.setState({ backend: "local" });
      void idb("readwrite", s => s.delete(name)).catch(() => {});
    }
    if (useStorageHealth.getState().error) useStorageHealth.setState({ error: "" });
    channel?.postMessage({ name, tab: tabId });
    return true;
  };

  const writeIdb = async (name: string, serialized: string, at: number) => {
    try {
      await idb("readwrite", s => s.put(serialized, name));
      // A smaller, newer state may have gone to localStorage meanwhile; never
      // replace it with the marker pointing at this older copy.
      if (lastLocalSeq > at) return;
      try { localStorage.setItem(name, MARKER); } catch { /* marker is best effort */ }
      useStorageHealth.setState({ backend: "indexeddb", error: "" });
      channel?.postMessage({ name, tab: tabId });
    } catch (error) {
      reportError(error);
    }
  };

  const serialize = (value: StorageValue<S>): string | undefined => {
    try { return JSON.stringify(value); } catch (error) { reportError(error); return undefined; }
  };

  const flush = () => {
    scheduled = false;
    const next = latest;
    latest = undefined;
    if (!next) return chain;
    const serialized = serialize(next.value);
    if (serialized === undefined) return chain;
    const at = ++seq;
    if (useStorageHealth.getState().backend === "local" && writeLocal(next.name, serialized)) {
      lastLocalSeq = at;
      return chain;
    }
    chain = chain.then(() => writeIdb(next.name, serialized, at));
    return chain;
  };

  if (typeof window !== "undefined") {
    // Never leave a coalesced write behind when the tab goes away.
    window.addEventListener("pagehide", () => { void flush(); });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void flush(); });
  }

  return {
    getItem(name) {
      let raw: string | null = null;
      try { raw = localStorage.getItem(name); } catch { raw = null; }
      if (raw !== null && raw !== MARKER) {
        try { return JSON.parse(raw) as StorageValue<S>; } catch { return null; }
      }
      if (raw === MARKER) useStorageHealth.setState({ backend: "indexeddb" });
      return idb<string | undefined>("readonly", s => s.get(name)).then(
        value => (typeof value === "string" ? JSON.parse(value) as StorageValue<S> : null),
        error => { reportError(error); return null; },
      );
    },
    setItem(name, value) {
      latest = { name, value };
      // Small caches write synchronously (as before) so tests and quick reloads
      // always see the latest state; large ones coalesce onto the next tick.
      if (useStorageHealth.getState().backend === "local") return flush();
      if (!scheduled) { scheduled = true; setTimeout(() => { void flush(); }, 250); }
    },
    removeItem(name) {
      try { localStorage.removeItem(name); } catch { /* ignore */ }
      void idb("readwrite", s => s.delete(name)).catch(() => {});
    },
  };
}
