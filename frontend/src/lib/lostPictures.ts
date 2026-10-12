import { create } from "zustand";
import type { SavedPost } from "../types";
import { pictureCode } from "./previewHealth";

/**
 * Pictures the links point at (`/thumb/<code>`) that aren't on this computer. A JSON backup
 * keeps the addresses, not the picture files, so after restoring one on a new install they
 * are all missing until their previews are fetched again (a fetch stores each picture under
 * the same code). The server is asked when the previews panel opens and after a fetch.
 */
export const useLostPictures = create<{ codes: ReadonlySet<string> }>(() => ({ codes: new Set<string>() }));

export async function checkLostPictures(posts: SavedPost[]): Promise<void> {
  const codes = [...new Set(posts.map(p => pictureCode(p.thumbnailUrl)).filter(Boolean))];
  if (!codes.length) {
    useLostPictures.setState({ codes: new Set() });
    return;
  }
  try {
    const response = await fetch("/api/thumbs/missing", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ codes }),
      cache: "no-store", signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (response.ok && Array.isArray(data?.missing)) {
      useLostPictures.setState({ codes: new Set(data.missing.filter((code: unknown): code is string => typeof code === "string")) });
    }
  } catch { /* the server is away: nothing to conclude */ }
}

/** A fetch just returned this picture: the server has stored it again. */
export function pictureFound(url?: string) {
  const code = pictureCode(url);
  const { codes } = useLostPictures.getState();
  if (!code || !codes.has(code)) return;
  const next = new Set(codes);
  next.delete(code);
  useLostPictures.setState({ codes: next });
}
