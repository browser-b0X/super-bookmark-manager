/**
 * Frozen store migrations.
 *
 * A migration is a historical artifact: it keeps behaving the same for every
 * store written before it. Stores from before the default shelves (version 0)
 * get those shelves; every other shelf in them is kept as one the owner made,
 * and the server's library brings the links' shelves up to date on the next sync.
 */
import type { Category, SavedPost } from "../types";

/** The canonical shelves, in the order they should appear in the sidebar. */
export const CANONICAL_SHELVES: { name: string; description: string }[] = [
  { name: "food-drink", description: "Recipes, cooking, ingredients and coffee." },
  { name: "technology", description: "AI, software, engineering, science and cars." },
  { name: "social-media", description: "Platform tactics, growth, creators and content strategy." },
  { name: "health-fitness", description: "Training, medical, wellness, biohacking, self-improvement." },
  { name: "arts-culture", description: "Art, music, film, design, folklore and philosophy." },
  { name: "entertainment", description: "Humour, news, games, TV and things to enjoy." },
  { name: "business-money", description: "Finance, business, legal and local commerce." },
  { name: "style-beauty", description: "Fashion, hair and natural cosmetics." },
  { name: "travel", description: "Destinations, trips and places to go." },
];

const RESERVED_SHELVES: Category[] = [
  { id: "other", name: "other", description: "No shelf fits these yet.", color: "#63636f", order: 900 },
  { id: "uncategorized", name: "uncategorized", description: "Not sorted yet.", color: "#63636f", order: 999 },
];

interface PersistedLibrary {
  posts?: SavedPost[];
  categories?: Category[];
  [key: string]: unknown;
}

const norm = (name: string) => (name || "").trim().toLowerCase().replace(/\s+/g, "-");

export function migrateToCanonicalShelves(
  persisted: PersistedLibrary,
  palette: string[],
): PersistedLibrary {
  // A name that isn't a default shelf is one the owner made, so it survives untouched.
  const shelfFor = (name: string) => norm(name) || "uncategorized";

  const posts = (persisted.posts ?? []).map(p => {
    const mapped = [...new Set((p.categories ?? []).map(shelfFor))];
    // Two old categories can collapse onto one shelf, and a post that landed on
    // a real shelf must not still claim to be unsorted.
    const real = mapped.filter(c => c !== "uncategorized");
    return { ...p, categories: real.length ? real : ["uncategorized"] };
  });

  const canon: Category[] = CANONICAL_SHELVES.map((s, i) => ({
    id: s.name,
    name: s.name,
    description: s.description,
    color: palette[i % palette.length],
    order: i,
  }));

  const canonIds = new Set(canon.map(c => c.id));
  const custom = (persisted.categories ?? [])
    .filter(c => !canonIds.has(c.id) && !canonIds.has(norm(c.id)) && c.id !== "other" && c.id !== "uncategorized")
    .map((c, i) => ({ ...c, order: canon.length + i }));

  return { ...persisted, posts, categories: [...canon, ...custom, ...RESERVED_SHELVES] };
}

/** How far back a link still counts as "not caught up on yet". */
const QUEUE_WINDOW_DAYS = 14;

/**
 * Refill the Catch-Up queue for stores written before it existed.
 *
 * The old importer marked any link the categorizer had shelved as `reference`
 * ("filed, done with it"), which meant that once categorization worked properly
 * nothing was ever new and the landing page was permanently empty.
 *
 * Only `reference` is reopened: it was assigned by the importer, never chosen.
 * `to-review`, `in-progress` and `archived` can only come from a deliberate act,
 * so they are left alone.
 *
 * The window is measured from the newest link in the store, not from today. An
 * import that has been sitting untouched for a month would otherwise migrate to
 * an empty queue — the very bug this repairs.
 */
export function reopenRecentQueue(persisted: { posts?: SavedPost[] }): typeof persisted {
  const posts = persisted.posts ?? [];
  const newest = posts.reduce((max, p) => (p.createdAt > max ? p.createdAt : max), "");
  if (!newest) return persisted;

  const cutoff = new Date(new Date(newest).getTime() - QUEUE_WINDOW_DAYS * 86400000).toISOString();

  return {
    ...persisted,
    posts: posts.map(p => (p.status === "reference" && p.createdAt >= cutoff
      ? { ...p, status: "inbox" as const }
      : p)),
  };
}
