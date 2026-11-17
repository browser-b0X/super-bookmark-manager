import type { PostStatus, SavedPost } from "../types";

/** Bulk edit (v0.4.0): tags and shelves added, removed or replaced, and the status set, on many links at once. */
export type EditMode = "add" | "remove" | "replace";
export interface BulkEdit {
  tags?: { mode: EditMode; values: string[] };
  shelves?: { mode: EditMode; values: string[] };
  status?: PostStatus;
}
/** What a link held before an edit (for Undo), and the edit's time: Undo leaves a link changed since alone. */
export interface EditRecord { id: string; at: string; before: Pick<SavedPost, "tags" | "categories" | "categoryMode" | "categoryReview" | "status"> }

const PLACEHOLDERS = new Set(["uncategorized", "other"]);
const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const unique = (values: string[]) => [...new Set(values)];

function edited(list: string[], change: { mode: EditMode; values: string[] } | undefined, placeholders = false): string[] {
  if (!change) return list;
  if (change.mode === "replace") return unique(change.values);
  if (change.mode === "remove") return list.filter(v => !change.values.includes(v));
  // Filing a link on a real shelf takes it out of "not filed yet" (as Add to shelf does).
  const kept = placeholders && change.values.some(v => !PLACEHOLDERS.has(v)) ? list.filter(v => !PLACEHOLDERS.has(v)) : list;
  return unique([...kept, ...change.values]);
}

/** The fields an edit changes on one link, or null when it changes nothing there. */
export function editPost(post: SavedPost, edit: BulkEdit): Partial<SavedPost> | null {
  const patch: Partial<SavedPost> = {};
  const tags = edited(post.tags, edit.tags);
  if (!same(tags, post.tags)) patch.tags = tags;
  const categories = edited(post.categories, edit.shelves, true);
  if (!same(categories, post.categories)) Object.assign(patch, { categories, categoryMode: "manual", categoryReview: false });
  if (edit.status && edit.status !== post.status) patch.status = edit.status;
  return Object.keys(patch).length ? patch : null;
}

/** A tag as the library writes them: lower case, no "#", spaces as dashes. */
export const cleanTag = (value: string) => value.trim().replace(/^#+/, "").toLowerCase().replace(/\s+/g, "-");
