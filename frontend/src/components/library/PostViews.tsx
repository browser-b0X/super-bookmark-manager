import { useMemo, useState, type CSSProperties } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Archive, ArrowUpDown, ArrowUpRight, Clock, GripVertical, Star } from "lucide-react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { displayText, displayTitle } from "../../lib/displayText";
import type { SavedPost } from "../../types";
import { PLATFORM_META, STATUS_META, relTime } from "../../lib/ui";
import { useLibrary } from "../../store/library";
import CategoryPreview from "./CategoryPreview";
import { handleOf, platformOf, SOCIAL_PLATFORMS } from "./SocialCard";

/** A readable name for a saved social post that has no title yet. */
function untitledName(post: SavedPost): string {
  const platform = platformOf(post);
  if (!SOCIAL_PLATFORMS.has(platform)) return post.url;
  const handle = handleOf(post, platform);
  const label = PLATFORM_META[platform].label;
  return handle ? `${handle} on ${label}` : `${label} post`;
}
import SiteLine, { SiteIcon } from "./SiteLine";
import { useIncremental } from "../../lib/incremental";

function PlatformIcon({ post }: { post: SavedPost }) {
  const meta = PLATFORM_META[platformOf(post)] ?? PLATFORM_META.web;
  const Icon = meta.icon;
  return <Icon size={13} style={{ color: meta.color }} aria-label={meta.label} />;
}

function StatusBadge({ post }: { post: SavedPost }) {
  const meta = STATUS_META[post.status];
  return (
    <span className="chip inline-flex items-center gap-1.5" style={{ color: meta.color }}>
      <span className="dot" style={{ background: meta.color, width: 6, height: 6 }} />
      {meta.label}
    </span>
  );
}

export function PostPreview({ post, compact = false, fill = false, caption = true }: { post: SavedPost; compact?: boolean; fill?: boolean; caption?: boolean }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const [loadedUrl, setLoadedUrl] = useState<string>();
  const url = post.thumbnailUrl;
  const size = fill ? "h-full w-full" : compact ? "h-24 w-36" : "h-32 w-full";
  const isFavicon = !!url && /\/s2\/favicons|\/favicon(?:[./?#]|$)|\.ico(?:[?#]|$)/i.test(url);
  const loaded = (el: HTMLImageElement) => {
    if (el.naturalWidth < 128 || el.naturalHeight < 80) setFailedUrl(url);
    else setLoadedUrl(url);
  };

  const showImage = !!url && failedUrl !== url && !isFavicon;
  return (
    <div className={`cell-media preview-container shrink-0 rounded-md ${size}`}>
      {(!showImage || loadedUrl !== url) && <CategoryPreview post={post} caption={caption} />}
      {showImage && (
        <img
          src={url}
          alt={`Preview of ${post.title || post.domain}`}
          loading="lazy"
          // Cached images may finish before React attaches onLoad.
          ref={el => { if (el?.complete && el.naturalWidth && loadedUrl !== url && failedUrl !== url) loaded(el); }}
          onLoad={e => loaded(e.currentTarget)}
          onError={() => setFailedUrl(url)}
          className={`absolute inset-0 h-full w-full rounded-md object-cover ${loadedUrl === url ? "is-loaded" : ""}`}
        />
      )}
    </div>
  );
}

/**
 * Favouriting is instant and reversible, so it gets the one flourish in the
 * library: the star pops as it fills. The class is cleared on animationEnd so a
 * second click re-triggers it.
 */
function FavButton({ post, className = "" }: { post: SavedPost; className?: string }) {
  const updatePost = useLibrary(s => s.updatePost);
  const [popping, setPopping] = useState(false);
  const on = post.favorite;

  return (
    <button
      aria-label={on ? "Unfavorite" : "Favorite"}
      aria-pressed={!!on}
      title={on ? "Remove from favourites" : "Add to favourites"}
      onClick={e => {
        e.stopPropagation();
        if (!on) setPopping(true);
        updatePost(post.id, { favorite: !on });
      }}
      onAnimationEnd={() => setPopping(false)}
      className={`${className} ${popping ? "fav-pop" : ""} ${on ? "text-[var(--amber)]" : "text-[var(--faint)] hover:text-[var(--text)]"}`}
    >
      <Star size={14} fill={on ? "currentColor" : "none"} />
    </button>
  );
}

interface ViewProps {
  posts: SavedPost[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  /** Changes when the list itself changes (filter/search/sort), not on edits. */
  resetKey?: string;
}

/* ── Grid tiles ────────────────────────────────────────── */

/**
 * One saved link as a picture-first tile. The thumbnail is never covered:
 * details live in a pop-up cell that rises out of the tile on hover or
 * keyboard focus. With `sortable`, the grip in the corner drags the tile.
 */
function PostTile({ post: p, index, selected, onToggle, sortable }: {
  post: SavedPost; index: number; selected: boolean; onToggle: (id: string) => void; sortable: boolean;
}) {
  const navigate = useNavigate();
  const categories = useLibrary(s => s.categories);
  const updatePost = useLibrary(s => s.updatePost);
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: p.id, disabled: !sortable, transition: { duration: 360, easing: "cubic-bezier(.34,1.4,.64,1)" } });
  const color = categories.find(c => p.categories.includes(c.name))?.color;
  const summary = displayText(p.aiSummary || p.description || p.excerpt);
  const shelf = p.categories.find(c => c !== "uncategorized" && c !== "other");
  const style = {
    "--cell-category": color, "--i": Math.min(index, 14),
    transform: CSS.Translate.toString(transform), transition,
  } as CSSProperties;
  const setStatus = (status: SavedPost["status"]) => updatePost(p.id, { status });

  return (
    <article ref={setNodeRef} data-post-id={p.id} style={style}
      className={`tile cell-in ${selected ? "is-selected" : ""} ${isDragging ? "is-dragging" : ""}`}
      onClick={() => navigate(`/library/item/${p.id}`)}>
      <div className="tile__media">
        <PostPreview post={p} fill />
        <input type="checkbox" aria-label="Select post" checked={selected}
          onClick={e => e.stopPropagation()} onChange={() => onToggle(p.id)}
          className={`tile__select hover-tool ${selected ? "is-on" : ""}`} />
        <FavButton post={p} className={`tile__fav hover-tool ${p.favorite ? "is-on" : ""}`} />
        {sortable && <button ref={setActivatorNodeRef} {...attributes} {...listeners} type="button"
          className="tile__grip hover-tool" aria-label={`Move ${displayTitle(p.title, p.url)}`} title="Drag to reorder"
          onClick={e => e.stopPropagation()}>
          <GripVertical size={14} />
        </button>}
      </div>
      <div className="tile__caption">
        <PlatformIcon post={p} />
        <Link to={`/library/item/${p.id}`} onClick={e => e.stopPropagation()} className="tile__title cell-title" title={p.title || p.url}>
          {p.title ? displayText(p.title) : untitledName(p)}
        </Link>
      </div>
      <div className="tile__pop" onClick={e => e.stopPropagation()}>
        <SiteLine post={p} compact />
        {/* Drawn from an attribute: the title link below the picture is the one to read and click. */}
        <p className="tile__pop-title" aria-hidden="true" data-label={p.title ? displayText(p.title) : untitledName(p)} />
        {summary && <p className="tile__pop-text">{summary}</p>}
        <div className="tile__pop-meta">
          <StatusBadge post={p} />
          {shelf && <span className="chip" style={{ color: color ?? undefined }}>{shelf}</span>}
          {p.tags.slice(0, 3).map(t => <span key={t} className="chip" style={{ color: "var(--violet)" }}>#{t}</span>)}
          <span className="tile__pop-when">saved {relTime(p.createdAt)}</span>
        </div>
        <div className="tile__pop-actions">
          <a className="btn btn-primary" href={p.url} target="_blank" rel="noreferrer noopener"><ArrowUpRight size={13} /> Open</a>
          {p.status !== "to-review" && <button className="btn" onClick={() => setStatus("to-review")}><Clock size={13} /> Later</button>}
          {p.status !== "archived" && <button className="btn" onClick={() => setStatus("archived")}><Archive size={13} /> Archive</button>}
          <button className="btn" onClick={() => navigate(`/library/item/${p.id}`)}>Details</button>
        </div>
      </div>
    </article>
  );
}

export function PostGrid({ posts: all, selected, onToggle, resetKey = "", onReorder }: ViewProps & {
  /** Present when the list is in the owner's own order: tiles can be dragged. */
  onReorder?: (orderedIds: string[]) => void;
}) {
  const { shown: posts, sentinel } = useIncremental(all, resetKey);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = posts.map(p => p.id);
  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!onReorder || !over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id)), to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const visible = arrayMove(ids, from, to);
    // Tiles not rendered yet keep their place after the visible ones.
    onReorder([...visible, ...all.slice(posts.length).map(p => p.id)]);
  };

  return (
    <>
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={rectSortingStrategy}>
        <div className="tile-grid">
          {posts.map((p, i) => <PostTile key={p.id} post={p} index={i} selected={selected.has(p.id)} onToggle={onToggle} sortable={!!onReorder} />)}
        </div>
      </SortableContext>
    </DndContext>
    {sentinel}
    </>
  );
}

/* ── Compact list ──────────────────────────────────────── */
export function PostList({ posts: all, selected, onToggle, resetKey = "" }: ViewProps) {
  const navigate = useNavigate();
  const { shown: posts, sentinel } = useIncremental(all, resetKey, 200);
  return (
    <>
    <div className="panel overflow-hidden">
      {posts.map(p => {
        const isSel = selected.has(p.id);
        return (
          <div
            key={p.id}
            className={`row group flex cursor-pointer items-center gap-3 border-b px-3 py-2 last:border-b-0 ${isSel ? "bg-[var(--accent-bg)]" : ""}`}
            style={{ borderColor: "var(--border)" }}
            onClick={() => navigate(`/library/item/${p.id}`)}
          >
            <input
              type="checkbox"
              aria-label="Select post"
              checked={isSel}
              onClick={e => e.stopPropagation()}
              onChange={() => onToggle(p.id)}
              className="h-4 w-4 shrink-0 accent-[var(--accent)]"
            />
            <PlatformIcon post={p} />
            <div className="row-body min-w-0 flex-1">
              <Link to={`/library/item/${p.id}`} onClick={e => e.stopPropagation()} className="block truncate text-[.82rem] font-medium">{p.title || p.url}</Link>
              <SiteLine post={p} compact />
              {p.description && <div className="line-clamp-1 text-[.74rem] text-[var(--dim)]">{p.description}</div>}
            </div>
            {p.categories.filter(c => c !== "uncategorized").slice(0, 1).map(c => <span key={c} className="chip max-[900px]:hidden">{c}</span>)}
            <StatusBadge post={p} />
            <span className="w-10 text-right text-[.68rem] text-[var(--faint)]">{relTime(p.createdAt)}</span>
            <FavButton post={p} />
          </div>
        );
      })}
    </div>
    {sentinel}
    </>
  );
}

/* ── Table ─────────────────────────────────────────────── */
export function PostTable({ posts, selected, onToggle, resetKey = "" }: ViewProps) {
  const navigate = useNavigate();
  // No column chosen = the page's own sort order (including pinned first).
  const [sort, setSort] = useState<{ key: keyof SavedPost; dir: 1 | -1 } | null>(null);

  const sorted = useMemo(() => !sort ? posts : [...posts].sort((a, b) => {
    const av = String(a[sort.key] ?? ""), bv = String(b[sort.key] ?? "");
    return av.localeCompare(bv) * sort.dir;
  }), [posts, sort]);
  const { shown, sentinel } = useIncremental(sorted, resetKey + JSON.stringify(sort), 200);

  const th = (label: string, key: keyof SavedPost) => {
    const active = sort?.key === key;
    return (
      <th aria-sort={active ? (sort!.dir === 1 ? "ascending" : "descending") : "none"}>
        <button className="inline-flex items-center gap-1" onClick={() => setSort(s => ({ key, dir: s?.key === key ? (s.dir === 1 ? -1 : 1) : -1 }))}>
          {label}{active && <ArrowUpDown size={10} aria-hidden="true" />}
        </button>
      </th>
    );
  };

  return (
    <div className="panel overflow-x-auto">
      <table className="tbl w-full border-collapse">
        <thead>
          <tr>
            <th style={{ width: 32 }} aria-label="select" />
            {th("Title", "title")}
            {th("Platform", "platform")}
            {th("Status", "status")}
            {th("Categories", "categories" as keyof SavedPost)}
            {th("Saved", "createdAt")}
          </tr>
        </thead>
        <tbody>
          {shown.map(p => (
            <tr key={p.id} className="cursor-pointer" onClick={() => navigate(`/library/item/${p.id}`)}>
              <td onClick={e => e.stopPropagation()}>
                <input type="checkbox" aria-label="Select post" checked={selected.has(p.id)} onChange={() => onToggle(p.id)} className="h-4 w-4 accent-[var(--accent)]" />
              </td>
              <td>
                <div className="flex items-center gap-2">
                  {p.faviconUrl ? <SiteIcon post={p} /> : <PlatformIcon post={p} />}
                  <Link to={`/library/item/${p.id}`} onClick={e => e.stopPropagation()} className="max-w-[360px] truncate font-medium">{p.title || p.url}</Link>
                  {p.favorite && <Star size={12} className="text-[var(--amber)]" fill="currentColor" />}
                </div>
              </td>
              <td className="text-[var(--dim)]">{(PLATFORM_META[platformOf(p)] ?? PLATFORM_META.web).label}</td>
              <td><StatusBadge post={p} /></td>
              <td className="text-[var(--dim)]">{p.categories.filter(c => c !== "uncategorized").join(", ") || "—"}</td>
              <td className="whitespace-nowrap text-[var(--faint)]">{relTime(p.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sentinel}
    </div>
  );
}
