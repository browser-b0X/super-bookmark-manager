import { parseChromiumBookmarks } from "./chromiumBookmarks";
import type { BookmarkImportResult } from "./bookmarks";

/**
 * Firefox "Backup…" JSON (Library → Import and Backup → Backup…).
 *
 * It carries folders and dates without the close-Firefox-and-copy-places.sqlite
 * routine, and is parsed entirely in the browser. Nodes are converted to the
 * Chromium shape so the one parser owns URL identity, titles and folders.
 */
const ROOT_NAMES: Record<string, string> = {
  menu________: "Bookmarks Menu", toolbar_____: "Bookmarks Toolbar",
  unfiled_____: "Other Bookmarks", mobile______: "Mobile Bookmarks",
};

interface FirefoxJsonNode {
  guid?: string; title?: string; uri?: string; type?: string; typeCode?: number;
  dateAdded?: number; children?: FirefoxJsonNode[];
}

export function isFirefoxJsonBackup(data: unknown): boolean {
  const node = data as FirefoxJsonNode | null;
  return !!node && typeof node === "object" && (node.guid === "root________" || node.type === "text/x-moz-place-container")
    && Array.isArray(node.children);
}

export function parseFirefoxJson(raw: string): BookmarkImportResult {
  let data: unknown;
  try { data = JSON.parse(raw.replace(/^﻿/, "")); }
  catch { return { posts: [], duplicates: 0, unsupported: 0, malformed: 0, error: "The Firefox backup is not valid JSON. Create the backup again and retry." }; }
  if (!isFirefoxJsonBackup(data)) {
    return { posts: [], duplicates: 0, unsupported: 0, malformed: 0, error: "Unsupported file: expected a Firefox bookmarks backup (.json)." };
  }
  const convert = (node: FirefoxJsonNode, depth: number): unknown => {
    if (depth > 400) return null;
    const folder = node.typeCode === 2 || node.type === "text/x-moz-place-container" || Array.isArray(node.children);
    if (folder) {
      const name = (node.guid && ROOT_NAMES[node.guid]) || (node.guid === "root________" ? "" : node.title || "");
      return { type: "folder", name, children: (node.children ?? []).map(child => convert(child, depth + 1)) };
    }
    if (node.typeCode === 3 || node.type === "text/x-moz-place-separator") return { type: "folder", name: "", children: [] };
    return {
      type: "url", url: typeof node.uri === "string" ? node.uri : "", name: typeof node.title === "string" ? node.title : "",
      // PRTime µs since 1970 → Chromium µs since 1601.
      ...(Number.isSafeInteger(node.dateAdded) && node.dateAdded! > 0 ? { date_added: String(BigInt(node.dateAdded!) + 11644473600000000n) } : {}),
    };
  };
  return parseChromiumBookmarks(JSON.stringify({ roots: { root: convert(data as FirefoxJsonNode, 0) } }));
}
