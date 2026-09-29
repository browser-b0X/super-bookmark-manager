import { useState, type CSSProperties } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowUpDown, Star } from "lucide-react";
import type { SavedPost } from "../../types";
import { PLATFORM_META, STATUS_META, relTime } from "../../lib/ui";
import { useLibrary } from "../../store/library";

function PlatformIcon({ post }: { post: SavedPost }) {
  const meta = PLATFORM_META[post.platform];
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

export function PostPreview({ post, compact = false, fill = false }: { post: SavedPost; compact?: boolean; fill?: boolean }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const [loadedUrl, setLoadedUrl] = useState<string>();
  const url = post.thumbnailUrl;
  const size = fill ? "h-full w-full" : compact ? "h-24 w-36" : "h-32 w-full";
  const isFavicon = !!url && /\/s2\/favicons|\/favicon(?:[./?#]|$)|\.ico(?:[?#]|$)/i.test(url);
  const loaded = (el: HTMLImageElement) => {
    if (el.naturalWidth < 128 || el.naturalHeight < 80) setFailedUrl(url);
    else setLoadedUrl(url);
  };

  if (url && failedUrl !== url && !isFavicon) {
    return (
      <div className={`cell-media shrink-0 rounded-md ${size}`} style={{ background: "var(--surface2)" }}>
        <img
          src={url}
          alt={`Preview of ${post.title || post.domain}`}
          loading="lazy"
          // A cached image can finish decoding before React attaches onLoad, which
          // would leave it stuck at opacity 0 — so check completeness on mount too.
          ref={el => { if (el?.complete && el.naturalWidth && loadedUrl !== url && failedUrl !== url) loaded(el); }}
          onLoad={e => loaded(e.currentTarget)}
          onError={() => setFailedUrl(url)}
          className={`h-full w-full rounded-md object-cover ${loadedUrl === url ? "is-loaded" : ""}`}
        />
      </div>
    );
  }
  return (
    <div
      className={`flex shrink-0 flex-col items-center justify-center gap-2 rounded-md ${size}`}
      style={{ background: "var(--surface2)" }}
      aria-label="No content preview available"
    >
      <PlatformIcon {...{ post }} />
      <span className="text-[.68rem] text-[var(--dim)]">No preview</span>
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
}

/* ── Grid cards ────────────────────────────────────────── */
export function PostGrid({ posts, selected, onToggle }: ViewProps) {
  const navigate = useNavigate();
  const categories = useLibrary(s => s.categories);

  return (
    <div className="cell-grid grid gap-3.5">
      {posts.map((p, i) => {
        const isSel = selected.has(p.id);
        const color = categories.find(c => p.categories.includes(c.name))?.color;
        const supplementary = [p.description, p.userNotes, p.aiSummary || p.excerpt]
          .filter((text, index, texts): text is string => !!text && texts.indexOf(text) === index);
        return (
          <article
            key={p.id}
            data-post-id={p.id}
            className={`panel cell cell-in group relative cursor-pointer overflow-hidden ${isSel ? "is-selected" : ""}`}
            style={{ "--cell-category": color, "--i": Math.min(i, 14) } as CSSProperties}
            onClick={() => navigate(`/library/item/${p.id}`)}
          >
            <input
              type="checkbox"
              aria-label="Select post"
              checked={isSel}
              onClick={e => e.stopPropagation()}
              onChange={() => onToggle(p.id)}
              className={`hover-tool absolute top-2 left-2 z-10 h-4 w-4 accent-[var(--accent)] ${isSel ? "is-on" : ""}`}
            />
            <FavButton post={p} className={`hover-tool absolute top-2 right-2 z-10 ${p.favorite ? "is-on" : ""}`} />
            <figure className="cell-plate">
              <div className="cell-image">
                <PostPreview post={p} fill />
              </div>
              {supplementary.length > 0 && (
                <div className="cell-overlay">
                  {supplementary.map(text => <p key={text} className="line-clamp-2">{text}</p>)}
                </div>
              )}
            </figure>
            <div className="cell-caption">
              <div className="mb-1.5 flex min-w-0 items-center gap-1.5">
                <PlatformIcon post={p} />
                {p.categories.filter(c => c !== "uncategorized").slice(0, 2).map(c => <span key={c} className="cell-cat truncate">{c}</span>)}
              </div>
              <Link to={`/library/item/${p.id}`} onClick={e => e.stopPropagation()} className="cell-title line-clamp-2 text-[.82rem] font-semibold" title={p.title || p.url}>
                {p.title || p.url}
              </Link>
              <div className="mt-1 truncate text-[.68rem] text-[var(--dim)]">{p.domain}</div>
              <div className="mt-0.5 text-[.64rem] text-[var(--faint)]">saved {relTime(p.createdAt)}</div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <StatusBadge post={p} />
                {p.tags.slice(0, 2).map(t => <span key={t} className="chip" style={{ color: "var(--violet)" }}>#{t}</span>)}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

/* ── Compact list ──────────────────────────────────────── */
export function PostList({ posts, selected, onToggle }: ViewProps) {
  const navigate = useNavigate();
  return (
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
              <div className="text-[.68rem] text-[var(--faint)]">{p.domain}</div>
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
  );
}

/* ── Table ─────────────────────────────────────────────── */
export function PostTable({ posts, selected, onToggle }: ViewProps) {
  const navigate = useNavigate();
  const [sort, setSort] = useState<{ key: keyof SavedPost; dir: 1 | -1 }>({ key: "createdAt", dir: -1 });

  const sorted = [...posts].sort((a, b) => {
    const av = String(a[sort.key] ?? ""), bv = String(b[sort.key] ?? "");
    return av.localeCompare(bv) * sort.dir;
  });

  const th = (label: string, key: keyof SavedPost) => (
    <th onClick={() => setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : -1 }))}>
      <span className="inline-flex items-center gap-1">{label}{sort.key === key && <ArrowUpDown size={10} />}</span>
    </th>
  );

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
          {sorted.map(p => (
            <tr key={p.id} className="cursor-pointer" onClick={() => navigate(`/library/item/${p.id}`)}>
              <td onClick={e => e.stopPropagation()}>
                <input type="checkbox" aria-label="Select post" checked={selected.has(p.id)} onChange={() => onToggle(p.id)} className="h-4 w-4 accent-[var(--accent)]" />
              </td>
              <td>
                <div className="flex items-center gap-2">
                  <PlatformIcon post={p} />
                  <Link to={`/library/item/${p.id}`} onClick={e => e.stopPropagation()} className="max-w-[360px] truncate font-medium">{p.title || p.url}</Link>
                  {p.favorite && <Star size={12} className="text-[var(--amber)]" fill="currentColor" />}
                </div>
              </td>
              <td className="text-[var(--dim)]">{PLATFORM_META[p.platform].label}</td>
              <td><StatusBadge post={p} /></td>
              <td className="text-[var(--dim)]">{p.categories.filter(c => c !== "uncategorized").join(", ") || "—"}</td>
              <td className="whitespace-nowrap text-[var(--faint)]">{relTime(p.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
