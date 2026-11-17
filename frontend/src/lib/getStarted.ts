import { useLibrary } from "../store/library";
import { usePrefs } from "../store/prefs";
import { useLibraryPersistence } from "./libraryPersistence";

/**
 * Get started on Home (owner, 2026-11-02): a card with three steps that tick themselves, only for a library that is new
 * and empty when this browser first loads it from SQLite: no links, and no links removed before. Decided once per
 * browser, on that first load, whichever page is open; a library that had links never gets it. The card then stays,
 * after the first import too, until its steps are done or it is dismissed (prefs `getStarted`).
 * Returns what stops the wait.
 */
export function decideGetStarted(): () => void {
  const decide = () => {
    if (usePrefs.getState().getStarted !== "unseen") return true;
    if (useLibraryPersistence.getState().status !== "saved") return false;
    const { posts, removed, demo } = useLibrary.getState();
    if (demo) return false;
    usePrefs.getState().setGetStarted(posts.length === 0 && (removed ?? []).length === 0 ? "open" : "closed");
    return true;
  };
  if (decide()) return () => {};
  const stop = useLibraryPersistence.subscribe(() => { if (decide()) stop(); });
  return stop;
}

/** Keep, Later or Archive on Home: the card's third step. */
export function sortedALink() {
  const prefs = usePrefs.getState();
  if (prefs.getStarted === "open" && !prefs.getStartedSorted) prefs.setGetStartedSorted(true);
}
