import { useMemo, useState, type CSSProperties } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Archive, Check, Clock, Inbox, Pause, Play } from "lucide-react";
import { useLibrary } from "../../store/library";
import type { SavedPost } from "../../types";
import { displayText } from "../../lib/displayText";
import { relTime } from "../../lib/ui";
import { PostPreview } from "./PostViews";
import { handleOf, platformOf, SOCIAL_PLATFORMS } from "./SocialCard";
import { PLATFORM_META } from "../../lib/ui";

const name = (p: SavedPost) => p.title ? displayText(p.title)
  : SOCIAL_PLATFORMS.has(platformOf(p)) ? `${handleOf(p) || PLATFORM_META[platformOf(p)].label} on ${PLATFORM_META[platformOf(p)].label}` : p.url;

function RailCard({ post, copy }: { post: SavedPost; copy?: boolean }) {
  const navigate = useNavigate();
  const updatePost = useLibrary(s => s.updatePost);
  const logActivity = useLibrary(s => s.logActivity);
  const triage = (status: SavedPost["status"], label: string) => {
    updatePost(post.id, { status });
    logActivity("organize", label, post.title);
  };
  return (
    // The duplicate half of the loop is decoration: hidden from assistive tech and the tab order.
    <article className="rail-card" data-rail-id={post.id} aria-hidden={copy || undefined}
      {...(copy ? { inert: "" } as Record<string, string> : {})}
      onClick={() => navigate(`/library/item/${post.id}`)}>
      <div className="rail-card__media"><PostPreview post={post} fill /></div>
      <div className="rail-card__body">
        <Link to={`/library/item/${post.id}`} className="rail-card__title" onClick={e => e.stopPropagation()}>{name(post)}</Link>
        <span className="rail-card__when">{post.siteName || post.domain} · {relTime(post.createdAt)}</span>
      </div>
      <div className="rail-card__actions" onClick={e => e.stopPropagation()}>
        <button className="rail-btn" onClick={() => triage("reference", "Kept")} aria-label={`Keep ${name(post)}`} title="Keep in the library"><Check size={14} /></button>
        <button className="rail-btn" onClick={() => triage("to-review", "Saved for later")} aria-label={`Later: ${name(post)}`} title="Save for later"><Clock size={14} /></button>
        <button className="rail-btn" onClick={() => triage("archived", "Archived")} aria-label={`Archive ${name(post)}`} title="Archive"><Archive size={14} /></button>
      </div>
    </article>
  );
}

/**
 * New, unsorted links drift across the top of the feed in an endless loop.
 * Hovering or focusing the strip stops it; each card can be kept, saved for
 * later or archived in place. Reduced-motion users get a plain scroll row.
 */
export default function CatchUpRail({ posts }: { posts: SavedPost[] }) {
  const [paused, setPaused] = useState(false);
  const queue = useMemo(() => [...posts].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 40), [posts]);
  if (!queue.length) return null;
  const loop = queue.length >= 4;
  const style = { "--rail-duration": `${Math.max(30, queue.length * 7)}s` } as CSSProperties;

  return (
    <section className="rail" aria-labelledby="rail-heading">
      <div className="rail__head">
        <h2 id="rail-heading" className="rail__heading"><Inbox size={16} /> New to sort <span className="chip">{posts.length}</span></h2>
        <span className="rail__hint">Keep, save for later or archive — or open one to read it.</span>
        <span className="flex-1" />
        {loop && <button className="btn" onClick={() => setPaused(p => !p)} aria-pressed={paused}>
          {paused ? <><Play size={13} /> Resume</> : <><Pause size={13} /> Pause</>}
        </button>}
        <Link to="/library/inbox" className="btn btn-primary">See all {posts.length}</Link>
      </div>
      <div className={`rail__viewport ${loop ? "is-loop" : ""} ${paused ? "is-paused" : ""}`} style={style}>
        <div className="rail__track">
          {queue.map(p => <RailCard key={p.id} post={p} />)}
          {loop && queue.map(p => <RailCard key={`copy-${p.id}`} post={p} copy />)}
        </div>
      </div>
    </section>
  );
}
