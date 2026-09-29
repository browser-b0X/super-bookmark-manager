import type { BookmarkImportResult } from "./bookmarks";
import { postFromUrl } from "./providers";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A copied Chromium Bookmarks file only; never reads a browser profile. */
export function parseChromiumBookmarks(raw: string): BookmarkImportResult {
  const result: BookmarkImportResult = { posts: [], duplicates: 0, unsupported: 0 };
  const fail = (error: string): BookmarkImportResult => ({ ...result, posts: [], error });
  if (!raw.trim()) return fail("The Bookmarks file is empty. Choose a copy of your Chromium Bookmarks JSON file.");
  let data: unknown;
  try { data = JSON.parse(raw.replace(/^\uFEFF/, "")); }
  catch { return fail("The Bookmarks file is not valid JSON. Copy/export it again and retry."); }
  if (!object(data) || !object(data.roots) || !Object.keys(data.roots).length) {
    return fail("Unsupported bookmark format: expected a Chromium Bookmarks file with roots.");
  }
  const roots = Object.values(data.roots);
  if (roots.some(node => !object(node) || !Array.isArray(node.children))) {
    return fail("Invalid bookmark root: expected a folder with children. No bookmarks were imported.");
  }
  // An explicit stack handles deep exported folders without recursive call limits.
  const pending: unknown[] = roots.reverse();
  const seen = new Set<string>();
  while (pending.length) {
    const node = pending.pop();
    if (!object(node)) return fail("Invalid bookmark entry. No bookmarks were imported.");
    if (node.type === "folder" || (node.type === undefined && Array.isArray(node.children))) {
      if (!Array.isArray(node.children)) return fail("Invalid bookmark folder children. No bookmarks were imported.");
      for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]);
      continue;
    }
    if (node.type !== "url" || typeof node.url !== "string" || !node.url.trim()
      || (node.name !== undefined && typeof node.name !== "string")) {
      return fail("Invalid bookmark URL entry. No bookmarks were imported.");
    }
    let parsed: URL;
    try { parsed = new URL(node.url.trim()); }
    catch { return fail("Invalid bookmark URL. No bookmarks were imported."); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") { result.unsupported++; continue; }
    const canonical = parsed.href;
    if (seen.has(canonical)) { result.duplicates++; continue; }
    seen.add(canonical);
    const post = postFromUrl(node.url, "browser");
    result.posts.push({ ...post,
      // Same URL identity as the existing HTML importer, including query/fragment.
      id: `browser-${btoa(canonical).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`,
      canonicalUrl: canonical,
      title: typeof node.name === "string" && node.name.trim() ? node.name : post.title,
      thumbnailUrl: undefined,
    });
  }
  if (!result.posts.length) return fail(`No HTTP(S) bookmarks found. ${result.unsupported} unsupported-scheme entries skipped.`);
  return result;
}
