import { create } from "zustand";
import type { FieldSource, SavedPost } from "../types";
import { libraryUrl, updatePostInBackground, useLibrary, type BackgroundChange } from "../store/library";
import { useLibraryPersistence } from "./libraryPersistence";
import { backendProvider, EnrichmentError, enrichmentFailure, isTerminalEnrichmentCode } from "./providers";
import { faviconFor, titleFromUrl } from "./platform";
import { pictureFound, useLostPictures } from "./lostPictures";
import { pictureCode } from "./previewHealth";

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

interface Job { id: string; url: string; force: boolean; done: () => void }
const active = new Map<string, Promise<void>>();
/** Jobs by link, while queued or running (a later request from the owner upgrades them). */
const jobs = new Map<string, Job>();
const queue: Job[] = [];
/** One timer for every link's automatic retry, set for the soonest one (`timerDue`, ms). */
let timer: ReturnType<typeof setTimeout> | undefined;
let timerDue = 0;

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
  // A picture that isn't on this computer (a backup restored without its files) and that the
  // page no longer gives: drop it, so the link shows its text card instead of a missing picture.
  if (!fetched.thumbnailUrl && current.thumbnailUrl === before.thumbnailUrl
    && useLostPictures.getState().codes.has(pictureCode(current.thumbnailUrl))) patch.thumbnailUrl = undefined;
  for (const key of ["siteName", "author", "publishedAt", "lang", "faviconUrl", "finalUrl", "wordCount", "readingMinutes"] as const) {
    if (fetched[key] !== undefined) (patch as Record<string, unknown>)[key] = fetched[key];
  }
  // A page's canonical URL is useful for duplicate hints, never a replacement for the saved one.
  if (fetched.canonicalUrl && !current.canonicalUrl) patch.canonicalUrl = fetched.canonicalUrl;
  if (fetched.linkStatus) patch.linkStatus = fetched.linkStatus;
  patch.enrichedAt = new Date().toISOString();
  patch.metadataAttempts = 0;
  patch.metadataRetryAt = undefined;
  patch.metadataTriedAt = undefined;
  return patch;
}

/** Fetch one link's preview; `applied` settles once the result is in the library. */
async function enrich(job: Job): Promise<{ applied: Promise<void> } | undefined> {
  const id = job.id;
  const before = useLibrary.getState().posts.find(p => p.id === id);
  if (!before) return;
  let patch: BackgroundChange;
  try {
    const fetched = await backendProvider.enrich({ url: before.url });
    // The server has the picture now (also one that was missing on this computer).
    if (fetched.thumbnailUrl) pictureFound(fetched.thumbnailUrl);
    if (!useLibrary.getState().posts.some(p => p.id === id && p.url === before.url)) return;
    // Worked out when it is applied, so an edit made meanwhile still wins.
    patch = current => (current.url === before.url ? metadataPatch(before, current, fetched) : null);
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
      // The owner asked and it still failed: no longer counted as "missing", listed as couldn't be fetched.
      ...(job.force ? { metadataTriedAt: new Date().toISOString() } : {}),
    };
    if (!terminal) schedule(delay + 1000);
  }
  // Applied together with other background results, a few times a second; saving
  // is the persistence layer's job.
  return { applied: updatePostInBackground(id, patch) };
}

function drain() {
  const state = useEnrichmentQueue.getState();
  if (state.paused) return;
  let running = state.running;
  while (running < 3 && queue.length) {
    const job = queue.shift()!;
    running++;
    useEnrichmentQueue.setState({ running });
    void enrich(job).catch(() => undefined).then(result => {
      // The slot is free as soon as the page has answered; the result joins the next
      // batch of background changes, and the job counts as done once it is applied.
      const s = useEnrichmentQueue.getState();
      const left = queue.length + s.running - 1;
      useEnrichmentQueue.setState({ running: s.running - 1, done: s.done + 1, ...(left === 0 ? { total: 0, done: 0 } : {}) });
      drain();
      return result?.applied;
    }).finally(() => {
      active.delete(job.url);
      jobs.delete(job.url);
      job.done();
    });
  }
}

/** Queue one link (not started yet). `force`: the owner asked — it goes ahead of background work. */
function enqueue(id: string, force: boolean, front: Job[]): Promise<void> | undefined {
  const post = useLibrary.getState().posts.find(p => p.id === id);
  if (!post) return undefined;
  const url = libraryUrl(post.url);
  const existing = jobs.get(url);
  if (existing) {
    // Already queued by the background: the owner's request moves it up (and counts it as theirs).
    if (force && !existing.force) {
      existing.force = true;
      const at = queue.indexOf(existing);
      if (at >= 0) { queue.splice(at, 1); front.push(existing); }
    }
    return active.get(url);
  }
  let done!: () => void;
  const promise = new Promise<void>(resolve => { done = resolve; });
  const job: Job = { id, url, force, done };
  active.set(url, promise);
  jobs.set(url, job);
  if (force) front.push(job); else queue.push(job);
  useEnrichmentQueue.setState(s => ({ total: s.total + 1 }));
  return promise;
}

/** Queue one post. `force` (the owner asked) bypasses the retry schedule. */
export function enrichSavedPost(id: string, options: { force?: boolean } = {}): Promise<void> {
  return enrichMany([id], options);
}

/** Queue many links; the owner's request keeps their order, ahead of background work, and resumes a paused queue. */
export function enrichMany(ids: string[], options: { force?: boolean } = {}): Promise<void> {
  const force = !!options.force;
  const front: Job[] = [];
  const waits = ids.map(id => enqueue(id, force, front)).filter((p): p is Promise<void> => !!p);
  if (front.length) queue.unshift(...front);
  if (force && useEnrichmentQueue.getState().paused) useEnrichmentQueue.setState({ paused: false });
  drain();
  return Promise.all(waits).then(() => undefined);
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
  timerDue = 0;
  const now = Date.now();
  let next = Infinity;
  for (const post of useLibrary.getState().posts) {
    if (needsEnrichment(post, now)) void enrichSavedPost(post.id);
    else if (post.metadataStatus === "failed" && post.metadataRetryAt) next = Math.min(next, Date.parse(post.metadataRetryAt));
  }
  // Links whose turn hasn't come yet keep a timer (they used to wait for the next app start).
  if (Number.isFinite(next)) schedule(next - now + 1000);
}

/** Come back in `delay` ms; a sooner retry moves the timer up (a 30 s retry waited behind an hour's). */
function schedule(delay: number) {
  const due = Date.now() + Math.max(0, Math.min(delay, 60 * 60_000));
  if (timer && timerDue <= due) return;
  if (timer) clearTimeout(timer);
  timerDue = due;
  timer = setTimeout(resume, due - Date.now());
}

/** Resume pending previews once SQLite has the library (called at startup). */
export function startEnrichmentQueue(): () => void {
  let started = false;
  const stop = useLibraryPersistence.subscribe(state => {
    if (started || state.status !== "saved" || useLibrary.getState().demo) return;
    started = true;
    resume();
  });
  return () => { stop(); if (timer) clearTimeout(timer); timer = undefined; timerDue = 0; };
}
