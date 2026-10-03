import { create } from "zustand";
import type { FieldSource, SavedPost } from "../types";
import { libraryUrl, useLibrary } from "../store/library";
import { useLibraryPersistence } from "./libraryPersistence";
import { backendProvider, EnrichmentError, enrichmentFailure, isTerminalEnrichmentCode } from "./providers";
import { faviconFor, titleFromUrl } from "./platform";

/**
 * Link previews: title, description, image, site icon and reading details.
 *
 * - Runs as a small background queue (3 at a time) that survives reloads:
 *   every post still marked `pending`, or failed with a retry time that has
 *   passed, is picked up again when the app starts.
 * - "Busy" and "timeout" back off and retry by themselves (30 s, 5 min, 1 h).
 *   Everything else waits for the owner to ask again; failures that will
 *   repeat (invalid or blocked link, oversized page) are never retried.
 * - Field provenance decides what a refresh may change: fetched and derived
 *   values update, the owner's edits and bookmark-file titles never do.
 */

const RETRY_DELAYS = [30_000, 5 * 60_000, 60 * 60_000];
/** Our own server said "too many at once" or the site was slow: worth trying again by itself. */
const AUTO_RETRY = new Set(["busy", "timeout"]);
const STALE_AFTER = 90 * 86400_000;

interface QueueState { total: number; done: number; running: number; paused: boolean }
export const useEnrichmentQueue = create<QueueState>(() => ({ total: 0, done: 0, running: 0, paused: false }));

const active = new Map<string, Promise<void>>();
const queue: { id: string; url: string; force: boolean; done: () => void }[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

type Field = "title" | "description" | "thumbnailUrl";

/** Best guess for posts saved before provenance was recorded. */
function sourceOf(post: SavedPost, field: Field): FieldSource | undefined {
  const value = post[field];
  if (!value || !String(value).trim()) return undefined;
  const known = post.fieldSources?.[field];
  // "derived" only holds while the title is still the URL-derived one.
  if (known && !(known === "derived" && field === "title" && value !== titleFromUrl(post.canonicalUrl || post.url))) return known;
  if (field === "title" && value === titleFromUrl(post.canonicalUrl || post.url)) return "derived";
  if (field === "thumbnailUrl" && value === faviconFor(post.url)) return "derived";
  // Descriptions and images were only ever filled by enrichment: refreshable.
  if (field !== "title") return "fetched";
  // A manually added link starts with a URL-derived title, so a different one
  // was fetched. Imported titles came from the owner's file: keep them.
  return post.source === "manual" ? "fetched" : "file";
}

export function metadataPatch(before: SavedPost, current: SavedPost, fetched: Partial<SavedPost>): Partial<SavedPost> {
  const patch: Partial<SavedPost> = { metadataStatus: fetched.metadataStatus, metadataError: fetched.metadataError };
  const sources = { ...(current.fieldSources ?? {}) };
  for (const field of ["title", "description", "thumbnailUrl"] as Field[]) {
    const next = fetched[field];
    if (!next) continue;
    // An edit made while the request was in flight always wins.
    if (current[field] !== before[field]) continue;
    const source = sourceOf(current, field);
    // Owner edits, their own bookmark titles and accepted AI clean-ups are kept.
    if (source === "user" || source === "file" || source === "ai") continue;
    patch[field] = next;
    sources[field] = "fetched";
  }
  patch.fieldSources = sources;
  for (const key of ["siteName", "author", "publishedAt", "lang", "faviconUrl", "finalUrl", "wordCount", "readingMinutes"] as const) {
    if (fetched[key] !== undefined) (patch as Record<string, unknown>)[key] = fetched[key];
  }
  // A page's canonical URL is useful for duplicate hints, never a replacement for the saved one.
  if (fetched.canonicalUrl && !current.canonicalUrl) patch.canonicalUrl = fetched.canonicalUrl;
  if (fetched.linkStatus) patch.linkStatus = fetched.linkStatus;
  patch.enrichedAt = new Date().toISOString();
  patch.metadataAttempts = 0;
  patch.metadataRetryAt = undefined;
  return patch;
}

async function enrich(id: string) {
  const before = useLibrary.getState().posts.find(p => p.id === id);
  if (!before) return;
  let patch: Partial<SavedPost>;
  try {
    const fetched = await backendProvider.enrich({ url: before.url });
    const current = useLibrary.getState().posts.find(p => p.id === id && p.url === before.url);
    if (!current) return;
    patch = metadataPatch(before, current, fetched);
  } catch (error) {
    const code = error instanceof EnrichmentError ? error.code : "";
    const current = useLibrary.getState().posts.find(p => p.id === id && p.url === before.url);
    if (!current) return;
    const attempts = (current.metadataAttempts ?? 0) + 1;
    // Other failures (site errors, unreadable pages) wait for the owner's
    // "Fetch missing previews" or a refresh, instead of churning in the background.
    const terminal = isTerminalEnrichmentCode(code) || !AUTO_RETRY.has(code) || attempts > RETRY_DELAYS.length;
    const serverWait = error instanceof EnrichmentError && error.retryAfter ? error.retryAfter * 1000 : 0;
    const delay = Math.max(serverWait, RETRY_DELAYS[Math.min(attempts, RETRY_DELAYS.length) - 1]);
    patch = {
      metadataStatus: "failed",
      metadataError: enrichmentFailure(code),
      metadataAttempts: attempts,
      metadataRetryAt: terminal ? undefined : new Date(Date.now() + delay).toISOString(),
      ...(error instanceof EnrichmentError && error.linkStatus === "gone" ? { linkStatus: "gone" as const } : {}),
      ...(error instanceof EnrichmentError && error.httpStatus ? { httpStatus: error.httpStatus } : {}),
    };
    if (!terminal) schedule(delay + 1000);
  }
  // Saving is the persistence layer's job: it batches these writes.
  useLibrary.getState().updatePost(id, patch);
}

function drain() {
  const state = useEnrichmentQueue.getState();
  if (state.paused) return;
  let running = state.running;
  while (running < 3 && queue.length) {
    const job = queue.shift()!;
    running++;
    useEnrichmentQueue.setState({ running });
    void enrich(job.id).catch(() => {}).finally(() => {
      active.delete(job.url);
      job.done();
      const s = useEnrichmentQueue.getState();
      const left = queue.length + s.running - 1;
      useEnrichmentQueue.setState({ running: s.running - 1, done: s.done + 1, ...(left === 0 ? { total: 0, done: 0 } : {}) });
      drain();
    });
  }
}

/** Queue one post. `force` (the owner asked) bypasses the retry schedule. */
export function enrichSavedPost(id: string, options: { force?: boolean } = {}): Promise<void> {
  const post = useLibrary.getState().posts.find(p => p.id === id);
  if (!post) return Promise.resolve();
  const url = libraryUrl(post.url);
  const existing = active.get(url);
  if (existing) return existing;
  let done!: () => void;
  const promise = new Promise<void>(resolve => { done = resolve; });
  active.set(url, promise);
  const job = { id, url, force: !!options.force, done };
  // The owner's explicit request jumps the background queue.
  if (options.force) queue.unshift(job); else queue.push(job);
  useEnrichmentQueue.setState(s => ({ total: s.total + 1 }));
  drain();
  return promise;
}

export function enrichMany(ids: string[], options: { force?: boolean } = {}): Promise<void> {
  return Promise.all(ids.map(id => enrichSavedPost(id, options))).then(() => undefined);
}

export function setEnrichmentPaused(paused: boolean) {
  useEnrichmentQueue.setState({ paused });
  if (!paused) drain();
}

/** Posts the background queue should (re)visit now. */
export function needsEnrichment(post: SavedPost, now = Date.now()): boolean {
  if (post.metadataStatus === "pending") return true;
  if (post.metadataStatus === "failed" && post.metadataRetryAt) return Date.parse(post.metadataRetryAt) <= now;
  return false;
}

/** Old previews are refreshed when a link is looked at again, never in a sweep. */
export function isStale(post: SavedPost, now = Date.now()): boolean {
  if (post.metadataStatus === "none" || post.metadataStatus === "pending") return false;
  if (!post.thumbnailUrl && post.metadataStatus === "enriched") return !post.enrichedAt || now - Date.parse(post.enrichedAt) > 7 * 86400_000;
  return !!post.enrichedAt && now - Date.parse(post.enrichedAt) > STALE_AFTER;
}

export function refreshIfStale(post: SavedPost) {
  if (isStale(post)) void enrichSavedPost(post.id);
}

function resume() {
  timer = undefined;
  const now = Date.now();
  for (const post of useLibrary.getState().posts) {
    if (needsEnrichment(post, now)) void enrichSavedPost(post.id);
  }
}

function schedule(delay: number) {
  if (timer) return;
  timer = setTimeout(resume, Math.min(delay, 60 * 60_000));
}

/** Resume pending previews once SQLite has the library (called at startup). */
export function startEnrichmentQueue(): () => void {
  let started = false;
  const stop = useLibraryPersistence.subscribe(state => {
    if (started || state.status !== "saved" || useLibrary.getState().demo) return;
    started = true;
    resume();
  });
  return () => { stop(); if (timer) clearTimeout(timer); timer = undefined; };
}
