import { storageKey } from "../lib/publicRuntime";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  LayoutGrid, Link2, List, Plus, Search, Table2,
} from "lucide-react";
import { useLibrary } from "../store/library";
import type { LibraryFilter, SavedPost, SavedView } from "../types";
import { viewCriteria, viewPath } from "../lib/savedViews";
import SavedViews from "../components/library/SavedViews";
import { PLATFORM_META, STATUS_META } from "../lib/ui";
import { PostGrid, PostList, PostTable } from "../components/library/PostViews";
import PostDrawer from "../components/library/PostDrawer";
import BulkBar from "../components/library/BulkBar";
import CatchUpRail from "../components/library/CatchUpRail";
import Rediscover from "../components/library/Rediscover";
import { effectivePlatform } from "../lib/platform";
import AddLinkDialog from "../components/library/AddLinkDialog";
import { isEmptyQuery, matchesQuery, parseQuery } from "../lib/librarySearch";
import { useLibraryPersistence } from "../lib/libraryPersistence";

let lastListWasFeed = true;

type ViewMode = "grid" | "list" | "table";
type SortMode = "newest" | "oldest" | "title" | "domain" | "custom";

export default function LibraryPage() {
  const navigate = useNavigate();
  const params = useParams();
  const location = useLocation();
  const [search] = useSearchParams();
  const posts = useLibrary(s => s.posts);
  const categories = useLibrary(s => s.categories);
  const views = useLibrary(s => s.views);
  const [appliedId, setAppliedId] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>(() => (localStorage.getItem(storageKey("lib-view")) as ViewMode) || "grid");
  const [sort, setSort] = useState<SortMode>(() => {
    try { return (localStorage.getItem(storageKey("lib-sort")) as SortMode) || "newest"; } catch { return "newest"; }
  });
  const reorderPosts = useLibrary(s => s.reorderPosts);
  const demo = useLibrary(s => s.demo);
  // "/" is the feed: new links ride in the strip on top, everything else below.
  // A link opened from the feed keeps the feed behind its drawer.
  const feed = location.pathname === "/" || (!!params.postId && lastListWasFeed);
  if (!params.postId) lastListWasFeed = location.pathname === "/";
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addLink, setAddLink] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { localStorage.setItem(storageKey("lib-view"), viewMode); }, [viewMode]);
  useEffect(() => { try { localStorage.setItem(storageKey("lib-sort"), sort); } catch { /* per-browser convenience only */ } }, [sort]);
  // A selection only ever covers what is on screen: changing the filter or the
  // search text clears it, so a bulk delete can never hit hidden items.
  useEffect(() => { setSelected(new Set()); }, [params.categoryId, params.tagId, params.postId, search.toString(), q]);

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

  // Typing stays responsive on large libraries: filtering follows a beat
  // behind. Small libraries filter immediately (no visible lag to hide).
  const lazyQ = useDeferredValue(q);
  const deferredQ = posts.length > 2000 ? lazyQ : q;
  const persistence = useLibraryPersistence(state => state.status);
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
      case "platform": list = list.filter(p => effectivePlatform(p) === f.platform); break;
      default:
        // The feed shows new links in the strip, so its grid holds the rest of the library.
        if (feed) list = list.filter(p => p.status !== "inbox" && p.status !== "archived");
        break; // All saved includes archived records; status filters narrow it.
    }
    const parsed = parseQuery(deferredQ);
    if (!isEmptyQuery(parsed)) list = list.filter(p => matchesQuery(p, parsed));
    const sorted = [...list];
    switch (sort) {
      case "newest": sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); break;
      case "oldest": sorted.sort((a, b) => a.createdAt.localeCompare(b.createdAt)); break;
      case "title": sorted.sort((a, b) => (a.title || a.url).localeCompare(b.title || b.url)); break;
      case "domain": sorted.sort((a, b) => a.domain.localeCompare(b.domain)); break;
      case "custom": sorted.sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER)
        || b.createdAt.localeCompare(a.createdAt)); break;
    }
    return sorted.sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false));
  }, [posts, filter, deferredQ, sort, categories, feed]);
  const fresh = useMemo(() => feed && !q ? posts.filter(p => p.status === "inbox") : [], [feed, q, posts]);
  const onReorder = (ids: string[]) => {
    // Dragging always means "my order": keep what is on screen and switch to it.
    reorderPosts(ids);
    setSort("custom");
  };
  const resetKey = `${JSON.stringify(filter)}|${deferredQ}|${sort}`;

  const toggleSelect = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const drawerPost: SavedPost | undefined = params.postId ? posts.find(p => p.id === params.postId) : undefined;



  return (
    <div className="flex h-full">
      {/* ── Main content ─────────────────────────────────── */}
      <div className="min-w-0 flex-1 p-5">
        {/* header */}
        <div className="mb-4 flex flex-wrap items-center gap-2.5">
          <h1 className="text-[1.05rem] font-bold">
            {filter.kind === "category" ? categories.find(c => c.id === filter.categoryId)?.name ?? filter.categoryId
              : filter.kind === "tag" ? `#${filter.tag}`
              : filter.kind === "all" ? (feed ? "Feed" : "Saved Posts")
              : filter.kind === "platform" ? PLATFORM_META[filter.platform as keyof typeof PLATFORM_META]?.label ?? "Platform"
              : filter.kind === "favorites" ? "Favorites" : filter.kind === "uncategorized" ? "Unfiled"
              : filter.kind === "reference" ? "Kept" : filter.kind === "to-review" ? "Later"
              : STATUS_META[filter.kind as keyof typeof STATUS_META]?.label ?? "Library"}
          </h1>
          <span className="chip">{filtered.length}</span>
          <div className="relative min-w-[180px] flex-1 max-w-[340px]">
            <Search size={13} className="absolute top-1/2 left-3 -translate-y-1/2 text-[var(--faint)]" />
            <input ref={searchRef} className="input pl-8" placeholder="Search… ( / )" value={q} onChange={e => setQ(e.target.value)}
              aria-describedby="search-hint" title="Operators: site:example.com  #tag  is:unread|later|favorite|gone|unfiled  shelf:travel  in:&quot;Folder&quot;" />
            <span id="search-hint" className="sr-only">Supports site:, #tag, is:unread, is:later, is:favorite, is:gone, shelf: and in: folder filters.</span>
          </div>
          <button className="btn btn-primary" onClick={() => setAddLink(true)}><Plus size={13} /> Add link</button>
          <SavedViews criteria={criteria} onApply={applyView} />
          <button className="btn" onClick={() => { setQ(""); setAppliedId(null); navigate(feed ? "/" : "/library"); }}>Clear search and filters</button>
          {savedView && <span className="max-w-full break-words text-xs text-[var(--dim)]">{savedView.name}{viewModified ? " — modified" : " — applied"}</span>}
          <select className="input max-[720px]:hidden" style={{ width: "auto" }} value={sort} onChange={e => setSort(e.target.value as never)} aria-label="Sort">
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="title">Title</option>
            <option value="domain">Domain</option>
            <option value="custom">My order</option>
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

        {demo && <div role="status" className="panel mb-4 p-3 text-[.82rem] text-[var(--amber)]">
          Sample library — these examples are not your imported content and are not saved to SQLite.
          Start the local server to see your own links.
        </div>}
        {fresh.length > 0 && filter.kind === "all" && <CatchUpRail posts={fresh} />}
        {feed && !q && fresh.length === 0 && filtered.length > 0 && <Rediscover posts={posts} />}
        {feed && fresh.length > 0 && filtered.length > 0 && <h2 className="feed-subhead">Your library</h2>}

        {/* content */}
        {filtered.length === 0 && posts.length === 0 && (persistence === "idle" || persistence === "syncing") ? (
          // First load from SQLite: show where cards will appear, not "Nothing here yet".
          <div className="cell-grid grid gap-3.5" aria-busy="true" aria-label="Loading your library">
            {Array.from({ length: 8 }, (_, i) => <div key={i} className="panel skeleton h-[260px]" />)}
          </div>
        ) : filtered.length === 0 && feed && fresh.length > 0 ? (
          <p className="mt-6 text-center text-[.8rem] text-[var(--dim)]">Everything you've saved is new — sort the links above and they'll settle here.</p>
        ) : filtered.length === 0 ? (
          <div className="mx-auto mt-[10vh] max-w-[380px] text-center">
            <Link2 size={26} className="mx-auto text-[var(--faint)]" />
            <h2 className="mt-3 text-[.95rem] font-semibold">{q ? `No results for “${q}”` : posts.length ? "Nothing here yet" : "Your library is empty"}</h2>
            <p className="mt-1 text-[.78rem] text-[var(--dim)]">
              {q ? "Try a different search, or clear the filter. Operators like site:, #tag and is:unread narrow results." : posts.length
                ? "No saved links match this filter."
                : "Import browser bookmarks or a Telegram export, or add a link to get started."}
            </p>
            <div className="mt-4 flex justify-center gap-2">
              <button className="btn btn-primary" onClick={() => setAddLink(true)}><Plus size={13} /> Add link</button>
              <button className="btn" onClick={() => navigate("/library/settings")}>Import links</button>
            </div>
          </div>
        ) : viewMode === "grid" ? (
          <PostGrid posts={filtered} selected={selected} onToggle={toggleSelect} resetKey={resetKey}
            onReorder={onReorder} />
        ) : viewMode === "list" ? (
          <PostList posts={filtered} selected={selected} onToggle={toggleSelect} resetKey={resetKey} />
        ) : (
          <PostTable posts={filtered} selected={selected} onToggle={toggleSelect} resetKey={resetKey} />
        )}
      </div>

      {/* overlays */}
      <BulkBar ids={filtered.filter(p => selected.has(p.id)).map(p => p.id)} onClear={() => setSelected(new Set())} />
      {drawerPost && <PostDrawer post={drawerPost} onClose={() => navigate(-1)} />}
      {drawerPost === undefined && params.postId && (
        <div className="overlay" onMouseDown={() => navigate("/library")}>
          <div className="modal mt-[20vh] p-6 text-center">
            <p className="text-[.85rem]">This saved post no longer exists.</p>
            <button className="btn mt-3" onClick={() => navigate("/library")}>Back to library</button>
          </div>
        </div>
      )}
      {addLink && <AddLinkDialog onClose={() => setAddLink(false)} />}
    </div>
  );
}
