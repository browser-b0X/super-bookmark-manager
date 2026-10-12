import { create } from "zustand";
import { usePrefs } from "../store/prefs";

/**
 * Whether this server can make saved copies. Unknown counts as "no": nothing
 * is queued, and no control is shown, until the server has said yes.
 */
export const useCopyAvailability = create<{ enabled: boolean }>(() => ({ enabled: false }));

/** New links get a copy when the server can make one and the owner left auto-save on. */
export function wantsCopyOfNewLinks(): boolean {
  return useCopyAvailability.getState().enabled && usePrefs.getState().autoSaveCopies;
}
