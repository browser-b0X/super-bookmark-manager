import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import Sidebar from "./Sidebar";
import Topbar from "./Topbar";
import CommandPalette from "./CommandPalette";
import { useLegacyMigration } from "../lib/migrate";
import { usePrefs } from "../store/prefs";
import SyncIndicator from "./SyncIndicator";
import { QuitHost } from "./QuitApp";
import Backdrop from "./Backdrop";

export default function Shell() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 720px)").matches);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const collapsed = usePrefs(s => s.sidebarCollapsed);
  const location = useLocation();
  const migration = useLegacyMigration();

  const closeNavigation = () => {
    dialogRef.current?.close();
    setDrawerOpen(false);
  };
  const openPalette = () => {
    closeNavigation();
    setPaletteOpen(true);
  };
  const openNavigation = () => {
    const dialog = dialogRef.current;
    if (!mobile || !dialog || dialog.open) return;
    dialog.showModal();
    closeRef.current?.focus();
    setDrawerOpen(true);
  };

  useEffect(() => {
    const query = window.matchMedia("(max-width: 720px)");
    const update = () => setMobile(query.matches);
    query.addEventListener("change", update);
    update();
    return () => query.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--sidebar-w", mobile ? "0px" : collapsed ? "56px" : "236px");
    if (!mobile && dialogRef.current?.open) {
      dialogRef.current.close();
      setDrawerOpen(false);
      railRef.current?.focus();
    }
  }, [mobile, collapsed]);

  useEffect(() => {
    dialogRef.current?.close();
    setDrawerOpen(false);
  }, [location.pathname, location.search, location.hash]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        dialogRef.current?.close();
        setDrawerOpen(false);
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
      {!mobile && <Sidebar railRef={railRef} migrationStatus={migration} onOpenPalette={openPalette} />}
      <Topbar onOpenPalette={openPalette} onOpenNavigation={openNavigation} drawerOpen={drawerOpen} menuRef={menuRef} />
      <main
        key={location.pathname.startsWith("/library") ? "library" : "dash"}
        className="shell-main absolute top-[var(--topbar-h)] bottom-0 right-0 left-[var(--sidebar-w)] overflow-y-auto max-[720px]:left-0"
        data-navigation-open={drawerOpen}
      >
        <Outlet />
      </main>
      <dialog
        ref={dialogRef}
        id="mobile-navigation"
        aria-label="Mobile navigation"
        onClose={() => { if (!dialogRef.current?.open) setDrawerOpen(false); }}
        onCancel={closeNavigation}
        onClick={e => { if (e.target === e.currentTarget) closeNavigation(); }}
      >
        {mobile && <Sidebar mobile migrationStatus={migration} onOpenPalette={openPalette} 
          onNavigate={closeNavigation} onClose={closeNavigation} closeRef={closeRef} />}
      </dialog>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      <QuitHost />
      <SyncIndicator />
    </div>
  );
}
