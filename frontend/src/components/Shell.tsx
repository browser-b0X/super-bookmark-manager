import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import Sidebar from "./Sidebar";
import Topbar from "./Topbar";
import CommandPalette from "./CommandPalette";
import { useLegacyMigration } from "../lib/migrate";
import { useLibrary } from "../store/library";
import { syncLibrary, useLibraryPersistence } from "../lib/libraryPersistence";
import { usePrefs } from "../store/prefs";

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
  const pending = useLibrary(s => Object.keys(s.pending).length);
  const demo = useLibrary(s => s.demo);
  const persistence = useLibraryPersistence();

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

  const compactStatus = !mobile && collapsed;
  const saveMessage = pending ? `${pending} change${pending === 1 ? "" : "s"} pending SQLite save`
    : demo ? "Demo only — not saved to SQLite"
    : persistence.status === "saved" ? "Library saved to SQLite"
    : persistence.status === "error" ? "SQLite unavailable — using browser cache"
    : "Checking SQLite…";
  const saveStatus = (
      <div role="status" aria-label="SQLite save status"
        title={compactStatus ? [saveMessage, persistence.status === "error" ? persistence.error : ""].filter(Boolean).join(". ") : undefined}
        className={"sidebar-save-status " + (compactStatus ? "py-2 text-center text-[.62rem] leading-tight" : "panel px-3 py-2 text-[.72rem] break-words")}>
        <span style={{ color: pending || persistence.status === "error" ? "var(--amber)" : "var(--dim)" }}>
          <span className={compactStatus ? "sr-only" : undefined}>{saveMessage}</span>
          {compactStatus && <span aria-hidden="true">
            <span className="mb-1 block text-[.56rem] uppercase tracking-wide">SQLite</span>
            {pending ? <><span className="block">{pending}</span>Pending</>
              : demo ? "Demo"
              : persistence.status === "saved" ? "Saved"
              : persistence.status === "error" ? "Offline" : "Checking"}
          </span>}
        </span>
        {persistence.status === "error" && <p className={compactStatus ? "sr-only" : "mt-1 text-[var(--dim)]"}>{persistence.error}</p>}
        {(pending > 0 || persistence.status === "error") && <button
          className={compactStatus ? "mt-1 block w-full rounded border border-[var(--border)] py-1 text-[.62rem] hover:bg-[var(--surface2)] disabled:opacity-50" : "btn mt-1 block"}
          aria-label={persistence.status === "syncing" ? "Saving…" : "Retry SQLite save"}
          disabled={persistence.status === "syncing"} onClick={() => { void syncLibrary(); }}>
          {persistence.status === "syncing" ? "Saving…" : compactStatus ? "Retry" : "Retry SQLite save"}
        </button>}
      </div>
  );

  return (
    <div className="h-full">
      {!mobile && <Sidebar railRef={railRef} migrationStatus={migration} onOpenPalette={openPalette} saveStatus={saveStatus} />}
      <Topbar onOpenPalette={openPalette} onOpenNavigation={openNavigation} drawerOpen={drawerOpen} menuRef={menuRef} />
      <main
        key={location.pathname.startsWith("/library") ? "library" : "dash"}
        className="shell-main absolute top-[var(--topbar-h)] bottom-0 right-0 left-[var(--sidebar-w)] overflow-y-auto max-[720px]:left-0"
        data-navigation-open={drawerOpen}
      >
        {mobile && <div className="px-4 pt-3">{saveStatus}</div>}
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
        {mobile && <Sidebar mobile migrationStatus={migration} onOpenPalette={openPalette} saveStatus={null}
          onNavigate={closeNavigation} onClose={closeNavigation} closeRef={closeRef} />}
      </dialog>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
