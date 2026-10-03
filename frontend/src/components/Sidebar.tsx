import { useState, type ReactNode, type Ref } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  Archive, Bookmark, ChevronLeft, ChevronRight, FolderOpen, Inbox, ListTodo, Library, Loader, Rss,
  Search, Settings, Settings2, Star, SunMoon, type LucideIcon,
} from "lucide-react";
import CategoryManager from "./library/CategoryManager";
import { useLibrary } from "../store/library";
import { usePrefs } from "../store/prefs";
import { PLATFORM_META, STATUS_META } from "../lib/ui";

const LISTS: { key: string; label: string; icon: LucideIcon; color?: string }[] = [
  { key: "to-review", label: "Later", icon: ListTodo, color: STATUS_META["to-review"].color },
  { key: "in-progress", label: "In progress", icon: Loader, color: STATUS_META["in-progress"].color },
  { key: "reference", label: "Kept", icon: Library, color: STATUS_META.reference.color },
  { key: "favorites", label: "Favorites", icon: Star, color: "var(--amber)" },
  { key: "uncategorized", label: "Unfiled", icon: FolderOpen },
  { key: "archived", label: "Archived", icon: Archive },
];
import { useLibraryCounts } from "../lib/libraryCounts";
import { QuitButton } from "./QuitApp";

const sbItem = (extra = "") =>
  `flex w-full items-center gap-2.5 rounded-lg px-2 py-[7px] text-[.84rem] transition-colors ${extra}`;

export default function Sidebar({ migrationStatus, onOpenPalette, mobile = false, onNavigate, onClose, closeRef, railRef }: {
  migrationStatus: string;
  onOpenPalette: () => void;
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

  const counts = useLibraryCounts();
  const allTags = useLibrary(s => s.allTags)();
  const [catMgr, setCatMgr] = useState(false);
  const params = new URLSearchParams(location.search);
  const feedAll = location.pathname === "/library" && !location.search;
  const active = (key: string, value: string) => location.pathname === "/library" && params.get(key) === value;
  const go = (to: string) => { onNavigate?.(); navigate(to); };
  const platforms = [...counts.platforms.entries()].filter(([key]) => key in PLATFORM_META)
    .sort((a, b) => b[1] - a[1]);
  const catCounts = counts.categories;
  const statusCounts = { inbox: counts.status.inbox || 0 };

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

        <NavLink to="/" end className={({ isActive }) => navCls({ isActive }) + (collapsed ? " justify-center" : "")} title="Your feed: new links on top, the whole library below">
          <Rss size={15} className="shrink-0" />
          {!collapsed && <><span className="flex-1">Feed</span><span className="chip">{posts.length - (counts.status.archived || 0)}</span></>}
        </NavLink>
        {!collapsed && <div className="sb-heading">Lists</div>}
        <NavLink to="/library/inbox" className={navClsWith(collapsed ? " justify-center" : "")} title="Every link waiting to be sorted">
          <Inbox size={15} className="shrink-0" />
          {!collapsed && <><span className="flex-1">New</span>{statusCounts.inbox > 0 && <span className="chip">{statusCounts.inbox}</span>}</>}
        </NavLink>
        <button onClick={() => go("/library")} title="Every saved link, archived ones included"
          className={sbItem(feedAll ? "bg-[var(--accent-bg)] text-[var(--accent)]" : "text-[var(--dim)] hover:bg-[var(--surface2)] hover:text-[var(--text)]") + (collapsed ? " justify-center" : "")}
          aria-current={feedAll ? "page" : undefined}>
          <Bookmark size={15} className="shrink-0" />
          {!collapsed && <><span className="flex-1 text-left">All saved</span><span className="chip">{posts.length}</span></>}
        </button>
        {LISTS.map(({ key, label, icon: Icon, color }) => {
          const n = key === "favorites" ? counts.favorites : key === "uncategorized" ? undefined : counts.status[key] || 0;
          return (
            <button key={key} onClick={() => go(`/library?status=${key}`)} title={label}
              className={sbItem(active("status", key) ? "bg-[var(--accent-bg)] text-[var(--accent)]" : "text-[var(--dim)] hover:bg-[var(--surface2)] hover:text-[var(--text)]") + (collapsed ? " justify-center" : "")}
              aria-current={active("status", key) ? "page" : undefined}>
              <Icon size={15} className="shrink-0" style={color ? { color } : undefined} />
              {!collapsed && <><span className="flex-1 text-left">{label}</span>{n !== undefined && <span className="chip">{n}</span>}</>}
            </button>
          );
        })}

        {!collapsed && <div className="sb-heading flex items-center">Shelves
          <button className="ml-auto text-[var(--faint)] hover:text-[var(--text)]" onClick={() => setCatMgr(true)} title="Manage shelves" aria-label="Manage shelves"><Settings2 size={12} /></button>
        </div>}
        {categories.filter(c => !c.archived).map(c => (
          <NavLink key={c.id} to={`/library/category/${c.id}`} className={navClsWith(collapsed ? " justify-center" : "")} title={c.name}>
            <span className="dot shrink-0" style={{ background: c.color }} />
            {!collapsed && <><span className="flex-1 truncate">{c.name}</span><span className="chip">{catCounts.get(c.name) || 0}</span></>}
          </NavLink>
        ))}

        {!collapsed && platforms.length > 0 && <div className="sb-heading">Platforms</div>}
        {platforms.map(([key, n]) => {
          const m = PLATFORM_META[key as keyof typeof PLATFORM_META];
          const Icon = m.icon;
          return (
            <button key={key} onClick={() => go(`/library?platform=${key}`)} title={m.label}
              className={sbItem(active("platform", key) ? "bg-[var(--accent-bg)] text-[var(--accent)]" : "text-[var(--dim)] hover:bg-[var(--surface2)] hover:text-[var(--text)]") + (collapsed ? " justify-center" : "")}
              aria-current={active("platform", key) ? "page" : undefined}>
              <Icon size={15} className="shrink-0" style={{ color: m.color }} />
              {!collapsed && <><span className="flex-1 text-left">{m.label}</span><span className="chip">{n}</span></>}
            </button>
          );
        })}

        {!collapsed && allTags.length > 0 && <>
          <div className="sb-heading">Tags</div>
          <div className="flex flex-wrap gap-1 px-1.5">
            {allTags.slice(0, 24).map(t => (
              <NavLink key={t} to={`/library/tag/${encodeURIComponent(t)}`} className={({ isActive }) => `chip ${isActive ? "border-[var(--violet)] text-[var(--violet)]" : ""}`}>#{t}</NavLink>
            ))}
          </div>
        </>}

        {views.length > 0 && !collapsed && (
          <div className="px-2 pt-3.5 pb-1 text-[.64rem] font-semibold uppercase tracking-[1.2px] text-[var(--faint)]">Saved views</div>
        )}
        {views.map(v => (
          <NavLink key={v.id} to={`/library?view=${v.id}`} className={navClsWith(collapsed ? " justify-center" : "")} title={v.name}>
            <Star size={15} className="shrink-0" />{!collapsed && v.name}
          </NavLink>
        ))}
      </div>

      {/* footer */}
      <div className={"sidebar-footer flex gap-1 border-t p-2" + (collapsed ? " flex-col shrink-0" : mobile ? " shrink-0" : "")} style={{ borderColor: "var(--border)" }}>
        <NavLink to="/library/settings" className={navClsWith(" flex-1" + (collapsed ? " justify-center" : ""))} title="Settings">
          <Settings size={15} className="shrink-0" />{!collapsed && "Settings"}
        </NavLink>
        <button onClick={toggleTheme} className={sbItem("flex-1 text-[var(--dim)] hover:bg-[var(--surface2)] hover:text-[var(--text)]") + (collapsed ? " justify-center" : "")} title="Toggle theme">
          <SunMoon size={15} className="shrink-0" />{!collapsed && "Theme"}
        </button>
        {/* Quit sits apart from the everyday buttons and always asks first. */}
        <QuitButton className={sbItem("quit-btn shrink-0 justify-center text-[var(--faint)] hover:bg-[var(--surface2)] hover:text-[var(--red)]")
          + (collapsed ? "" : " !w-auto")} label={mobile} />
        {!mobile && <button onClick={() => setCollapsed(!collapsed)} className={sbItem("flex-1 text-[var(--dim)] hover:bg-[var(--surface2)] hover:text-[var(--text)]") + (collapsed ? " justify-center" : "")} title={collapsed ? "Expand" : "Collapse"}>
          {collapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
        </button>}
      </div>
      {/* Saving and syncing show in the fixed-height save indicator above; a row
          here would push the footer up and down on every save. */}
      {migrationStatus === "demo" && !collapsed && (
        <div className="border-t px-3 py-1.5 text-[.66rem] text-[var(--amber)]" style={{ borderColor: "var(--border)" }}>
          Demo data — backend offline
        </div>
      )}
      {catMgr && <CategoryManager onClose={() => setCatMgr(false)} />}
    </aside>
  );
}
