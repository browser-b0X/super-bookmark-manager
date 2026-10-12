import type { SavedPost } from "../types";
import { postFromUrl } from "./providers";

export interface BookmarkImportResult {
  posts: SavedPost[];
  duplicates: number;
  unsupported: number;
  /** Entries skipped because the link itself was unusable (bad/missing URL). */
  malformed: number;
  error?: string;
}

/** URL-safe base64 is stable/collision-free and survives router decoding. */
export function browserBookmarkId(href: string): string {
  const bytes = new TextEncoder().encode(href);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `browser-${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/** Seconds (Netscape ADD_DATE) → ISO, or undefined when absent/implausible. */
export function isoFromUnixSeconds(value: string | null | undefined): string | undefined {
  if (!value || !/^\d{1,12}$/.test(value.trim())) return undefined;
  const ms = Number(value.trim()) * 1000;
  // 1995-01-01 .. now + 1 day: anything else is a broken export, not a date.
  if (ms < 788918400000 || ms > Date.now() + 86400000) return undefined;
  return new Date(ms).toISOString();
}

/** Build one browser post; the bookmark's own date and folders are kept. */
export function bookmarkPost(href: string, title: string | undefined, createdAt: string | undefined, folderPath: string[]): SavedPost {
  const post = postFromUrl(href, "browser");
  const supplied = !!title && !!title.trim();
  return {
    ...post,
    id: browserBookmarkId(href),
    canonicalUrl: href,
    title: supplied ? title : post.title,
    // A title from the owner's bookmark file is theirs; a URL-derived one may
    // be replaced by the page's real title when enrichment runs.
    fieldSources: { title: supplied ? "file" : "derived" },
    thumbnailUrl: undefined,
    ...(createdAt ? { createdAt } : {}),
    ...(folderPath.length ? { folderPath } : {}),
  };
}

/** Folder names for an anchor in a Netscape export: <DT><H3>Name</H3><DL>…</DL>. */
function foldersOf(anchor: Element): string[] {
  const path: string[] = [];
  let list = anchor.closest("dl");
  while (list) {
    const holder = list.parentElement;
    const heading = holder && holder.tagName === "DT" ? holder.querySelector(":scope > h3") : list.previousElementSibling?.tagName === "H3" ? list.previousElementSibling : null;
    const name = heading?.textContent?.trim();
    if (name) path.unshift(name);
    list = holder?.closest("dl") ?? null;
  }
  return path;
}

/** Parse an exported bookmark file without attaching its HTML to the page. */
export function parseBookmarkHtml(raw: string): BookmarkImportResult {
  const result: BookmarkImportResult = { posts: [], duplicates: 0, unsupported: 0, malformed: 0 };
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
    // One unusable entry is skipped and counted; it never sinks the whole file.
    if (!anchor.closest("dl") || !url) { result.malformed++; continue; }
    let parsed: URL;
    try { parsed = new URL(url); } catch { result.malformed++; continue; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      result.unsupported++;
      continue;
    }
    // Retain fragments and query values: separate bookmark targets must not be
    // collapsed by the general link importer's tracking/fragment normalization.
    const canonical = parsed.href;
    if (seen.has(canonical)) { result.duplicates++; continue; }
    seen.add(canonical);
    result.posts.push(bookmarkPost(canonical, anchor.textContent ?? "", isoFromUnixSeconds(anchor.getAttribute("add_date")), foldersOf(anchor)));
  }
  if (!result.posts.length) {
    return fail(`No HTTP(S) bookmarks found. ${result.unsupported} unsupported-scheme and ${result.malformed} malformed entries skipped.`);
  }
  return result;
}
