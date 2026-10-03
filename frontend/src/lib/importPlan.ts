import type { SavedPost } from "../types";
import { libraryUrl, normalizeUrl } from "./platform";

export type SkipReason = "deleted" | "idConflict";

export interface FolderNode {
  key: string;            // path joined with "\u001f"
  name: string;
  depth: number;
  count: number;          // links in this folder and below
  children: FolderNode[];
}

export interface ImportPlan {
  fresh: SavedPost[];
  existing: SavedPost[];          // same exact link already saved (refreshes source details only)
  likelyDuplicates: { post: SavedPost; match: SavedPost }[];
  skipped: { post: SavedPost; reason: SkipReason }[];
  folders: FolderNode[];
}

export const folderKey = (path: string[] = []) => path.join("\u001f");

/**
 * Dry run of an import: what would be new, already saved, a likely duplicate
 * under another spelling, or skipped — without touching the library.
 */
export function planImport(incoming: SavedPost[], library: SavedPost[], deletedUrls: string[]): ImportPlan {
  const byExact = new Map(library.map(p => [libraryUrl(p.url), p]));
  const byCanonical = new Map<string, SavedPost>();
  for (const p of library) {
    byCanonical.set(normalizeUrl(p.url), p);
    if (p.canonicalUrl) byCanonical.set(normalizeUrl(p.canonicalUrl), p);
  }
  const ids = new Map(library.map(p => [p.id, libraryUrl(p.url)]));
  const deleted = new Set(deletedUrls.map(libraryUrl));
  const plan: ImportPlan = { fresh: [], existing: [], likelyDuplicates: [], skipped: [], folders: [] };
  for (const post of incoming) {
    const exact = libraryUrl(post.url);
    if (deleted.has(exact)) { plan.skipped.push({ post, reason: "deleted" }); continue; }
    if (byExact.has(exact)) { plan.existing.push(post); continue; }
    if (ids.has(post.id) && ids.get(post.id) !== exact) { plan.skipped.push({ post, reason: "idConflict" }); continue; }
    const match = byCanonical.get(normalizeUrl(post.url));
    if (match) { plan.likelyDuplicates.push({ post, match }); continue; }
    plan.fresh.push(post);
  }
  plan.folders = folderTree([...plan.fresh, ...plan.likelyDuplicates.map(d => d.post)]);
  return plan;
}

export function folderTree(posts: SavedPost[]): FolderNode[] {
  const roots: FolderNode[] = [];
  const index = new Map<string, FolderNode>();
  for (const post of posts) {
    const path = post.folderPath ?? [];
    let level = roots;
    for (let depth = 0; depth < path.length; depth++) {
      const key = folderKey(path.slice(0, depth + 1));
      let node = index.get(key);
      if (!node) {
        node = { key, name: path[depth], depth, count: 0, children: [] };
        index.set(key, node);
        level.push(node);
      }
      node.count++;
      level = node.children;
    }
  }
  return roots;
}

export interface ImportOptions {
  /** Folder keys the owner unticked: their links (and subfolders) are left out. */
  excluded: Set<string>;
  /** Folder key → shelf name, "" for "don't file"; absent = automatic keywords. */
  shelfFor: Map<string, string>;
  tagMode: "none" | "leaf" | "path";
  includeDuplicates: boolean;
  batchId: string;
}

const slug = (name: string) => name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 40);

/** Apply the owner's choices from the preview to the posts that will be imported. */
export function applyImportOptions(plan: ImportPlan, options: ImportOptions): SavedPost[] {
  const chosen = [...plan.fresh, ...(options.includeDuplicates ? plan.likelyDuplicates.map(d => d.post) : [])];
  const result: SavedPost[] = [];
  for (const post of chosen) {
    const path = post.folderPath ?? [];
    const prefixes = path.map((_, i) => folderKey(path.slice(0, i + 1)));
    if (prefixes.some(key => options.excluded.has(key))) continue;
    // The nearest mapped folder decides the shelf.
    let shelf: string | undefined;
    for (let i = prefixes.length - 1; i >= 0; i--) {
      if (options.shelfFor.has(prefixes[i])) { shelf = options.shelfFor.get(prefixes[i]); break; }
    }
    const tags = options.tagMode === "leaf" && path.length ? [slug(path[path.length - 1])]
      : options.tagMode === "path" && path.length ? [path.map(slug).filter(Boolean).join("/")] : [];
    result.push({
      ...post,
      importBatchId: options.batchId,
      ...(tags.filter(Boolean).length ? { tags: [...new Set([...post.tags, ...tags.filter(Boolean)])] } : {}),
      // A folder the owner mapped is a deliberate filing: never auto-reclassified.
      ...(shelf ? { categories: [shelf], categoryMode: "manual" as const, categoryReview: false }
        : shelf === "" ? { categories: ["uncategorized"], categoryMode: "manual" as const } : {}),
    });
  }
  return result;
}
