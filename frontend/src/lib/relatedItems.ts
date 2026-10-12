import type { SavedPost } from "../types";

/**
 * Local, deterministic Related Items. Scores overlap across the five existing
 * signals — domain, tags, categories, source, status — with no network,
 * embeddings, or text/notes similarity.
 *
 * A post qualifies only on a substantive topical signal (shared domain, tag, or
 * category). Source and status are low-cardinality (few distinct values), so
 * they would otherwise make nearly every pair "related"; they refine ranking but
 * never qualify a match on their own.
 *
 * Ordering is total and input-independent: score descending, then id ascending,
 * so the same library always yields the same list regardless of store order.
 */
export function relatedItems(post: SavedPost, posts: SavedPost[], max = 6): SavedPost[] {
  const tagSet = new Set(post.tags);
  const catSet = new Set(post.categories);
  const scored: { item: SavedPost; score: number }[] = [];

  for (const candidate of posts) {
    if (candidate.id === post.id) continue;

    const domainMatch = !!post.domain && candidate.domain === post.domain;
    let sharedTags = 0;
    for (const t of candidate.tags) if (tagSet.has(t)) sharedTags++;
    let sharedCategories = 0;
    for (const c of candidate.categories) if (catSet.has(c)) sharedCategories++;

    if (!domainMatch && sharedTags === 0 && sharedCategories === 0) continue;

    let score = 0;
    if (domainMatch) score += 3;
    score += sharedTags * 2;
    score += sharedCategories * 2;
    if (candidate.source === post.source) score += 1;
    if (candidate.status === post.status) score += 1;

    scored.push({ item: candidate, score });
  }

  scored.sort((a, b) =>
    b.score - a.score || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0),
  );

  return scored.slice(0, max).map(s => s.item);
}
