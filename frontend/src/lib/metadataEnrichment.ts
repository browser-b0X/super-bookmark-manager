import type { SavedPost } from "../types";
import { libraryUrl, useLibrary } from "../store/library";
import { syncLibrary } from "./libraryPersistence";
import { backendProvider } from "./providers";
import { faviconFor, titleFromUrl } from "./platform";

const active = new Map<string, Promise<void>>();
const queue: { run: () => Promise<void>; done: () => void; url: string }[] = [];
let workers = 0;

function metadataPatch(before: SavedPost, current: SavedPost, fetched: Partial<SavedPost>): Partial<SavedPost> {
  const patch: Partial<SavedPost> = { metadataStatus: fetched.metadataStatus, metadataError: fetched.metadataError };
  const generatedTitle = current.source === "telegram" && current.id.startsWith("tg-json-")
    && current.metadataStatus !== "enriched" && current.title === titleFromUrl(current.canonicalUrl || current.url);
  if (current.title === before.title && (!current.title?.trim() || generatedTitle) && fetched.title) patch.title = fetched.title;
  if (current.description === before.description && !current.description?.trim() && fetched.description) patch.description = fetched.description;
  if (current.thumbnailUrl === before.thumbnailUrl && (!current.thumbnailUrl || current.thumbnailUrl === faviconFor(current.url))
    && fetched.thumbnailUrl) patch.thumbnailUrl = fetched.thumbnailUrl;
  return patch;
}

async function enrich(id: string) {
  if (!await syncLibrary()) return;
  const before = useLibrary.getState().posts.find(p => p.id === id);
  if (!before) return;
  let fetched: Partial<SavedPost>;
  try {
    fetched = await backendProvider.enrich({ url: before.url });
  } catch {
    fetched = { metadataStatus: "failed", metadataError: "Metadata unavailable. The saved link is unchanged; retry later." };
  }
  const current = useLibrary.getState().posts.find(p => p.id === id && p.url === before.url);
  if (!current) return;
  useLibrary.getState().updatePost(id, metadataPatch(before, current, fetched));
  await syncLibrary();
}

function drain() {
  while (workers < 3 && queue.length) {
    const job = queue.shift()!;
    workers++;
    void job.run().catch(() => {}).finally(() => {
      workers--; active.delete(job.url); job.done(); drain();
    });
  }
}

export function enrichSavedPost(id: string): Promise<void> {
  const post = useLibrary.getState().posts.find(p => p.id === id);
  if (!post) return Promise.resolve();
  const url = libraryUrl(post.url);
  const existing = active.get(url);
  if (existing) return existing;
  let done!: () => void;
  const promise = new Promise<void>(resolve => { done = resolve; });
  active.set(url, promise);
  queue.push({ url, done, run: () => enrich(id) });
  drain();
  return promise;
}
