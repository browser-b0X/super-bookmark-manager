import { sealedStorage } from "../lib/cacheSeal";
import { storageKey } from "../lib/publicRuntime";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * Interface preferences — theme (Classic dark/light, Lime, Coral), sidebar width and where imports land.
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

export type Theme = "dark" | "light" | "lime" | "coral";
/** Get started on Home (lib/getStarted.ts): "unseen" until this browser first loads the library, "open" when that
 *  library was new and empty, "closed" once the card's steps are done or it is dismissed, or when the library wasn't new. */
export type GetStarted = "unseen" | "open" | "closed";
const isGetStarted = (v: unknown): v is GetStarted => v === "unseen" || v === "open" || v === "closed";
export const THEMES: { id: Theme; name: string; note: string }[] = [
  { id: "dark", name: "Classic dark", note: "Midnight blue with lavender" },
  { id: "light", name: "Classic light", note: "Pale lavender, dark text" },
  { id: "lime", name: "Lime", note: "Near-black green with lime" },
  { id: "coral", name: "Coral", note: "Charcoal with coral" },
];
const isTheme = (v: unknown): v is Theme => THEMES.some(t => t.id === v);
export const themeName = (v: Theme) => THEMES.find(t => t.id === v)?.name ?? "Classic dark";

interface PrefsState {
  theme: Theme;
  sidebarCollapsed: boolean;
  importTriage: ImportTriage;
  /** Save an offline copy of every new link, in the background. */
  autoSaveCopies: boolean;
  /** Home: one centred column, or the deck beside Up next. Remembered per device. */
  homeLayout: "portrait" | "wide";
  /** Telegram: read Saved Messages once each time the app starts. Off unless turned on. */
  telegramCheckOnStart: boolean;
  /** Telegram: keep photos and videos sent together with a link. */
  telegramKeepMedia: boolean;
  /** Telegram: check again every so often while the app is open. Off unless turned on. */
  telegramTimedCheck: boolean;
  /** How often that check runs, in minutes. */
  telegramCheckMinutes: TelegramCheckMinutes;
  /** Tidy up with AI: sort new unsorted links in the background by itself. Off unless turned on. */
  aiKeepSorting: boolean;
  /** What Tidy up suggests (and a background run applies): shelf, tags, clean title & summary. */
  aiTidyJobs: ("shelf" | "tags" | "title")[];
  getStarted: GetStarted;
  /** Get started: a link was sorted with Keep, Later or Archive while the card was open. */
  getStartedSorted: boolean;
  setTheme(v: Theme): void;
  setHomeLayout(v: "portrait" | "wide"): void;
  setSidebarCollapsed(v: boolean): void;
  setImportTriage(v: ImportTriage): void;
  setAutoSaveCopies(v: boolean): void;
  setTelegramCheckOnStart(v: boolean): void;
  setTelegramKeepMedia(v: boolean): void;
  setTelegramTimedCheck(v: boolean): void;
  setTelegramCheckMinutes(v: TelegramCheckMinutes): void;
  setAiKeepSorting(v: boolean): void;
  setAiTidyJobs(v: ("shelf" | "tags" | "title")[]): void;
  setGetStarted(v: GetStarted): void;
  setGetStartedSorted(v: boolean): void;
}
export const TELEGRAM_CHECK_MINUTES = [30, 60, 180] as const;
export type TelegramCheckMinutes = typeof TELEGRAM_CHECK_MINUTES[number];
const isCheckMinutes = (v: unknown): v is TelegramCheckMinutes => (TELEGRAM_CHECK_MINUTES as readonly unknown[]).includes(v);
const AI_JOBS = ["shelf", "tags", "title"] as const;
const isJobs = (v: unknown): v is ("shelf" | "tags" | "title")[] =>
  Array.isArray(v) && v.length > 0 && v.every(j => (AI_JOBS as readonly unknown[]).includes(j));

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      theme: "dark",
      sidebarCollapsed: false,
      importTriage: "30",
      autoSaveCopies: true,
      telegramCheckOnStart: false,
      telegramKeepMedia: true,
      telegramTimedCheck: false,
      telegramCheckMinutes: 60,
      aiKeepSorting: false,
      aiTidyJobs: ["shelf", "tags", "title"],
      getStarted: "unseen",
      getStartedSorted: false,
      homeLayout: typeof window !== "undefined" && window.innerWidth < 1100 ? "portrait" : "wide",

      setTheme(v) {
        const next = isTheme(v) ? v : "dark";
        set({ theme: next });
        document.documentElement.dataset.theme = next;
      },
      setSidebarCollapsed(v) { set({ sidebarCollapsed: v }); },
      setImportTriage(v) { set({ importTriage: v }); },
      setAutoSaveCopies(v) { set({ autoSaveCopies: v }); },
      setHomeLayout(v) { set({ homeLayout: v }); },
      setTelegramCheckOnStart(v) { set({ telegramCheckOnStart: v === true }); },
      setTelegramKeepMedia(v) { set({ telegramKeepMedia: v === true }); },
      setTelegramTimedCheck(v) { set({ telegramTimedCheck: v === true }); },
      setTelegramCheckMinutes(v) { if (isCheckMinutes(v)) set({ telegramCheckMinutes: v }); },
      setAiKeepSorting(v) { set({ aiKeepSorting: v === true }); },
      setAiTidyJobs(v) { if (isJobs(v)) set({ aiTidyJobs: [...v] }); },
      setGetStarted(v) { if (isGetStarted(v)) set({ getStarted: v }); },
      setGetStartedSorted(v) { set({ getStartedSorted: v === true }); },
    }),
    {
      name: storageKey("prefs-store-v1"),
      // Some of these start things by themselves. Asked for here, as persist does, so no localStorage means no storage.
      storage: createJSONStorage(() => { void localStorage; return sealedStorage; }),
      // Older builds stored only "dark" or "light"; anything unknown falls back to Classic dark.
      merge: (stored, current) => {
        const saved = (stored ?? {}) as Partial<PrefsState>;
        return { ...current, ...saved, theme: isTheme(saved.theme) ? saved.theme : current.theme,
          telegramCheckOnStart: saved.telegramCheckOnStart === true,
          telegramKeepMedia: saved.telegramKeepMedia !== false,
          telegramTimedCheck: saved.telegramTimedCheck === true,
          telegramCheckMinutes: isCheckMinutes(saved.telegramCheckMinutes) ? saved.telegramCheckMinutes : current.telegramCheckMinutes,
          aiKeepSorting: saved.aiKeepSorting === true,
          aiTidyJobs: isJobs(saved.aiTidyJobs) ? saved.aiTidyJobs : current.aiTidyJobs,
          getStarted: isGetStarted(saved.getStarted) ? saved.getStarted : current.getStarted,
          getStartedSorted: saved.getStartedSorted === true };
      },
    },
  ),
);
