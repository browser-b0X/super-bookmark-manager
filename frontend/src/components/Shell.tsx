import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import TopNav from "./TopNav";
import CommandPalette from "./CommandPalette";
import { useLegacyMigration } from "../lib/migrate";
import SyncIndicator from "./SyncIndicator";
import { QuitHost } from "./QuitApp";
import Backdrop from "./Backdrop";
import NoticeToast from "./NoticeToast";
import { checkTelegramAtStart } from "../lib/telegramRefresh";
import { startWhenUnsortedLinksWait } from "../lib/aiTidy";
import { usePrefs } from "../store/prefs";

/**
 * The new look: a top bar, no sidebar. The page area plays a short transition
 * when the section changes (not when a link's panel opens over a list), and
 * the moving background stays behind everything.
 */
export default function Shell() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();
  const migration = useLegacyMigration();
  const lastKey = useRef("/");
  const isPanel = location.pathname.startsWith("/library/item/");
  const sectionKey = isPanel ? lastKey.current : location.pathname + location.search;
  useEffect(() => { if (!isPanel) lastKey.current = sectionKey; }, [isPanel, sectionKey]);

  useEffect(() => { if (migration !== "demo") checkTelegramAtStart(); }, [migration]);
  // "Keep sorting new links" (Settings > Tidy up with AI): background runs start by themselves.
  const keepSorting = usePrefs(s => s.aiKeepSorting);
  useEffect(() => {
    if (!keepSorting || migration === "demo") return;
    return startWhenUnsortedLinksWait(() => usePrefs.getState().aiKeepSorting, () => usePrefs.getState().aiTidyJobs);
  }, [keepSorting, migration]);

  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--sidebar-w", "0px");
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(o => !o);
      }
      if (e.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="h-full">
      <Backdrop />
      <TopNav onOpenPalette={() => setPaletteOpen(true)} />
      {migration === "demo" && <p className="demo-note" role="status">Demo data: the app's server isn't answering, so nothing you change here is saved.</p>}
      <main className="shell-main absolute top-[var(--topbar-h)] bottom-0 right-0 left-0 overflow-y-auto">
        <div key={sectionKey} className="page-transition">
          <Outlet />
        </div>
      </main>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      <QuitHost />
      <SyncIndicator />
      <NoticeToast />
    </div>
  );
}
