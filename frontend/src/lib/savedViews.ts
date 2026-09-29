import type { LibraryFilter, SavedView } from "../types";

export function viewName(name: string, views: SavedView[], exceptId?: string): string {
  const clean = name.trim();
  if (!clean || clean.length > 80) throw new Error("Use a name between 1 and 80 characters.");
  if (views.some(v => v.id !== exceptId && v.name.trim().toLowerCase() === clean.toLowerCase())) {
    throw new Error("That name already exists. Select the view and use Update criteria to replace it deliberately.");
  }
  return clean;
}

/** Criteria only; retain stale values, never resolve them to another category. */
export function viewCriteria(filter: LibraryFilter, search = filter.search ?? ""): LibraryFilter {
  const result: LibraryFilter = { kind: filter.kind ?? "all", search };
  if (result.kind === "category") result.categoryId = filter.categoryId;
  if (result.kind === "tag") result.tag = filter.tag;
  if (result.kind === "platform") result.platform = filter.platform;
  return result;
}

export function viewPath(filter: LibraryFilter): string {
  if (filter.kind === "category") return `/library/category/${encodeURIComponent(filter.categoryId ?? "")}`;
  if (filter.kind === "tag") return `/library/tag/${encodeURIComponent(filter.tag ?? "")}`;
  if (filter.kind === "platform") return `/library?platform=${encodeURIComponent(filter.platform ?? "")}`;
  if (!filter.kind || filter.kind === "all") return "/library";
  return `/library?status=${encodeURIComponent(filter.kind)}`;
}
