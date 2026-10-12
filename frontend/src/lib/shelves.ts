import type { Category, SavedPost } from "../types";

export const TOPICAL_SHELF_LIMIT = 12;
export const RESERVED_SHELVES = new Set(["other", "uncategorized"]);

export function appendBoundedShelves(existing: Category[], incoming: Category[]): Category[] {
  const result = [...existing];
  for (const cat of incoming) {
    if (result.some(c => c.name === cat.name)) continue;
    if (!RESERVED_SHELVES.has(cat.name) && result.filter(c => !RESERVED_SHELVES.has(c.name)).length >= TOPICAL_SHELF_LIMIT) continue;
    result.push(cat);
  }
  return result;
}

export function needsCategory(post: SavedPost): boolean {
  return post.categoryMode !== "manual" && (post.categories.length === 0
    || post.categories.every(c => c === "uncategorized")
    || (post.categoryMode === "automatic" && post.categoryReview === true));
}
