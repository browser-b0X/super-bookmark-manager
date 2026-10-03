import type { SavedPost } from "../types";
import { libraryUrl, useLibrary } from "../store/library";
import { needsCategory } from "./shelves";
import { syncLibrary, useLibraryPersistence } from "./libraryPersistence";
import { enrichSavedPost } from "./metadataEnrichment";
import { titleFromUrl } from "./platform";

const active = new Set<string>();
const queue: { id: string; enrich: boolean }[] = [];
let workers = 0;

async function classify(id: string) {
  const post = useLibrary.getState().posts.find(p => p.id === id);
  if (!post || !needsCategory(post)) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  let category = "other";
  try {
    // Saved title/URL are link-specific. A title derived from the URL slug carries
    // no topic information, so an opaque link can only be classified from its
    // caption. Any other title came from the file or a fetch and still wins alone:
    // one caption can describe several links, so it must not reclassify them.
    const urlDerivedTitle = post.title === titleFromUrl(post.canonicalUrl || post.url);
    // Links in the caption belong to other posts (one message can carry several);
    // this post's own URL is already included above.
    const caption = urlDerivedTitle ? post.excerpt?.replace(/https?:\/\/\S+/g, " ").trim() : undefined;
    const content = [post.title, post.url, post.description, caption].filter(Boolean).join("\n");
    const response = await fetch("/api/categorize", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, keywords_only: true }), signal: controller.signal,
    });
    if (response.ok) {
      const data = await response.json();
      if (data.ok === true && typeof data.category_name === "string") category = data.category_name;
    }
  } catch { /* Import is already complete; an unavailable classifier leaves review. */ }
  finally { clearTimeout(timer); }
  // Recheck current state after the request: edits and deletion always win.
  useLibrary.getState().applyAutomaticCategory(id, category);
}

function drain() {
  if (useLibraryPersistence.getState().status !== "saved") return;
  while (workers < 3 && queue.length) {
    const state = useLibrary.getState();
    const index = queue.findIndex(job => {
      const post = state.posts.find(p => p.id === job.id);
      return !post || !(libraryUrl(post.url) in state.pending);
    });
    if (index < 0) return;
    const job = queue.splice(index, 1)[0];
    workers++;
    void classify(job.id).finally(() => {
      if (job.enrich) void enrichSavedPost(job.id);
      workers--; active.delete(job.id); drain();
    });
  }
}

// Only this session's imported jobs resume after a failed SQLite write; no library sweep.
useLibraryPersistence.subscribe(state => { if (state.status === "saved") queueMicrotask(drain); });

export function importFilePosts(incoming: SavedPost[], options: { newOnly?: boolean } = {}) {
  const state = useLibrary.getState();
  const existing = new Set((state.demo ? [] : state.posts).map(p => libraryUrl(p.url)));
  const result = state.importPosts(incoming);
  const urls = new Set(incoming.map(p => libraryUrl(p.url)));
  for (const post of useLibrary.getState().posts) {
    const isNew = !existing.has(libraryUrl(post.url));
    if (options.newOnly && !isNew) continue;
    if (!urls.has(libraryUrl(post.url)) || (!needsCategory(post) && !isNew) || active.has(post.id)) continue;
    active.add(post.id);
    queue.push({ id: post.id, enrich: isNew });
  }
  if (queue.length) void syncLibrary().then(saved => { if (saved) drain(); });
  return result;
}
