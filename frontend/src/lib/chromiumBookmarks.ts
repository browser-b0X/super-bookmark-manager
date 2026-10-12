import { bookmarkPost, type BookmarkImportResult } from "./bookmarks";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Chromium `date_added`: microseconds since 1601-01-01 UTC, as a string. */
export function isoFromChromiumTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) return undefined;
  const ms = Number(BigInt(value) / 1000n) - 11644473600000;
  if (ms < 788918400000 || ms > Date.now() + 86400000) return undefined;
  return new Date(ms).toISOString();
}

/** A copied Chromium Bookmarks file only; never reads a browser profile. */
export function parseChromiumBookmarks(raw: string): BookmarkImportResult {
  const result: BookmarkImportResult = { posts: [], duplicates: 0, unsupported: 0, malformed: 0 };
  const fail = (error: string): BookmarkImportResult => ({ ...result, posts: [], error });
  if (!raw.trim()) return fail("The Bookmarks file is empty. Choose a copy of your Chromium Bookmarks JSON file.");
  let data: unknown;
  try { data = JSON.parse(raw.replace(/^﻿/, "")); }
  catch { return fail("The Bookmarks file is not valid JSON. Copy/export it again and retry."); }
  if (!object(data) || !object(data.roots) || !Object.keys(data.roots).length) {
    return fail("Unsupported bookmark format: expected a Chromium Bookmarks file with roots.");
  }
  const roots = Object.values(data.roots);
  if (roots.some(node => !object(node) || !Array.isArray(node.children))) {
    return fail("Invalid bookmark root: expected a folder with children. No bookmarks were imported.");
  }
  // An explicit stack handles deep exported folders without recursive call limits.
  const pending: { node: unknown; path: string[] }[] = roots.reverse().map(node => ({ node, path: [] }));
  const seen = new Set<string>();
  while (pending.length) {
    const { node, path } = pending.pop()!;
    if (!object(node)) { result.malformed++; continue; }
    if (node.type === "folder" || (node.type === undefined && Array.isArray(node.children))) {
      if (!Array.isArray(node.children)) return fail("Invalid bookmark folder children. No bookmarks were imported.");
      const name = typeof node.name === "string" ? node.name.trim() : "";
      const childPath = name ? [...path, name] : path;
      for (let i = node.children.length - 1; i >= 0; i--) pending.push({ node: node.children[i], path: childPath });
      continue;
    }
    if (node.type !== "url" || typeof node.url !== "string" || !node.url.trim()
      || (node.name !== undefined && typeof node.name !== "string")) {
      result.malformed++;
      continue;
    }
    let parsed: URL;
    try { parsed = new URL(node.url.trim()); } catch { result.malformed++; continue; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") { result.unsupported++; continue; }
    const canonical = parsed.href;
    if (seen.has(canonical)) { result.duplicates++; continue; }
    seen.add(canonical);
    // Same URL identity as the existing HTML importer, including query/fragment.
    result.posts.push(bookmarkPost(canonical, typeof node.name === "string" ? node.name : undefined, isoFromChromiumTime(node.date_added), path));
  }
  if (!result.posts.length) {
    return fail(`No HTTP(S) bookmarks found. ${result.unsupported} unsupported-scheme and ${result.malformed} malformed entries skipped.`);
  }
  return result;
}
