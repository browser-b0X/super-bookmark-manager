import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Pencil, Plus, Zap } from "lucide-react";
import { useLibrary } from "../store/library";
import { useLibraryCounts } from "../lib/libraryCounts";
import { PLATFORM_META, STATUS_META } from "../lib/ui";
import CategoryManager from "../components/library/CategoryManager";
import { isDue } from "../lib/followUp";
import { matchesQuery, parseQuery } from "../lib/librarySearch";
import SmartShelfEditor from "../components/library/SmartShelfEditor";
import TagManager from "../components/library/TagManager";
import { tagLookup } from "../lib/tags";
import type { SavedView } from "../types";

/**
 * All shelves: every shelf as a card, and beside it what the old sidebar held:
 * the lists, the platforms, saved views and tags.
 */
export default function AllShelvesPage() {
  const posts = useLibrary(s => s.posts);
  const categories = useLibrary(s => s.categories);
  const views = useLibrary(s => s.views);
  const allTags = useLibrary(s => s.allTags)();
  const counts = useLibraryCounts();
  const [managing, setManaging] = useState(false);
  const [tagging, setTagging] = useState(false);
  const tagInfo = useLibrary(s => s.tagInfo);
  const creatorCount = useLibrary(s => s.creators.length);
  // The smart shelf being made (null) or changed (a view); undefined while the editor is closed.
  const [smart, setSmart] = useState<SavedView | null | undefined>(undefined);
  const smartShelves = useMemo(() => {
    const tags = tagLookup(tagInfo);
    return views.filter(v => v.filter.smart).map(view => {
      // One odd shelf mustn't stop the page from opening: its count is left out instead.
      try {
        const parsed = parseQuery(view.filter.search ?? "");
        return { view, n: parsed.tree ? posts.filter(p => matchesQuery(p, parsed, tags)).length : 0 };
      } catch { return { view, n: 0 }; }
    });
  }, [views, posts, tagInfo]);
  const shelves = useMemo(() => categories.filter(c => !c.archived).sort((a, b) => a.order - b.order), [categories]);
  const pictures = useMemo(() => {
    const byShelf = new Map<string, string[]>();
    for (const post of posts) {
      if (!post.thumbnailUrl || post.status === "archived") continue;
      for (const name of post.categories) {
        const list = byShelf.get(name) ?? [];
        if (list.length < 2) { list.push(post.thumbnailUrl); byShelf.set(name, list); }
      }
    }
    return byShelf;
  }, [posts]);
  // The same rule as the Unfiled page lists, so the number matches what it shows.
  const unfiled = useMemo(() => posts.filter(p => p.categories.length === 0 || p.categories.every(c => c === "uncategorized")).length, [posts]);
  const followUp = useMemo(() => {
    const dated = posts.filter(p => p.followUpAt && p.status !== "archived");
    return { n: dated.length, due: dated.filter(p => isDue(p)).length };
  }, [posts]);
  const platforms = [...counts.platforms.entries()].filter(([key]) => key in PLATFORM_META).sort((a, b) => b[1] - a[1]);
  const lists: { to: string; label: string; n: number; color?: string; due?: number }[] = [
    { to: "/library?status=followup", label: "Follow up", n: followUp.n, due: followUp.due },
    { to: "/library?status=in-progress", label: "In progress", n: counts.status["in-progress"] || 0, color: STATUS_META["in-progress"].color },
    { to: "/library?status=reference", label: "Kept", n: counts.status.reference || 0, color: STATUS_META.reference.color },
    { to: "/library?status=archived", label: "Archived", n: counts.status.archived || 0 },
    { to: "/library?status=uncategorized", label: "Unfiled", n: unfiled },
    { to: "/library", label: "All saved", n: posts.length },
    { to: "/creators", label: "Creators", n: creatorCount },
  ];

  return (
    <div className="shelves-page">
      <section aria-labelledby="shelves-title">
        <h1 id="shelves-title" className="page-title">All shelves</h1>
        <p className="page-sub">{shelves.length} shelves · {posts.length} links. Click a shelf to see all of it.</p>
        <div className="shelf-cards">
          {shelves.map(shelf => {
            const pics = pictures.get(shelf.name) ?? [];
            return (
              <Link key={shelf.id} to={`/library/category/${shelf.id}`} className="shelf-card" aria-label={`${shelf.name} ${counts.categories.get(shelf.name) || 0} links`}>
                <span className="shelf-card__pics" style={{ ["--shelf" as string]: shelf.color }}>
                  {[0, 1].map(i => pics[i]
                    ? <img key={i} src={pics[i]} alt="" loading="lazy" onError={e => { e.currentTarget.style.visibility = "hidden"; }} />
                    : <i key={i} />)}
                </span>
                <span className="shelf-card__body">
                  <span className="dot" style={{ background: shelf.color }} />
                  <b>{shelf.name}</b>
                  <span className="shelf-card__n">{counts.categories.get(shelf.name) || 0}</span>
                </span>
              </Link>
            );
          })}
        </div>
        <p className="mt-4 flex flex-wrap items-center gap-3">
          <button className="btn" onClick={() => setManaging(true)}><Plus size={13} /> New shelf</button>
          <button className="text-link" onClick={() => setManaging(true)}>Rename, recolour, reorder or archive shelves…</button>
        </p>
      </section>

      <aside className="shelves-side" aria-label="Lists, platforms and saved views">
        <h2>Lists</h2>
        <nav className="side-list">
          {lists.map(l => (
            <Link key={l.label} to={l.to} aria-label={`${l.label} ${l.due ? `${l.due} due` : l.n}`}>
              <span className="flex items-center gap-2">{l.color && <span className="dot" style={{ background: l.color }} />}{l.label}</span>
              {l.due ? <span className="due-count">{l.due} due</span> : <span>{l.n}</span>}
            </Link>
          ))}
        </nav>
        {platforms.length > 0 && <>
          <h2>By platform</h2>
          <div className="side-chips">
            {platforms.map(([key, n]) => {
              const meta = PLATFORM_META[key as keyof typeof PLATFORM_META];
              return <Link key={key} className="chip" to={`/library?platform=${key}`}>{meta.label} {n}</Link>;
            })}
          </div>
        </>}
        <h2>Smart shelves</h2>
        <nav className="side-list" aria-label="Smart shelves">
          {smartShelves.map(({ view, n }) => (
            <span key={view.id} className="smart-row">
              <Link to={`/library?view=${view.id}`} aria-label={`${view.name} ${n}`}><span className="flex items-center gap-1.5"><Zap size={12} aria-hidden="true" />{view.name}</span><span>{n}</span></Link>
              <button type="button" className="icon-btn" aria-label={`Edit the rules of ${view.name}`} onClick={() => setSmart(view)}><Pencil size={12} /></button>
            </span>
          ))}
          <button type="button" className="smart-new" onClick={() => setSmart(null)}><Plus size={12} /> New smart shelf</button>
        </nav>
        {views.some(v => !v.filter.smart) && <>
          <h2>Saved views</h2>
          <nav className="side-list">
            {views.filter(v => !v.filter.smart).map(v => <Link key={v.id} to={`/library?view=${v.id}`}><span>{v.name}</span><span aria-hidden="true">›</span></Link>)}
          </nav>
        </>}
        {allTags.length > 0 && <>
          <h2>Tags</h2>
          <div className="side-chips">
            {allTags.slice(0, 40).map(t => <Link key={t} className="chip" to={`/library/tag/${encodeURIComponent(t)}`}>#{t}</Link>)}
          </div>
          <button type="button" className="smart-new -mt-3 mb-4" onClick={() => setTagging(true)}><Pencil size={12} /> Manage tags…</button>
        </>}
      </aside>
      {managing && <CategoryManager onClose={() => setManaging(false)} />}
      {smart !== undefined && <SmartShelfEditor view={smart ?? undefined} onClose={() => setSmart(undefined)} />}
      {tagging && <TagManager onClose={() => setTagging(false)} />}
    </div>
  );
}
