import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Interface preferences — theme and sidebar width. Nothing else.
 *
 * This replaces the old dashboard store, which carried a widget list, a
 * react-grid-layout, tasks, captures and a scratchpad. None of that was why the
 * app exists (catching up on links sent from Telegram), so it's gone along with
 * the widget dashboard itself.
 */
interface PrefsState {
  theme: "dark" | "light";
  sidebarCollapsed: boolean;
  toggleTheme(): void;
  setSidebarCollapsed(v: boolean): void;
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set, get) => ({
      theme: "dark",
      sidebarCollapsed: false,

      toggleTheme() {
        const next = get().theme === "dark" ? "light" : "dark";
        set({ theme: next });
        document.documentElement.dataset.theme = next;
      },
      setSidebarCollapsed(v) { set({ sidebarCollapsed: v }); },
    }),
    { name: "prefs-store-v1" },
  ),
);
