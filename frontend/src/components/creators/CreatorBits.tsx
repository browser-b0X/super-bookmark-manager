import type { Creator, SavedPost } from "../../types";
import { handleLabel, PLATFORM_LABEL } from "../../lib/creators";

/** A creator's picture, or their initials on a colour of their own. */
export function CreatorAvatar({ creator, size = 44 }: { creator: Creator; size?: number }) {
  const initials = creator.name.replace(/^u\//, "").split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join("") || "?";
  let hue = 0;
  for (const ch of creator.id) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  // Only a picture the app keeps itself (/thumb/…): showing a creator never contacts another site.
  if (creator.picture && /^\/thumb\/[A-Za-z0-9_-]+$/.test(creator.picture)) {
    return <img src={creator.picture} alt="" width={size} height={size} className="creator-avatar" referrerPolicy="no-referrer"
      onError={e => { e.currentTarget.style.visibility = "hidden"; }} />;
  }
  return <span className="creator-avatar" aria-hidden="true" style={{ width: size, height: size, fontSize: size * 0.36, background: `hsl(${hue} 50% 42%)` }}>{initials}</span>;
}

export function HandleChips({ creator }: { creator: Creator }) {
  return <>{creator.handles.map(h => <span key={`${h.platform}:${h.handle}`} className="chip creator-handle">{PLATFORM_LABEL[h.platform]} {handleLabel(h)}</span>)}</>;
}

/** "2 days ago", "3 weeks ago", "4 Oct" */
export function since(iso: string | undefined): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(at)) return "";
  const days = Math.floor((Date.now() - at) / 86400000);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: days > 300 ? "numeric" : undefined });
}

/** A creator's posts, newest first, and how many came in since the owner last looked. */
export function postsOf(creator: Creator, posts: SavedPost[], seenAt?: string) {
  const own = posts.filter(p => p.creatorId === creator.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const fresh = seenAt ? own.filter(p => p.createdAt > seenAt).length : 0;
  return { own, fresh, last: own[0]?.createdAt };
}
