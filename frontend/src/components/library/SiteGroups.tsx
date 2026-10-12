import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, FolderInput } from "lucide-react";
import type { SavedPost } from "../../types";
import { useLibrary } from "../../store/library";
import { PostPreview, untitledName } from "./PostViews";
import { SiteIcon } from "./SiteLine";
import ShelfTrack from "../home/ShelfTrack";
import { displayText } from "../../lib/displayText";

const PLACEHOLDERS = new Set(["other", "uncategorized"]);

/** m.facebook.com and www.facebook.com are one site. */
export function siteKey(post: SavedPost): string {
  return (post.domain || "").toLowerCase().replace(/^(www|m|mobile)\./, "") || "unknown";
}

export interface SiteGroup { site: string; posts: SavedPost[] }

/** Sites with two or more links, biggest first; the rest together at the end. */
export function groupBySite(posts: SavedPost[]): { groups: SiteGroup[]; singles: SavedPost[] } {
  const bySite = new Map<string, SavedPost[]>();
  for (const post of posts) {
    const key = siteKey(post);
    const list = bySite.get(key);
    if (list) list.push(post); else bySite.set(key, [post]);
  }
  const groups: SiteGroup[] = [];
  const singles: SavedPost[] = [];
  for (const [site, list] of bySite) {
    if (list.length > 1) groups.push({ site, posts: list }); else singles.push(list[0]);
  }
  groups.sort((a, b) => b.posts.length - a.posts.length || a.site.localeCompare(b.site));
  return { groups, singles };
}

function ShelfPicker({ label, onPick, except }: { label: string; onPick: (shelf: string) => void; except?: string }) {
  const categories = useLibrary(s => s.categories);
  const shelves = categories.filter(c => !c.archived && !PLACEHOLDERS.has(c.name) && c.name !== except).sort((a, b) => a.order - b.order);
  return (
    <label className="site-group__move">
      <FolderInput size={13} aria-hidden="true" />
      <select className="input" defaultValue="" aria-label={label}
        onChange={e => { const value = e.target.value; e.target.value = ""; if (value) onPick(value); }}>
        <option value="" disabled>Move all to shelf…</option>
        {shelves.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
      </select>
    </label>
  );
}

/**
 * A shelf's links (or the unfiled ones) grouped by website, so a whole site can go onto a
 * shelf at once ("all 23 from github.com → technology"). Rows read like Home's shelf rows.
 * On a shelf (`fromShelf`), moving takes the links off that shelf; unfiled links are filed.
 */
export default function SiteGroups({ posts, shelfId, fromShelf, onMoved, onShowAll }: {
  posts: SavedPost[]; shelfId?: string; fromShelf?: string; onMoved: (message: string, undo: () => void) => void; onShowAll: () => void;
}) {
  const { groups, singles } = useMemo(() => groupBySite(posts), [posts]);

  const move = (list: SavedPost[], shelf: string, from: string) => {
    const before = list.map(p => ({ id: p.id, categories: p.categories, categoryMode: p.categoryMode, categoryReview: p.categoryReview }));
    const store = useLibrary.getState();
    const n = fromShelf ? store.moveToShelf(list.map(p => p.id), fromShelf, shelf) : store.addToShelf(list.map(p => p.id), shelf);
    const links = `${n} link${n === 1 ? "" : "s"}`;
    const what = fromShelf ? `${links} from ${from} off “${fromShelf}”` : `${links} from ${from}`;
    store.logActivity("organize", `Moved ${what} to “${shelf}”`);
    onMoved(fromShelf ? `Moved ${links} from ${from} off ${fromShelf} to ${shelf}.` : `Moved ${links} from ${from} to ${shelf}.`,
      () => useLibrary.getState().restoreCategories(before));
  };

  // A row shows its first 24 links; "See all" opens the rest (a search for the site, or the plain list).
  const row = (key: string, title: string, list: SavedPost[], icon: SavedPost | null, from: string, more?: string | (() => void)) => (
    <section key={key} className="shelf-row site-group" aria-labelledby={`site-${key}`}>
      <div className="shelf-row__head site-group__head">
        {icon && <SiteIcon post={icon} size={18} />}
        <h2 id={`site-${key}`}>{title}</h2><span>{list.length} link{list.length === 1 ? "" : "s"}</span>
        <span className="flex-1" />
        {typeof more === "string" && <Link to={more} className="shelf-row__more site-group__all">See all <ArrowRight size={13} /></Link>}
        {typeof more === "function" && <button className="shelf-row__more site-group__all" onClick={more}>See all <ArrowRight size={13} /></button>}
        <ShelfPicker label={`Move all ${list.length} links from ${title} to ${fromShelf ? "another" : "a"} shelf`} except={fromShelf}
          onPick={shelf => move(list, shelf, from)} />
      </div>
      <ShelfTrack label={fromShelf ? `${title}: links on ${fromShelf}` : `${title}: unfiled links`}>
        {list.slice(0, 24).map(post => (
          <Link key={post.id} to={`/library/item/${post.id}`} className="row-card" role="listitem">
            <span className="row-card__media"><PostPreview post={post} fill caption={false} /></span>
            <span className="row-card__title">{post.title ? displayText(post.title) : untitledName(post)}</span>
            <span className="row-card__site">{post.siteName || post.domain}</span>
          </Link>
        ))}
      </ShelfTrack>
    </section>
  );

  const shelfPath = shelfId ? `/library/category/${encodeURIComponent(shelfId)}` : "/library";
  return (
    <div className="site-groups">
      {groups.map(g => row(g.site, g.site, g.posts, g.posts.find(p => p.faviconUrl?.startsWith("/thumb/")) ?? null, g.site,
        g.posts.length > 24 ? `${shelfPath}?q=${encodeURIComponent(`site:${g.site}`)}` : undefined))}
      {singles.length > 0 && row("singles", "Sites with one link", singles, null, "sites with one link", singles.length > 24 ? onShowAll : undefined)}
    </div>
  );
}
