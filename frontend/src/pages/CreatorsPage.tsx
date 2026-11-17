import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ExternalLink, UserSearch, X } from "lucide-react";
import { useLibrary } from "../store/library";
import FindCreatorsDialog from "../components/creators/FindCreatorsDialog";
import { CreatorAvatar, HandleChips, postsOf, since } from "../components/creators/CreatorBits";

/**
 * Creators (v0.4.0): who made the posts you saved, built from the posts themselves; nothing is checked online and
 * nothing is followed. "New since you looked" counts posts that arrived by themselves since you last opened that
 * creator's page.
 */
export default function CreatorsPage() {
  const creators = useLibrary(s => s.creators);
  const posts = useLibrary(s => s.posts);
  const seen = useLibrary(s => s.creatorSeen);
  const [finding, setFinding] = useState(false);
  const [note, setNote] = useState("");
  const rows = useMemo(() => creators.map(c => ({ creator: c, ...postsOf(c, posts, seen?.[c.id]) }))
    .sort((a, b) => (b.last ?? "").localeCompare(a.last ?? "")), [creators, posts, seen]);
  return (
    <div className="creators-page">
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="page-title" style={{ margin: 0 }}>Creators</h1>
        <span className="chip">{creators.length}</span>
        <span className="flex-1" />
        <button className="btn btn-primary" onClick={() => setFinding(true)}><UserSearch size={13} /> Find creators in your saved posts</button>
      </div>
      <p className="page-sub">Made from the posts you saved: nothing is checked online. “New since you looked” counts posts that came in through imports,
        Telegram or the extension since you last opened that creator.</p>
      {note && <div className="site-moved" role="status"><span>{note}</span><button className="icon-btn" aria-label="Dismiss" onClick={() => setNote("")}><X size={13} /></button></div>}
      {!creators.length && <p className="mt-6 text-[.82rem] text-[var(--dim)]">No creators yet. “Find creators in your saved posts” makes them from the posts that say who made them
        (X, Instagram, TikTok, Reddit and YouTube).</p>}
      <div className="creator-cards" aria-label="Creators">
        {rows.map(({ creator, own, fresh, last }) => (
          <article key={creator.id} className="creator-card" aria-label={creator.name}>
            <CreatorAvatar creator={creator} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link to={`/creators/${encodeURIComponent(creator.id)}`} className="font-semibold">{creator.name}</Link>
                {fresh > 0 && <span className="chip creator-fresh">+{fresh} new since you looked</span>}
              </div>
              <div className="mt-1 flex flex-wrap gap-1"><HandleChips creator={creator} /></div>
              <div className="mt-1.5 text-[.74rem] text-[var(--dim)]">{own.length} saved{last ? ` · last ${since(last)}` : ""}
                {creator.urls[0] && <> · <a className="text-link inline-flex items-center gap-0.5" href={creator.urls[0]} target="_blank" rel="noopener noreferrer">Open profile <ExternalLink size={10} /></a></>}</div>
            </div>
          </article>
        ))}
      </div>
      {finding && <FindCreatorsDialog onClose={() => setFinding(false)} onDone={setNote} />}
    </div>
  );
}
