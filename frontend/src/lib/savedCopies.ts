import { create } from "zustand";
import type { SavedPost } from "../types";
import { updatePostInBackground, useLibrary } from "../store/library";
import { useLibraryPersistence } from "./libraryPersistence";
import { useCopyAvailability } from "./copyAvailability";
import { isInstagramPost, type InstagramData } from "./instagram";

/**
 * Saved copies: the browser's side of archive.py.
 *
 * - The server makes copies on its own queue (three at a time). Here a link is
 *   submitted, then asked about every 1.5 s until its copy is saved or failed.
 *   At most six are outstanding at once, so a 2,000-link import trickles in.
 * - A link that should get a copy is marked `archiveStatus: "pending"` on the
 *   link itself. That mark is saved with the library, so the queue resumes
 *   after a reload or a restart, like link previews do.
 * - Nothing here decides how it looks: components read the link's `archive*`
 *   fields and call saveCopy / deleteCopy.
 */

const MAX_OUTSTANDING = 6;
const POLL_MS = 1500;
const BUSY_WAIT_MS = 5000;
const OFFLINE_WAIT_MS = 30000;
/** A site that asked the app to slow down (Reddit answers HTTP 429) is asked again by itself:
 *  after a minute, then after five; after that, Update is the owner's. */
const SITE_BUSY_RETRY_MS = [60_000, 5 * 60_000];

interface QueueState { total: number; done: number; paused: boolean }
export const useCopyQueue = create<QueueState>(() => ({ total: 0, done: 0, paused: false }));

/** What the server says about one copy (archive.state / read_record). */
interface CopyState {
  key: string;
  status: "none" | "queued" | "saving" | "saved" | "failed" | "too_large";
  error?: string;
  savedAt?: string;
  bytes?: number;
  limited?: boolean;
  videoMissing?: boolean;
  thumbnail?: string;
  previous?: { savedAt?: string; bytes?: number };
}

interface Job { id: string; refresh: boolean; post?: InstagramData; lost?: number }
const waiting: Job[] = [];
/** Links waiting here or outstanding on the server, by post id. */
const queued = new Set<string>();
/** Submitted and not finished, by copy key. `lost` counts answers of "none". */
const outstanding = new Map<string, { id: string; refresh: boolean; lost: number; post?: InstagramData }>();
let submitting = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
/** Automatic tries after a "busy" answer, and their timers, by post id (this session only). */
const busyTries = new Map<string, number>();
const busyTimers = new Map<string, ReturnType<typeof setTimeout>>();

const postById = (id: string) => useLibrary.getState().posts.find(p => p.id === id);

/** Fields that describe a copy, cleared together. */
const NO_COPY: Partial<SavedPost> = {
  archiveStatus: undefined, archiveKey: undefined, archivedAt: undefined,
  archiveBytes: undefined, archiveError: undefined, archiveLimited: undefined, archiveNoVideo: undefined,
};

function record(id: string, state: CopyState) {
  // Applied with other background results (a few times a second), against the link as it is then.
  void updatePostInBackground(id, post => copyResult(post, state));
  tryAgainLater(id, state);
}

/** After "busy" from the site, ask again by itself (see SITE_BUSY_RETRY_MS); any other answer ends that. */
function tryAgainLater(id: string, state: CopyState) {
  if (state.status !== "failed" || state.error !== "busy") { busyTries.delete(id); return; }
  const tries = busyTries.get(id) ?? 0;
  if (tries >= SITE_BUSY_RETRY_MS.length || busyTimers.has(id)) return;
  busyTries.set(id, tries + 1);
  busyTimers.set(id, setTimeout(() => {
    busyTimers.delete(id);
    const post = postById(id);
    // Still waiting for it: not deleted, updated by hand, or given up on (copy deleted) meanwhile.
    if (!post || queued.has(id) || post.archiveError !== "busy") return;
    saveCopy(id, { refresh: post.archiveStatus === "saved" });
  }, SITE_BUSY_RETRY_MS[tries]));
}

function copyResult(post: SavedPost, state: CopyState): Partial<SavedPost> {
  let patch: Partial<SavedPost>;
  if (state.status === "saved") {
    patch = {
      archiveStatus: "saved", archiveKey: state.key, archivedAt: state.savedAt, archiveBytes: state.bytes,
      archiveLimited: state.limited ? true : undefined, archiveNoVideo: state.videoMissing ? true : undefined, archiveError: undefined,
    };
    // An Instagram copy also brings the post's first picture, kept by the app (Instagram's own addresses expire).
    if (typeof state.thumbnail === "string" && /^\/thumb\/[A-Za-z0-9_-]{1,128}$/.test(state.thumbnail) && !post.thumbnailUrl?.startsWith("/thumb/")) {
      patch.thumbnailUrl = state.thumbnail;
    }
  } else if (state.previous && post.archiveKey) {
    // An update failed: the earlier copy is still there and still the copy.
    patch = { archiveStatus: "saved", archiveError: state.error || "internal_error" };
  } else if (state.error === "disabled") {
    patch = NO_COPY;
  } else {
    patch = {
      ...NO_COPY,
      archiveStatus: state.status === "too_large" ? "too_large" : "failed",
      archiveError: state.error || "internal_error",
    };
  }
  return patch;
}

function finish(id: string) {
  queued.delete(id);
  const s = useCopyQueue.getState();
  const left = queued.size;
  useCopyQueue.setState(left === 0 ? { total: 0, done: 0 } : { done: s.done + 1 });
}

function later(ms: number) {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = undefined; pump(); }, ms);
}

async function submit(job: Job) {
  const post = postById(job.id);
  if (!post) { finish(job.id); return; }
  let response: Response;
  let state: CopyState | null;
  try {
    response = await fetch("/api/archive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: post.url, ...(job.refresh ? { refresh: true } : {}), ...(job.post ? { post: job.post } : {}) }),
      signal: AbortSignal.timeout(15000),
    });
    state = await response.json().catch(() => null);
  } catch {
    // The local server is not answering: keep the link pending and try again later.
    waiting.unshift(job);
    later(OFFLINE_WAIT_MS);
    return;
  }
  if (response.status === 429) {
    waiting.unshift(job);
    later(BUSY_WAIT_MS);
    return;
  }
  if (!state || typeof state.status !== "string") state = { key: "", status: "failed", error: "internal_error" };
  if (state.status === "queued" || state.status === "saving") {
    // The count and the Instagram data travel with a job asked for again.
    outstanding.set(state.key, { id: job.id, refresh: job.refresh, lost: job.lost ?? 0, post: job.post });
    schedulePoll();
    return;
  }
  record(job.id, state);
  finish(job.id);
}

function pump() {
  if (useCopyQueue.getState().paused) return;
  while (waiting.length && outstanding.size + submitting < MAX_OUTSTANDING && !retryTimer) {
    const job = waiting.shift()!;
    submitting++;
    void submit(job).finally(() => { submitting--; pump(); });
  }
}

function schedulePoll() {
  if (pollTimer || !outstanding.size) return;
  pollTimer = setTimeout(() => { pollTimer = undefined; void poll(); }, POLL_MS);
}

async function poll() {
  const keys = [...outstanding.keys()];
  if (!keys.length) return;
  let copies: Record<string, CopyState> | undefined;
  try {
    const response = await fetch(`/api/archive?keys=${keys.join(",")}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    copies = (await response.json())?.copies;
  } catch {
    copies = undefined;
  }
  for (const key of keys) {
    const job = outstanding.get(key);
    const state = copies?.[key];
    if (!job || !state || state.status === "queued" || state.status === "saving") continue;
    outstanding.delete(key);
    if (state.status === "none") {
      // The server restarted and forgot the job. Ask once more, then give up.
      if (job.lost < 1) { waiting.push({ id: job.id, refresh: job.refresh, post: job.post, lost: job.lost + 1 }); continue; }
      record(job.id, { key, status: "failed", error: "internal_error" });
    } else {
      record(job.id, state);
    }
    finish(job.id);
  }
  pump();
  schedulePoll();
}

function enqueue(id: string, refresh: boolean, front: boolean) {
  if (queued.has(id)) return;
  queued.add(id);
  if (front) waiting.unshift({ id, refresh }); else waiting.push({ id, refresh });
  useCopyQueue.setState(s => ({ total: s.total + 1 }));
}

/** Save (or, with `refresh`, update) the copy of one link. The owner asked: it goes first. */
export function saveCopy(id: string, options: { refresh?: boolean } = {}) {
  const post = postById(id);
  if (!post || queued.has(id)) return;
  enqueue(id, !!options.refresh, true);
  // "pending" is what shows "Saving a copy…" and what survives a reload.
  if (post.archiveStatus !== "pending") useLibrary.getState().updatePost(id, { archiveStatus: "pending", archiveError: undefined });
  pump();
}

/** Save an Instagram post's copy from what the bookmark button read in the owner's tab. */
export function saveInstagramCopy(id: string, data: InstagramData) {
  const post = postById(id);
  if (!post) return;
  if (queued.has(id)) {
    // A plain request is already waiting: give it the button's data instead.
    const job = waiting.find(j => j.id === id);
    if (job) { job.post = data; job.refresh = true; }
    return;
  }
  queued.add(id);
  waiting.unshift({ id, refresh: true, post: data });
  useCopyQueue.setState(s => ({ total: s.total + 1 }));
  if (post.archiveStatus !== "pending") useLibrary.getState().updatePost(id, { archiveStatus: "pending", archiveError: undefined });
  pump();
}

/** Failure codes that will repeat on every try (a file, a page over 3 MB, an address that can't be fetched,
 * an Instagram post with nothing from the bookmark button). */
export const FINAL_COPY_ERRORS = new Set(["too_large", "not_html", "invalid_url", "blocked_url", "needs_browser", "invalid_post"]);

/** No copy yet, and trying could work: what "Save copies of every link without one" takes. */
export function canStillCopy(post: SavedPost): boolean {
  if (post.archiveStatus === "saved" || post.archiveStatus === "pending" || queued.has(post.id)) return false;
  if (isInstagramPost(post.url)) return false;     // only the bookmark button can save these
  if (post.archiveStatus === "too_large") return false;
  return !(post.archiveStatus === "failed" && FINAL_COPY_ERRORS.has(post.archiveError ?? ""));
}

/** Save copies for many links; ones that already have a copy are left alone. */
export function saveCopies(ids: string[], options: { skipFinal?: boolean } = {}): number {
  const wanted = ids.filter(id => {
    const post = postById(id);
    if (!post || post.archiveStatus === "saved" || queued.has(id)) return false;
    return !options.skipFinal || canStillCopy(post);
  });
  for (const id of wanted) enqueue(id, false, false);
  const marked = new Set(wanted.filter(id => postById(id)?.archiveStatus !== "pending"));
  if (marked.size) useLibrary.getState().bulkPatch([...marked], { archiveStatus: "pending", archiveError: undefined });
  pump();
  return wanted.length;
}

/** Delete a link's copy; the link stays. */
export async function deleteCopy(id: string): Promise<boolean> {
  const post = postById(id);
  if (!post) return false;
  if (post.archiveKey) {
    try {
      const response = await fetch(`/api/archive/${post.archiveKey}`, { method: "DELETE", signal: AbortSignal.timeout(15000) });
      if (!response.ok) return false;
    } catch {
      return false;
    }
  }
  useLibrary.getState().updatePost(id, NO_COPY);
  return true;
}

/** A link says it has a copy: make sure the file is still there (a restored data folder may not have it). */
export async function checkCopy(post: SavedPost) {
  if (post.archiveStatus !== "saved" || !post.archiveKey) return;
  try {
    const response = await fetch(`/api/archive?keys=${post.archiveKey}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    const state: CopyState | undefined = (await response.json())?.copies?.[post.archiveKey];
    if (response.ok && state?.status === "none") useLibrary.getState().updatePost(post.id, NO_COPY);
  } catch { /* the server is away: nothing to conclude */ }
}

export function setCopiesPaused(paused: boolean) {
  useCopyQueue.setState({ paused });
  if (!paused) pump();
}

/** True while this link's copy is wanted or being made. */
export const copyInProgress = (post: SavedPost) => post.archiveStatus === "pending";

/** Address of the stored copy, for a link or an iframe. */
export function copyUrl(post: SavedPost, options: { plain?: boolean; banner?: boolean } = {}): string {
  const query = [options.plain ? "view=plain" : "", options.banner === false ? "banner=0" : ""].filter(Boolean).join("&");
  return `/archive/${post.archiveKey}${query ? `?${query}` : ""}`;
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes < 0) return "";
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatCopyDate(iso?: string): string {
  const time = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(time) ? "" : new Date(time).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** What the zip restore answers for each copy it put back. */
interface RestoredCopy { key: string; url: string; savedAt?: string; bytes?: number; limited?: boolean; videoMissing?: boolean }
export interface RestoreResult { restored: RestoredCopy[]; already: number; notInLibrary: number; invalid: number; telegram?: number }

/**
 * Put back the copies in a zip made by "Export backup with saved copies".
 * The server adds copies for links in this library only and never replaces
 * one; each restored copy is then recorded on its link here.
 */
export async function restoreCopies(file: Blob): Promise<RestoreResult> {
  const response = await fetch("/api/archive/import", {
    method: "POST", headers: { "Content-Type": "application/zip" }, body: file,
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.ok !== true || !Array.isArray(result.restored)) {
    throw new Error(typeof result?.error === "string" ? result.error : "The saved copies could not be restored.");
  }
  const byUrl = new Map((result.restored as RestoredCopy[]).map(item => [item.url, item]));
  for (const post of useLibrary.getState().posts) {
    const item = byUrl.get(post.url);
    if (!item) continue;
    useLibrary.getState().updatePost(post.id, {
      archiveStatus: "saved", archiveKey: item.key, archivedAt: item.savedAt, archiveBytes: item.bytes,
      archiveLimited: item.limited ? true : undefined, archiveNoVideo: item.videoMissing ? true : undefined, archiveError: undefined,
    });
  }
  return result as RestoreResult;
}

/** One plain sentence for a failure code from the server. */
export function copyProblem(code?: string): string {
  switch (code) {
    case "too_large": return "This page is bigger than 3 MB, which is too big to copy.";
    case "not_html": return "This link is a file, not a web page, so there is no page to copy.";
    case "invalid_url":
    case "blocked_url": return "This address can't be fetched from this computer.";
    case "dns_failure": return "The site's address couldn't be found.";
    case "busy": return "The site asked the app to slow down. Try Update again in a minute.";
    case "timeout":
    case "network_error": return "The site didn't answer in time.";
    case "http_error": return "The site refused the request, or the page is gone.";
    case "needs_browser": return "Instagram shows this post only to signed-in visitors. Open it in your browser and click your Save to SuperBookmarks button.";
    case "invalid_post": return "What the bookmark button read from this Instagram post couldn't be used.";
    case "post_unavailable": return "The site won't share this post: it was deleted, its account is private, or it is shown only to signed-in people.";
    case "video_unavailable": return "The post's video couldn't be fetched this time.";
    default: return "The copy couldn't be made.";
  }
}

function resume() {
  for (const post of useLibrary.getState().posts) {
    if (post.archiveStatus === "pending" && !queued.has(post.id)) enqueue(post.id, false, false);
  }
  pump();
}

/**
 * Ask the server whether it makes copies, then follow the library: every link
 * marked "pending" (new links with auto-save on, or left over from last time)
 * is queued. Called once at startup.
 */
export function startCopyQueue(): () => void {
  let stopLibrary: (() => void) | undefined;
  let stopped = false;
  const follow = () => {
    if (stopLibrary || stopped || !useCopyAvailability.getState().enabled || useLibrary.getState().demo) return;
    resume();
    stopLibrary = useLibrary.subscribe((state, previous) => { if (state.posts !== previous.posts && !state.demo) resume(); });
  };
  void fetch("/api/archive", { cache: "no-store", signal: AbortSignal.timeout(8000) })
    .then(response => response.json())
    .then(data => { if (data?.enabled === true) useCopyAvailability.setState({ enabled: true }); })
    .catch(() => {})
    .finally(() => { if (useLibraryPersistence.getState().status === "saved") follow(); });
  // Wait until SQLite has the library, so marks left from last time are known.
  const stopPersistence = useLibraryPersistence.subscribe(state => { if (state.status === "saved") follow(); });
  return () => {
    stopped = true;
    stopPersistence();
    stopLibrary?.();
    if (pollTimer) clearTimeout(pollTimer);
    if (retryTimer) clearTimeout(retryTimer);
    pollTimer = retryTimer = undefined;
    for (const timer of busyTimers.values()) clearTimeout(timer);
    busyTimers.clear();
  };
}
