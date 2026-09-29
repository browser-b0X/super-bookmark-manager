import { type ReactNode, type Ref } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  Bookmark, ChevronLeft, ChevronRight, Inbox, ListTodo,
  Search, Settings, Star, SunMoon,
} from "lucide-react";
import { useLibrary } from "../store/library";
import { usePrefs } from "../store/prefs";
import { STATUS_META } from "../lib/ui";

const sbItem = (extra = "") =>
  `flex w-full items-center gap-2.5 rounded-lg px-2 py-[7px] text-[.84rem] transition-colors ${extra}`;

export default function Sidebar({ migrationStatus, onOpenPalette, saveStatus, mobile = false, onNavigate, onClose, closeRef, railRef }: {
  migrationStatus: string;
  onOpenPalette: () => void;
  saveStatus: ReactNode;
  mobile?: boolean;
  onNavigate?: () => void;
  onClose?: () => void;
  closeRef?: Ref<HTMLButtonElement>;
  railRef?: Ref<HTMLElement>;
}) {
  const posts = useLibrary(s => s.posts);
  const categories = useLibrary(s => s.categories);
  const views = useLibrary(s => s.views);
  const sidebarCollapsed = usePrefs(s => s.sidebarCollapsed);
  const collapsed = !mobile && sidebarCollapsed;
  const setCollapsed = usePrefs(s => s.setSidebarCollapsed);
  const toggleTheme = usePrefs(s => s.toggleTheme);
  const location = useLocation();
  const navigate = useNavigate();

  const catCounts = new Map<string, number>();
  posts.forEach(p => p.categories.forEach(c => catCounts.set(c, (catCounts.get(c) || 0) + 1)));
  const statusCounts = {
    inbox: posts.filter(p => p.status === "inbox").length,
    "to-review": posts.filter(p => p.status === "to-review").length,
    favorites: posts.filter(p => p.favorite).length,
  };

  const navCls = ({ isActive }: { isActive: boolean }) =>
    sbItem(isActive
      ? "bg-[var(--accent-bg)] text-[var(--accent)]"
      : "text-[var(--dim)] hover:bg-[var(--surface2)] hover:text-[var(--text)]");

  /**
   * `navCls` is a function, so it has to be *called*. Adding a string to it
   * instead stringifies the source and the row silently loses its flex layout.
   */
  const navClsWith = (extra: string) =>
    ({ isActive }: { isActive: boolean }) => navCls({ isActive }) + extra;

  return (
    <aside
      ref={railRef}
      tabIndex={-1}
      className={mobile ? "mobile-sidebar flex flex-col" : "fixed top-0 bottom-0 left-0 z-40 flex flex-col border-r transition-[width] duration-200"}
      style={{ width: collapsed ? 56 : 236, background: "var(--surface)", borderColor: "var(--border)" }}
      aria-label="Navigation"
      onClick={e => {
        if (mobile && (e.target as Element).closest("a[href]")) onNavigate?.();
      }}
    >
      {/* logo */}
      <div className={`flex items-center gap-2.5 px-3.5 pt-3.5 pb-2 ${collapsed ? "justify-center px-0" : ""}`}>
        <img src="/brand-logo.svg" alt="Super Bookmark Manager logo" width={48} height={48} className="h-12 w-12 max-w-none shrink-0" />
        {!collapsed && <span className="min-w-0 text-[.9rem] font-semibold tracking-wide leading-tight">Super Bookmark Manager</span>}
        {mobile && <button ref={closeRef} onClick={onClose} className="icon-btn mobile-close" aria-label="Close navigation"><ChevronLeft size={20} /></button>}
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        <button
          onClick={onOpenPalette}
          title="Search (Ctrl+K)"
          className={sbItem("text-[var(--dim)] hover:bg-[var(--surface2)] hover:text-[var(--text)]") + (collapsed ? " justify-center" : "")}
        >
          <Search size={15} className="shrink-0" />
          {!collapsed && <><span className="flex-1 text-left">Search</span><span className="kbd">⌘K</span></>}
        </button>

        {!collapsed && <div className="px-2 pt-3.5 pb-1 text-[.64rem] font-semibold uppercase tracking-[1.2px] text-[var(--faint)]">Navigate</div>}
        <NavLink to="/" end className={navClsWith(collapsed ? " justify-center" : "")} title="Catch up on new links">
          <Inbox size={15} className="shrink-0" />
          {!collapsed && <><span className="flex-1">Catch up</span>{statusCounts.inbox > 0 && <span className="chip">{statusCounts.inbox}</span>}</>}
        </NavLink>
        <NavLink
          to="/library"
          /* Library is active for every nested /library/* route */
          className={({ isActive }) => navCls({ isActive: isActive || location.pathname.startsWith("/library") }) + (collapsed ? " justify-center" : "")}
          title="Saved Posts Library"
        >
          <Bookmark size={15} className="shrink-0" />
          {!collapsed && <><span className="flex-1">Library</span><span className="chip">{posts.length}</span></>}
        </NavLink>

        {/* No separate Inbox entry: "Catch up" above is the inbox queue. */}
        {!collapsed && <div className="px-2 pt-3.5 pb-1 text-[.64rem] font-semibold uppercase tracking-[1.2px] text-[var(--faint)]">Triage</div>}
        <button
          onClick={() => { onNavigate?.(); navigate("/library?status=to-review"); }}
          className={sbItem("text-[var(--dim)] hover:bg-[var(--surface2)] hover:text-[var(--text)]") + (collapsed ? " justify-center" : "")}
          title="Saved for later"
        >
          <ListTodo size={15} className="shrink-0" style={{ color: STATUS_META["to-review"].color }} />
          {!collapsed && <><span className="flex-1 text-left">Saved for later</span><span className="chip">{statusCounts["to-review"]}</span></>}
        </button>

        {!collapsed && <div className="px-2 pt-3.5 pb-1 text-[.64rem] font-semibold uppercase tracking-[1.2px] text-[var(--faint)]">Categories</div>}
        {categories.filter(c => !c.archived).slice(0, 14).map(c => (
          <NavLink key={c.id} to={`/library/category/${c.id}`} className={navClsWith(collapsed ? " justify-center" : "")} title={c.name}>
            <span className="dot shrink-0" style={{ background: c.color }} />
            {!collapsed && <><span className="flex-1 truncate">{c.name}</span><span className="chip">{catCounts.get(c.name) || 0}</span></>}
          </NavLink>
        ))}

        {views.length > 0 && !collapsed && (
          <div className="px-2 pt-3.5 pb-1 text-[.64rem] font-semibold uppercase tracking-[1.2px] text-[var(--faint)]">Saved views</div>
        )}
        {views.map(v => (
          <NavLink key={v.id} to={`/library?view=${v.id}`} className={navClsWith(collapsed ? " justify-center" : "")} title={v.name}>
            <Star size={15} className="shrink-0" />{!collapsed && v.name}
          </NavLink>
        ))}
      </div>

      {!mobile && <div className="mx-2 mb-2 shrink-0">
        {saveStatus}
      </div>}
      {/* footer */}
      <div className={"sidebar-footer flex gap-1 border-t p-2" + (collapsed ? " flex-col shrink-0" : mobile ? " shrink-0" : "")} style={{ borderColor: "var(--border)" }}>
        <NavLink to="/library/settings" className={navClsWith(" flex-1" + (collapsed ? " justify-center" : ""))} title="Settings">
          <Settings size={15} className="shrink-0" />{!collapsed && "Settings"}
        </NavLink>
        <button onClick={toggleTheme} className={sbItem("flex-1 text-[var(--dim)] hover:bg-[var(--surface2)] hover:text-[var(--text)]") + (collapsed ? " justify-center" : "")} title="Toggle theme">
          <SunMoon size={15} className="shrink-0" />{!collapsed && "Theme"}
        </button>
        {!mobile && <button onClick={() => setCollapsed(!collapsed)} className={sbItem("flex-1 text-[var(--dim)] hover:bg-[var(--surface2)] hover:text-[var(--text)]") + (collapsed ? " justify-center" : "")} title={collapsed ? "Expand" : "Collapse"}>
          {collapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
        </button>}
      </div>
      {migrationStatus === "syncing" && !collapsed && (
        <div className="border-t px-3 py-1.5 text-[.66rem] text-[var(--faint)]" style={{ borderColor: "var(--border)" }}>
          Importing from local backend…
        </div>
      )}
      {migrationStatus === "demo" && !collapsed && (
        <div className="border-t px-3 py-1.5 text-[.66rem] text-[var(--amber)]" style={{ borderColor: "var(--border)" }}>
          Demo data — backend offline
        </div>
      )}
    </aside>
  );
}
