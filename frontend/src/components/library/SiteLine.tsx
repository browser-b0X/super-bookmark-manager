import { useState } from "react";
import type { SavedPost } from "../../types";

/** Short publication date: "4 Mar 2026", or "4 Mar" this year. */
function shortDate(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

/** Locally cached site icon; falls back to nothing rather than a broken image. */
export function SiteIcon({ post, size = 14 }: { post: SavedPost; size?: number }) {
  const [failed, setFailed] = useState<string>();
  const url = post.faviconUrl;
  if (!url || failed === url || !url.startsWith("/thumb/")) return null;
  return <img src={url} alt="" width={size} height={size} loading="lazy" className="site-icon shrink-0 rounded-[3px]"
    onError={() => setFailed(url)} />;
}

/**
 * "favicon The Site · Ada Writer · 6 min read · 4 Mar" — what a feed shows
 * under a headline, so a link is recognisable without opening it.
 */
export default function SiteLine({ post, className = "", compact = false }: { post: SavedPost; className?: string; compact?: boolean }) {
  const parts = [
    post.siteName || post.domain,
    !compact && post.author && post.author !== post.siteName ? post.author : "",
    post.readingMinutes ? `${post.readingMinutes} min read` : "",
    !compact ? shortDate(post.publishedAt) : "",
  ].filter(Boolean);
  return (
    <div className={`site-line flex min-w-0 items-center gap-1.5 text-[.7rem] text-[var(--dim)] ${className}`}>
      <SiteIcon post={post} />
      <span className="truncate">{parts.join(" · ")}</span>
      {post.linkStatus === "gone" && <span className="chip shrink-0" style={{ color: "var(--amber)" }} title="The page no longer exists at this address">gone</span>}
    </div>
  );
}
