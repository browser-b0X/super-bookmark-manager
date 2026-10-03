import type { SavedPost } from "../types";
import type { ImportTriage } from "../store/prefs";

export const IMPORT_TRIAGE_LABELS: Record<ImportTriage, string> = {
  all: "All of them",
  "7": "Saved in the last 7 days",
  "30": "Saved in the last 30 days",
  "90": "Saved in the last 90 days",
  none: "None — file them as already seen",
};

/**
 * Decide which imported bookmarks enter Catch Up. Bookmarks outside the window
 * go straight to the library as `reference` (seen, kept). A bookmark without a
 * date in the export is treated as new, as it always was.
 */
export function applyImportTriage(posts: SavedPost[], triage: ImportTriage, now = Date.now()): { posts: SavedPost[]; queued: number; filed: number } {
  if (triage === "all") return { posts, queued: posts.length, filed: 0 };
  const cutoff = triage === "none" ? Infinity : now - Number(triage) * 86400000;
  let queued = 0;
  const result = posts.map(post => {
    const saved = Date.parse(post.createdAt);
    const fresh = triage !== "none" && (Number.isNaN(saved) || saved >= cutoff);
    if (fresh) { queued++; return post; }
    return { ...post, status: "reference" as const };
  });
  return { posts: result, queued, filed: posts.length - queued };
}
