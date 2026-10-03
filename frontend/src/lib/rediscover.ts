import type { SavedPost } from "../types";

export interface Rediscovery { post: SavedPost; reason: string }

/** Small deterministic PRNG so a day's picks stay put between visits. */
function seeded(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;

/**
 * Older saves worth another look once Catch Up is empty: things saved around
 * this date in earlier months, favourites not opened in a while, then a
 * day-stable shuffle of the rest of the library (picture posts first).
 */
export function rediscover(posts: SavedPost[], now = new Date(), count = 6, salt = 0): Rediscovery[] {
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const random = seeded(Math.floor(today / DAY) * 31 + salt);
  const pool = posts.filter(p => p.status !== "archived" && p.status !== "inbox" && p.linkStatus !== "gone"
    && now.getTime() - Date.parse(p.createdAt) > 14 * DAY);
  const picked = new Map<string, Rediscovery>();
  const add = (post: SavedPost, reason: string) => { if (picked.size < count && !picked.has(post.id)) picked.set(post.id, { post, reason }); };

  for (const p of pool) {
    const saved = new Date(p.createdAt);
    const months = (now.getFullYear() - saved.getFullYear()) * 12 + now.getMonth() - saved.getMonth();
    if (months >= 1 && Math.abs(saved.getDate() - now.getDate()) <= 1) {
      add(p, months >= 12 && months % 12 === 0 ? `${months / 12} year${months === 12 ? "" : "s"} ago this week`
        : `${months} month${months === 1 ? "" : "s"} ago`);
    }
    if (picked.size >= 2) break;
  }
  const stale = pool.filter(p => p.favorite && (!p.lastOpenedAt || now.getTime() - Date.parse(p.lastOpenedAt) > 30 * DAY));
  for (const p of stale.sort(() => random() - .5).slice(0, 2)) add(p, "A favourite you haven't opened lately");
  const rest = pool.map(p => ({ p, k: random() - (p.thumbnailUrl ? .35 : 0) })).sort((a, b) => a.k - b.k);
  for (const { p } of rest) add(p, p.categories[0] && p.categories[0] !== "other" ? `From ${p.categories[0].replace(/-/g, " ")}` : "From your library");
  return [...picked.values()];
}
