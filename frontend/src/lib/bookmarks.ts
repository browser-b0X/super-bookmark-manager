import type { SavedPost } from "../types";
import { postFromUrl } from "./providers";

export interface BookmarkImportResult {
  posts: SavedPost[];
  duplicates: number;
  unsupported: number;
  error?: string;
}

/** Parse an exported bookmark file without attaching its HTML to the page. */
export function parseBookmarkHtml(raw: string): BookmarkImportResult {
  const result: BookmarkImportResult = { posts: [], duplicates: 0, unsupported: 0 };
  const fail = (error: string): BookmarkImportResult => ({ ...result, posts: [], error });
  if (!raw.trim()) return fail("The bookmark file is empty. Export bookmarks as HTML from Firefox or Chrome and try again.");

  const html = raw.replace(/<!--[\s\S]*?-->/g, "");
  if (!/^\s*<!DOCTYPE\s+NETSCAPE-Bookmark-file-1\s*>/i.test(html)) {
    return fail("This is not a Netscape bookmark HTML export. Choose the bookmarks HTML file exported by your browser.");
  }

  // HTML parsing repairs truncated markup silently. Require balanced bookmark
  // lists/links first; Netscape exports intentionally omit closing DT/P tags.
  const stack: string[] = [];
  let lists = 0;
  for (const token of html.matchAll(/<\s*(\/?)\s*(DL|A)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    const tag = token[2].toLowerCase();
    if (token[1]) {
      if (stack.pop() !== tag) return fail("The bookmark HTML is malformed or incomplete. Export it again and retry.");
    } else {
      if (tag === "dl") lists++;
      stack.push(tag);
    }
  }
  if (!lists || stack.length) return fail("The bookmark HTML is malformed or incomplete. Export it again and retry.");

  // Template contents are inert: scripts and remote images in the file never run.
  const template = document.createElement("template");
  template.innerHTML = html;
  const anchors = [...template.content.querySelectorAll("a")];
  if (!anchors.length) return fail("No bookmarks were found in this HTML export.");

  const seen = new Set<string>();
  for (const anchor of anchors) {
    const url = anchor.getAttribute("href")?.trim();
    if (!anchor.closest("dl") || !url) return fail("The bookmark HTML contains an incomplete link. Export it again and retry.");
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { return fail("The bookmark HTML contains an invalid URL. No bookmarks were imported."); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      result.unsupported++;
      continue;
    }
    // Retain fragments and query values: separate bookmark targets must not be
    // collapsed by the general link importer's tracking/fragment normalization.
    const canonical = parsed.href;
    if (seen.has(canonical)) { result.duplicates++; continue; }
    seen.add(canonical);
    const title = anchor.textContent ?? "";
    const post = postFromUrl(url, "browser");
    result.posts.push({
      ...post,
      // URL-safe base64 is stable/collision-free and survives router decoding.
      id: `browser-${btoa(canonical).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`,
      canonicalUrl: canonical,
      title: title.trim() ? title : post.title,
      thumbnailUrl: undefined,
    });
  }
  if (!result.posts.length) return fail(`No HTTP(S) bookmarks found. ${result.unsupported} unsupported-scheme entry/entries skipped.`);
  return result;
}
