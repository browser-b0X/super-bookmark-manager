import { storageKey } from "../lib/publicRuntime";
import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Interface preferences — theme, sidebar width and where imports land.
 *
 * This replaces the old dashboard store, which carried a widget list, a
 * react-grid-layout, tasks, captures and a scratchpad. None of that was why the
 * app exists (catching up on links sent from Telegram), so it's gone along with
 * the widget dashboard itself.
 */
/**
 * Where newly imported browser bookmarks land. Years of old bookmarks would
 * otherwise bury tonight's links in Catch Up; older ones go straight to the
 * library as already seen ("reference").
 */
export type ImportTriage = "all" | "7" | "30" | "90" | "none";

interface PrefsState {
  theme: "dark" | "light";
  sidebarCollapsed: boolean;
  importTriage: ImportTriage;
  toggleTheme(): void;
  setSidebarCollapsed(v: boolean): void;
  setImportTriage(v: ImportTriage): void;
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set, get) => ({
      theme: "dark",
      sidebarCollapsed: false,
      importTriage: "30",

      toggleTheme() {
        const next = get().theme === "dark" ? "light" : "dark";
        set({ theme: next });
        document.documentElement.dataset.theme = next;
      },
      setSidebarCollapsed(v) { set({ sidebarCollapsed: v }); },
      setImportTriage(v) { set({ importTriage: v }); },
    }),
    { name: storageKey("prefs-store-v1") },
  ),
);
