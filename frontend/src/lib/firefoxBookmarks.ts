import { parseChromiumBookmarks } from "./chromiumBookmarks";

export const FIREFOX_COPY_GUIDANCE = "Firefox may still be using this database. Close Firefox or make a copy of places.sqlite, then select the copy.";

/** No paths, profile discovery, or storage writes: selected bytes only. */
export async function parseFirefoxCopy(file: File) {
  if (file.size > 64 * 1024 * 1024) throw new Error("Firefox copy exceeds the 64 MiB limit. Export bookmarks as HTML instead.");
  let bytes: ArrayBuffer;
  try { bytes = await file.arrayBuffer(); }
  catch { throw new Error(FIREFOX_COPY_GUIDANCE); }
  let response: Response;
  try {
    response = await fetch("/api/import/firefox", { method: "POST", headers: { "Content-Type": "application/octet-stream" },
      body: bytes, signal: AbortSignal.timeout(15000) });
  } catch { throw new Error("Firefox import unavailable. Check the local server, then select your copy again. No bookmarks were imported."); }
  const data = await response.json();
  if (!response.ok || data.ok !== true) throw new Error(typeof data.error === "string" ? data.error : "Could not read the Firefox copy.");
  if (!Number.isSafeInteger(data.historyIgnored) || data.historyIgnored < 0) throw new Error("Invalid Firefox import response.");
  // Reuse canonicalization, supplied-title handling and browser IDs exactly.
  const result = parseChromiumBookmarks(JSON.stringify({ roots: data.roots }));
  if (result.error) throw new Error(result.error + ` ${data.historyIgnored} history-only rows ignored. No bookmarks were imported.`);
  // The SQLite snapshot explicitly identifies missing titles. Leave those empty
  // so the existing conservative enrichment merge can fill them; supplied titles
  // and any existing Library title still win through importPosts.
  const titles = new Map<string, string>();
  for (const node of data.roots.bookmarks.children as { url: string; name: string }[]) {
    const url = new URL(node.url.trim()).href;
    if (!titles.has(url)) titles.set(url, node.name);
  }
  for (const post of result.posts) if (!titles.get(post.canonicalUrl!)?.trim()) post.title = "";
  return { ...result, historyIgnored: data.historyIgnored };
}
