import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Archive, ArrowUpRight, Bookmark, Check, Clock, Inbox, RotateCcw, Settings,
} from "lucide-react";
import { useLibrary } from "../store/library";
import { PLATFORM_META, STATUS_META, relTime } from "../lib/ui";
import { PostPreview } from "../components/library/PostViews";
import { displayText, displayTitle } from "../lib/displayText";
import type { PostStatus, SavedPost } from "../types";

/** Review imported links, with a clear path back to the full curated library. */

const UNFILED = new Set(["uncategorized", "other"]);

/** The three ways a link leaves the queue. */
const EXITS: { status: PostStatus; label: string; hint: string; icon: typeof Check }[] = [
  { status: "reference", label: "Keep", hint: "Filed — I'm done with it", icon: Check },
  { status: "to-review", label: "Later", hint: "Come back and read this properly", icon: Clock },
  { status: "archived", label: "Archive", hint: "Seen it, don't need it", icon: Archive },
];

/** One link in the queue. */
function QueueItem({ post, expanded, leaving, onExpand, onHover, onFocus, onBlur, onExit }: {
  post: SavedPost;
  expanded: boolean;
  leaving?: PostStatus;
  onExpand: () => void;
  onHover: () => void;
  onFocus: () => void;
  onBlur: () => void;
  onExit: (post: SavedPost, status: PostStatus) => void;
}) {
  const updatePost = useLibrary(s => s.updatePost);
  const touchOpened = useLibrary(s => s.touchOpened);
  const categories = useLibrary(s => s.categories);
  const demo = useLibrary(s => s.demo);
  const meta = PLATFORM_META[post.platform];

  const shelf = post.categories.find(c => !UNFILED.has(c));
  const shelfColor = categories.find(c => c.name === shelf)?.color;
  const origin = demo ? "Sample" : post.source === "browser" ? "Browser bookmark" : post.source === "telegram" ? "Telegram" : post.source;
  const summary = displayText(post.description || post.aiSummary || post.excerpt);

  return (
    <article
      className={`catchup-card${expanded ? " is-expanded" : ""}${leaving ? " is-leaving" : ""}`}
      data-post-id={post.id}
      aria-label={displayTitle(post.title, post.url)}
      aria-hidden={leaving ? true : undefined}
      ref={el => { el?.toggleAttribute("inert", !!leaving); }}
      onPointerEnter={e => { if (e.pointerType !== "touch" && !leaving) onHover(); }}
      onFocusCapture={onFocus}
      onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget)) onBlur(); }}
    >
      <div className="catchup-media"><PostPreview post={post.title ? { ...post, title: displayText(post.title) } : post} fill /></div>
      <div className="catchup-shade" />
      <button className="catchup-expand" aria-label={`Expand ${displayTitle(post.title, post.url)}`} aria-expanded={expanded}
        data-expand onClick={onExpand} disabled={!!leaving}>
        <meta.icon size={18} />
      </button>
      <div className="catchup-peek" aria-hidden="true">{origin} · {shelf || post.categories[0] || "uncategorized"}</div>
      {leaving && <div className="catchup-completed"><Check size={24} />
        {leaving === "reference" ? "Kept" : leaving === "archived" ? "Archived" : "Saved for later"}
      </div>}

      <div className="catchup-content" aria-hidden={!expanded || !!leaving}
        ref={el => { el?.toggleAttribute("inert", !expanded || !!leaving); }}>
        <p className="catchup-origin">{origin} <span>· {post.domain}</span></p>
        {/* Opening the link is the point of the page, so the title IS the link. */}
        <a
          href={post.url}
          target="_blank"
          rel="noreferrer noopener"
          onClick={() => touchOpened(post.id)}
          className="catchup-title"
          title={displayTitle(post.title, post.url)}
        >
          <span className="min-w-0 break-words">{displayTitle(post.title, post.url)}</span>
          <ArrowUpRight size={13} className="shrink-0 text-[var(--faint)] group-hover/t:text-[var(--accent)]" />
        </a>

        <p className="catchup-date">Saved {relTime(post.createdAt)}</p>

        {summary && <p className="catchup-summary">{summary}</p>}

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="chip" style={{ color: STATUS_META[post.status].color }}>{STATUS_META[post.status].label}</span>
          {!shelf && <span className="chip">{post.categories[0] || "uncategorized"}{post.categoryReview ? " · review" : ""}</span>}
          {shelf ? (
            <span className="chip inline-flex items-center gap-1.5" style={{ color: shelfColor }}>
              <span className="dot" style={{ background: shelfColor, width: 6, height: 6 }} />
              {shelf}
            </span>
          ) : (
            // Unfiled links are the one thing worth fixing inline — a link with no
            // shelf is a link that won't be found again.
            <select
              className="input"
              style={{ width: "auto", padding: "2px 6px", fontSize: ".68rem" }}
              value=""
              onChange={e => e.target.value && updatePost(post.id, { categories: [e.target.value] })}
              aria-label={`Shelf for ${displayTitle(post.title, post.url)}`}
            >
              <option value="">Put on a shelf…</option>
              {categories
                .filter(c => !c.archived && !UNFILED.has(c.name))
                .sort((a, b) => a.order - b.order)
                .map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
          )}
          {post.tags.slice(0, 3).map(t => (
            <span key={t} className="chip" style={{ color: "var(--violet)" }}>#{t}</span>
          ))}
        </div>
      <div className="catchup-actions">
        <a className="btn btn-primary" href={post.url} target="_blank" rel="noreferrer noopener" onClick={() => touchOpened(post.id)}>
          Open original <ArrowUpRight size={14} />
        </a>
        <Link className="btn" to={`/library/item/${post.id}`}>Details</Link>
      </div>
      <div className="catchup-actions" aria-label="Triage actions">
        {EXITS.map(({ status, label, hint, icon: Icon }) => (
          <button
            key={status}
            className="btn"
            data-triage={status}
            title={hint}
            onClick={() => onExit(post, status)}
          >
            <Icon size={11} /> {label}
          </button>
        ))}
      </div>
      </div>
    </article>
  );
}

export default function CatchUpPage() {
  const posts = useLibrary(s => s.posts);
  const demo = useLibrary(s => s.demo);
  const updatePost = useLibrary(s => s.updatePost);
  const navigate = useNavigate();
  /** Single-level undo — triage is fast, so a misclick has to be cheap to fix. */
  const [lastExit, setLastExit] = useState<{ post: SavedPost; from: PostStatus; to: PostStatus } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [exiting, setExiting] = useState<Record<string, { post: SavedPost; to: PostStatus }>>({});
  const [actionError, setActionError] = useState("");
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const rail = useRef<HTMLDivElement>(null);
  const emptyLink = useRef<HTMLAnchorElement>(null);
  const focusNext = useRef<{ id?: string; control?: PostStatus } | null>(null);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReducedMotion(preference.matches);
    preference.addEventListener("change", change);
    return () => { preference.removeEventListener("change", change); timers.current.forEach(clearTimeout); };
  }, []);

  const queue = useMemo(
    () => posts
      .filter(p => p.status === "inbox")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [posts],
  );
  const visible = useMemo(() => posts.filter(p => p.status === "inbox" || exiting[p.id])
    .map(p => exiting[p.id]?.post || p).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [posts, exiting]);
  const available = (id: string | null) => queue.some(p => p.id === id) ? id : null;
  // Keep a focused control visible; hover is temporary and never changes saved state.
  const expandedId = available(focusedId) || available(hoveredId) || available(activeId) || queue[0]?.id;

  useLayoutEffect(() => {
    const next = focusNext.current;
    if (!next) return;
    if (!next.id && visible.length) return; // Finish the last exit before focusing the empty state.
    const card = Array.from(rail.current?.querySelectorAll<HTMLElement>("[data-post-id]") || [])
      .find(el => el.dataset.postId === next.id);
    const target = card?.querySelector<HTMLElement>(next.control ? `[data-triage="${next.control}"]` : "[data-expand]") || emptyLink.current;
    if (target) {
      focusNext.current = null;
      target.focus({ preventScroll: true });
      card?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
    }
  }, [expandedId, visible.length]);

  const later = posts.filter(p => p.status === "to-review").length;
  const triaged = posts.length - queue.length;
  const pct = posts.length ? Math.round((triaged / posts.length) * 100) : 100;

  const onExit = (post: SavedPost, status: PostStatus) => {
    const current = useLibrary.getState().posts.find(p => p.id === post.id);
    if (!current || current.status !== "inbox" || timers.current.has(post.id)) return;
    const ordered = useLibrary.getState().posts.filter(p => p.status === "inbox").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const index = ordered.findIndex(p => p.id === post.id);
    const next = ordered[index + 1] || ordered[index - 1];
    try { updatePost(post.id, { status }); } catch { /* Verify acceptance below before starting the exit. */ }
    if (useLibrary.getState().posts.find(p => p.id === post.id)?.status !== status) {
      setActionError("That change was not accepted. Your link is still here; try again.");
      return;
    }
    setActionError("");
    setLastExit({ post: current, from: current.status, to: status });
    setExiting(prev => ({ ...prev, [post.id]: { post: current, to: status } }));
    setActiveId(next?.id || null); setHoveredId(null); setFocusedId(null);
    focusNext.current = { id: next?.id, control: status };
    timers.current.set(post.id, setTimeout(() => {
      timers.current.delete(post.id);
      setExiting(prev => { const copy = { ...prev }; delete copy[post.id]; return copy; });
    }, reducedMotion ? 0 : 220));
  };

  const undo = () => {
    if (!lastExit) return;
    updatePost(lastExit.post.id, { status: lastExit.from });
    clearTimeout(timers.current.get(lastExit.post.id)); timers.current.delete(lastExit.post.id);
    setExiting(prev => { const copy = { ...prev }; delete copy[lastExit.post.id]; return copy; });
    setActiveId(lastExit.post.id); setHoveredId(null); setFocusedId(null);
    focusNext.current = { id: lastExit.post.id };
    setLastExit(null);
  };

  return (
    <div className="catchup-page mx-auto max-w-[1280px] p-6 pb-24">
      <header className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-[1.3rem] font-bold tracking-tight">Catch up</h1>
          <p className="mt-1 text-[.82rem] text-[var(--dim)]">
            {demo ? "Explore these sample links while the local library is unavailable."
              : posts.length === 0 ? "Your bookmarks and Telegram Saved Messages, together."
              : queue.length === 0 ? "No new links to review. Your saved library is still here."
              : `${queue.length} imported ${queue.length === 1 ? "link" : "links"} to review, newest first.`}
          </p>
        </div>
        <Link to="/library" className="btn shrink-0"><Bookmark size={13} /> Library</Link>
      </header>

      {demo && <div role="status" className="panel mt-4 p-3 text-[.82rem] text-[var(--amber)]">
        Sample library — these examples are not your imported content and are not saved to SQLite.
      </div>}

      {/* Progress is only interesting while there's a backlog. */}
      {posts.length > 0 && queue.length > 0 && (
        <div className="mt-4">
          <div className="h-1 w-full overflow-hidden rounded-full" style={{ background: "var(--surface2)" }}>
            <div
              className="h-full rounded-full"
              style={{
                width: `${pct}%`,
                background: "var(--accent)",
                transition: "width .22s var(--ease-out-quart)",
              }}
            />
          </div>
          <p className="mt-1.5 text-[.68rem] text-[var(--faint)]">
            {triaged} of {posts.length} sorted
            {later > 0 && <> · <Link to="/library?status=to-review" className="hover:text-[var(--text)]">{later} saved for later</Link></>}
          </p>
        </div>
      )}

      {actionError && <p role="alert" className="mt-3 text-[var(--amber)]">{actionError}</p>}
      {visible.length > 0 && <>
        <p id="catchup-help" className="mt-4 text-[.75rem] text-[var(--dim)]">Hover or focus a card to explore. Scroll across for more saved links.</p>
        <div ref={rail} className="catchup-rail" role="region" aria-label="Catch Up cards" aria-describedby="catchup-help"
          onPointerLeave={() => setHoveredId(null)}>
          {visible.map(p => <QueueItem key={p.id} post={p} expanded={p.id === expandedId} leaving={exiting[p.id]?.to}
            onExpand={() => setActiveId(p.id)} onHover={() => setHoveredId(p.id)}
            onFocus={() => { if (!exiting[p.id]) { setFocusedId(p.id); setActiveId(p.id); } }}
            onBlur={() => setFocusedId(id => id === p.id ? null : id)} onExit={onExit} />)}
        </div>
      </>}

      {visible.length === 0 && (
        <div className="panel mt-5 p-8 text-center">
          <Inbox size={26} className="mx-auto text-[var(--faint)]" />
          <h2 className="mt-3 text-[.95rem] font-semibold">{posts.length ? "All caught up" : "Your library is empty"}</h2>
          <p className="mx-auto mt-1.5 max-w-[46ch] text-[.8rem] text-[var(--dim)]">
            {posts.length ? `${posts.length} saved links are still in your library, with your categories, notes and favorites.`
              : "Import Firefox or Chromium bookmarks (HTML), or Telegram Saved Messages (JSON), to start your local library."}
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {later > 0 && (
              <button className="btn btn-primary" onClick={() => navigate("/library?status=to-review")}>
                <Clock size={13} /> Read {later} saved for later
              </button>
            )}
            <Link ref={emptyLink} to="/library" className="btn"><Bookmark size={13} /> Browse the library</Link>
            <Link to="/library/settings" className="btn"><Settings size={13} /> Import saved links</Link>
          </div>
        </div>
      )}

      {/* Undo sits above the queue's tail so it's reachable without scrolling back. */}
      {lastExit && (
        <div
          className="modal fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 px-4 py-2.5"
          role="status"
        >
          <span className="text-[.78rem] text-[var(--dim)]">
            {lastExit.to === "archived" ? "Archived" : lastExit.to === "to-review" ? "Saved for later" : "Kept"}
            {" — "}
            <span className="text-[var(--text)]">{displayTitle(lastExit.post.title, lastExit.post.url).slice(0, 42)}</span>
          </span>
          <button className="btn" style={{ padding: "3px 10px", fontSize: ".72rem" }} onClick={undo}>
            <RotateCcw size={12} /> Undo
          </button>
        </div>
      )}
    </div>
  );
}
