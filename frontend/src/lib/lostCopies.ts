import { create } from "zustand";
import type { SavedPost } from "../types";

/**
 * Copies the links say they have (`archiveKey`) that aren't on this computer. A JSON backup
 * keeps the keys, not the copies, so after restoring one on a new install every link still
 * says "saved" until its copy is made again. The server is asked when the saved-copies
 * settings or the bulk bar open; "Save copies" then treats these links as having none.
 */
export const useLostCopies = create<{ keys: ReadonlySet<string> }>(() => ({ keys: new Set<string>() }));

const KEY = /^[0-9a-f]{32}$/;

export async function checkLostCopies(posts: SavedPost[]): Promise<void> {
  const keys = [...new Set(posts.filter(p => p.archiveStatus === "saved" && p.archiveKey && KEY.test(p.archiveKey)).map(p => p.archiveKey!))];
  if (!keys.length) {
    useLostCopies.setState({ keys: new Set() });
    return;
  }
  try {
    const response = await fetch("/api/archive/missing", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys }),
      cache: "no-store", signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (response.ok && Array.isArray(data?.missing)) {
      useLostCopies.setState({ keys: new Set(data.missing.filter((key: unknown): key is string => typeof key === "string")) });
    }
  } catch { /* the server is away: nothing to conclude */ }
}

/** A copy was just saved under this key: it is on this computer again. */
export function copyFound(key?: string) {
  const { keys } = useLostCopies.getState();
  if (!key || !keys.has(key)) return;
  const next = new Set(keys);
  next.delete(key);
  useLostCopies.setState({ keys: next });
}

/** The link has a copy, and as far as the server said, the copy is on this computer. */
export function hasCopy(post: SavedPost, lost: ReadonlySet<string> = useLostCopies.getState().keys): boolean {
  return post.archiveStatus === "saved" && !(post.archiveKey && lost.has(post.archiveKey));
}
