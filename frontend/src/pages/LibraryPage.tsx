import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Bookmark, FolderOpen, Inbox, LayoutGrid, Link2, List, Plus, Rows3,
  Search, Settings2, SlidersHorizontal, Star, Table2, Tags,
} from "lucide-react";
import { useLibrary } from "../store/library";
import type { LibraryFilter, SavedPost, SavedView } from "../types";
import { viewCriteria, viewPath } from "../lib/savedViews";
import SavedViews from "../components/library/SavedViews";
import { PLATFORM_META, STATUS_META } from "../lib/ui";
import { PostGrid, PostList, PostTable } from "../components/library/PostViews";
import PostDrawer from "../components/library/PostDrawer";
import BulkBar from "../components/library/BulkBar";
import CategoryManager from "../components/library/CategoryManager";
import AddLinkDialog from "../components/library/AddLinkDialog";

type ViewMode = "grid" | "list" | "table";

export default function LibraryPage() {
  const navigate = useNavigate();
  const params = useParams();
  const location = useLocation();
  const [search] = useSearchParams();
  const posts = useLibrary(s => s.posts);
  const categories = useLibrary(s => s.categories);
  const views = useLibrary(s => s.views);
  const [appliedId, setAppliedId] = useState<string | null>(null);
  const allTags = useLibrary(s => s.allTags)();

  const [q, setQ] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>(() => (localStorage.getItem("lib-view") as ViewMode) || "grid");
  const [sort, setSort] = useState<"newest" | "oldest" | "title" | "domain">("newest");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [panelOpen, setPanelOpen] = useState(true);
  const [catMgr, setCatMgr] = useState(false);
  const [addLink, setAddLink] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { localStorage.setItem("lib-view", viewMode); }, [viewMode]);
  useEffect(() => { setSelected(new Set()); }, [params.categoryId, params.tagId, params.postId, search.toString()]);

  // "/" focuses search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ── Derive the active filter from the URL ───────────── */
  const statusParam = search.get("status");
  const viewParam = search.get("view");
  const platformParam = search.get("platform");
  const savedView = views.find(v => v.id === appliedId);
  const applyView = (view: SavedView) => {
    setQ(view.filter.search ?? "");
    setAppliedId(view.id);
    navigate(viewPath(view.filter));
  };
  // Existing sidebar/bookmark links retain their supported entry point. Restore
  // visible controls, then use precisely the ordinary URL filtering path.
  useEffect(() => {
    const view = views.find(v => v.id === viewParam);
    if (view) {
      setQ(view.filter.search ?? ""); setAppliedId(view.id);
      navigate(viewPath(view.filter), { replace: true });
    }
  }, [viewParam, views, navigate]);

  const filter = useMemo<LibraryFilter>(() => {
    if (params.postId) return { kind: "all" as const }; // drawer opens over "All"
    if (params.categoryId) return { kind: "category" as const, categoryId: params.categoryId };
    if (params.tagId) return { kind: "tag" as const, tag: params.tagId };
    if (location.pathname.endsWith("/inbox")) return { kind: "inbox" as const };
    if (statusParam) return { kind: statusParam as never };
    if (platformParam) return { kind: "platform" as const, platform: platformParam as never };
    return { kind: "all" as const };
  }, [params, statusParam, platformParam, location.pathname]);
  const criteria = viewCriteria(filter, q);
  const viewModified = savedView && JSON.stringify(viewCriteria(savedView.filter)) !== JSON.stringify(criteria);

  const filtered = useMemo(() => {
    let list = posts;
    const f = filter;
    switch (f.kind) {
      case "inbox": list = list.filter(p => p.status === "inbox"); break;
      case "to-review": list = list.filter(p => p.status === "to-review"); break;
      case "in-progress": list = list.filter(p => p.status === "in-progress"); break;
      case "reference": list = list.filter(p => p.status === "reference"); break;
      case "archived": list = list.filter(p => p.status === "archived"); break;
      case "favorites": list = list.filter(p => p.favorite); break;
      case "uncategorized": list = list.filter(p => p.categories.length === 0 || p.categories.every(c => c === "uncategorized")); break;
      case "category": list = list.filter(p => p.categories.includes(categories.find(c => c.id === f.categoryId)?.name ?? f.categoryId!)); break;
      case "tag": list = list.filter(p => p.tags.includes(f.tag!)); break;
      case "platform": list = list.filter(p => p.platform === f.platform); break;
      default: break; // All saved includes archived records; status filters narrow it.
    }
    if (q.trim()) {
      const ql = q.toLowerCase();
      list = list.filter(p =>
        (p.title || "").toLowerCase().includes(ql) ||
        (p.description || "").toLowerCase().includes(ql) ||
        (p.excerpt || "").toLowerCase().includes(ql) ||
        (p.userNotes || "").toLowerCase().includes(ql) ||
        p.url.toLowerCase().includes(ql) ||
        p.tags.some(t => t.toLowerCase().includes(ql)));
    }
    const sorted = [...list];
    switch (sort) {
      case "newest": sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); break;
      case "oldest": sorted.sort((a, b) => a.createdAt.localeCompare(b.createdAt)); break;
      case "title": sorted.sort((a, b) => (a.title || a.url).localeCompare(b.title || b.url)); break;
      case "domain": sorted.sort((a, b) => a.domain.localeCompare(b.domain)); break;
    }
    return sorted.sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false));
  }, [posts, filter, q, sort, categories]);

  const toggleSelect = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const drawerPost: SavedPost | undefined = params.postId ? posts.find(p => p.id === params.postId) : undefined;

  const filterBtn = (active: boolean) =>
    `flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left text-[.78rem] transition-colors ${active ? "bg-[var(--accent-bg)] text-[var(--accent)]" : "text-[var(--dim)] hover:bg-[var(--surface2)] hover:text-[var(--text)]"}`;

  const statusCount = (s: string) => posts.filter(p => p.status === s).length;

  return (
    <div className="flex h-full">
      {/* ── Filter panel ─────────────────────────────────── */}
      {panelOpen && (
        <nav className="w-[190px] shrink-0 overflow-y-auto border-r p-2.5 max-[900px]:hidden" style={{ borderColor: "var(--border)" }} aria-label="Library filters">
          <button className={filterBtn(filter.kind === "all")} onClick={() => navigate("/library")}><Bookmark size={13} /> All saved <span className="chip ml-auto">{posts.length}</span></button>
          <button className={filterBtn(filter.kind === "inbox")} onClick={() => navigate("/library/inbox")}><Inbox size={13} /> Inbox <span className="chip ml-auto">{statusCount("inbox")}</span></button>
          {(["to-review", "in-progress", "reference"] as const).map(s => (
            <button key={s} className={filterBtn(filter.kind === s)} onClick={() => navigate(`/library?status=${s}`)}>
              <span className="dot" style={{ background: STATUS_META[s].color }} /> {STATUS_META[s].label} <span className="chip ml-auto">{statusCount(s)}</span>
            </button>
          ))}
          <button className={filterBtn(filter.kind === "favorites")} onClick={() => navigate("/library?status=favorites")}><Star size={13} /> Favorites <span className="chip ml-auto">{posts.filter(p => p.favorite).length}</span></button>
          <button className={filterBtn(filter.kind === "uncategorized")} onClick={() => navigate("/library?status=uncategorized")}><FolderOpen size={13} /> Uncategorized</button>
          <button className={filterBtn(filter.kind === "archived")} onClick={() => navigate("/library?status=archived")}><Bookmark size={13} /> Archived <span className="chip ml-auto">{statusCount("archived")}</span></button>

          <div className="mt-3 flex items-center px-2 pb-1 text-[.62rem] font-semibold tracking-[1px] text-[var(--faint)] uppercase">
            Categories
            <button className="ml-auto text-[var(--faint)] hover:text-[var(--text)]" onClick={() => setCatMgr(true)} title="Manage categories"><Settings2 size={12} /></button>
          </div>
          {categories.filter(c => !c.archived).map(c => (
            <button key={c.id} className={filterBtn(filter.kind === "category" && filter.categoryId === c.id)} onClick={() => navigate(`/library/category/${c.id}`)}>
              <span className="dot" style={{ background: c.color }} />
              <span className="truncate">{c.name}</span>
              <span className="chip ml-auto">{posts.filter(p => p.categories.includes(c.name)).length}</span>
            </button>
          ))}

          <div className="mt-3 px-2 pb-1 text-[.62rem] font-semibold tracking-[1px] text-[var(--faint)] uppercase">Platforms</div>
          {Object.entries(PLATFORM_META).map(([key, m]) => {
            const n = posts.filter(p => p.platform === key).length;
            if (!n) return null;
            const Icon = m.icon;
            return (
              <button key={key} className={filterBtn(filter.kind === "platform" && filter.platform === key)} onClick={() => navigate(`/library?platform=${key}`)}>
                <Icon size={13} style={{ color: m.color }} /> {m.label} <span className="chip ml-auto">{n}</span>
              </button>
            );
          })}

          {allTags.length > 0 && <div className="mt-3 px-2 pb-1 text-[.62rem] font-semibold tracking-[1px] text-[var(--faint)] uppercase"><Tags size={10} className="mr-1 inline" />Tags</div>}
          <div className="flex flex-wrap gap-1 px-1">
            {allTags.slice(0, 18).map(t => (
              <button key={t} className={`chip ${filter.kind === "tag" && filter.tag === t ? "border-[var(--violet)] text-[var(--violet)]" : ""}`} onClick={() => navigate(`/library/tag/${t}`)}>#{t}</button>
            ))}
          </div>

        </nav>
      )}

      {/* ── Main content ─────────────────────────────────── */}
      <div className="min-w-0 flex-1 p-5">
        {/* header */}
        <div className="mb-4 flex flex-wrap items-center gap-2.5">
          <button className="icon-btn max-[900px]:flex" onClick={() => setPanelOpen(o => !o)} title="Toggle filter panel" aria-pressed={panelOpen}>
            <SlidersHorizontal size={15} />
          </button>
          <h1 className="text-[1.05rem] font-bold">
            {filter.kind === "category" ? categories.find(c => c.id === filter.categoryId)?.name ?? filter.categoryId
              : filter.kind === "tag" ? `#${filter.tag}`
              : filter.kind === "all" ? "Saved Posts"
              : STATUS_META[filter.kind as keyof typeof STATUS_META]?.label ?? "Library"}
          </h1>
          <span className="chip">{filtered.length}</span>
          <div className="relative min-w-[180px] flex-1 max-w-[340px]">
            <Search size={13} className="absolute top-1/2 left-3 -translate-y-1/2 text-[var(--faint)]" />
            <input ref={searchRef} className="input pl-8" placeholder="Search… ( / )" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={() => setAddLink(true)}><Plus size={13} /> Add link</button>
          <SavedViews criteria={criteria} onApply={applyView} />
          <button className="btn" onClick={() => { setQ(""); setAppliedId(null); navigate("/library"); }}>Clear search and filters</button>
          {savedView && <span className="max-w-full break-words text-xs text-[var(--dim)]">{savedView.name}{viewModified ? " — modified" : " — applied"}</span>}
          <select className="input max-[720px]:hidden" style={{ width: "auto" }} value={sort} onChange={e => setSort(e.target.value as never)} aria-label="Sort">
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="title">Title</option>
            <option value="domain">Domain</option>
          </select>
          <div className="flex overflow-hidden rounded-lg border" style={{ borderColor: "var(--border)" }} role="radiogroup" aria-label="View mode">
            {([["grid", LayoutGrid], ["list", List], ["table", Table2]] as const).map(([mode, Icon]) => (
              <button key={mode} role="radio" aria-checked={viewMode === mode} title={mode}
                className={`icon-btn rounded-none ${viewMode === mode ? "on" : ""}`}
                onClick={() => setViewMode(mode)}>
                <Icon size={14} />
              </button>
            ))}
          </div>
        </div>

        {/* content */}
        {filtered.length === 0 ? (
          <div className="mx-auto mt-[10vh] max-w-[380px] text-center">
            <Link2 size={26} className="mx-auto text-[var(--faint)]" />
            <h2 className="mt-3 text-[.95rem] font-semibold">{q ? `No results for “${q}”` : "Nothing here yet"}</h2>
            <p className="mt-1 text-[.78rem] text-[var(--dim)]">
              {q ? "Try a different search, or clear the filter." : "Import your Telegram export or add a link to get started."}
            </p>
            <div className="mt-4 flex justify-center gap-2">
              <button className="btn btn-primary" onClick={() => setAddLink(true)}><Plus size={13} /> Add link</button>
              <button className="btn" onClick={() => navigate("/library/settings")}>Import from Telegram</button>
            </div>
          </div>
        ) : viewMode === "grid" ? (
          <PostGrid posts={filtered} selected={selected} onToggle={toggleSelect} />
        ) : viewMode === "list" ? (
          <PostList posts={filtered} selected={selected} onToggle={toggleSelect} />
        ) : (
          <PostTable posts={filtered} selected={selected} onToggle={toggleSelect} />
        )}
      </div>

      {/* overlays */}
      <BulkBar ids={[...selected]} onClear={() => setSelected(new Set())} />
      {drawerPost && <PostDrawer post={drawerPost} onClose={() => navigate(-1)} />}
      {drawerPost === undefined && params.postId && (
        <div className="overlay" onMouseDown={() => navigate("/library")}>
          <div className="modal mt-[20vh] p-6 text-center">
            <p className="text-[.85rem]">This saved post no longer exists.</p>
            <button className="btn mt-3" onClick={() => navigate("/library")}>Back to library</button>
          </div>
        </div>
      )}
      {catMgr && <CategoryManager onClose={() => setCatMgr(false)} />}
      {addLink && <AddLinkDialog onClose={() => setAddLink(false)} />}
    </div>
  );
}
