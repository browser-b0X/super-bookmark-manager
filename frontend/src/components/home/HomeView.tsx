import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUpRight, Check, Undo2 } from "lucide-react";
import type { SavedPost } from "../../types";
import { useLibrary } from "../../store/library";
import { usePrefs } from "../../store/prefs";
import { displayText } from "../../lib/displayText";
import { relTime, PLATFORM_META } from "../../lib/ui";
import { rediscover } from "../../lib/rediscover";
import { FOLLOW_UP_DONE, byFollowUp, isDue, useOftenRow } from "../../lib/followUp";
import { FollowUpBadge } from "../library/FollowUp";
import { PostPreview, untitledName } from "../library/PostViews";
import ShelfTrack from "./ShelfTrack";
import { useLibraryPersistence } from "../../lib/libraryPersistence";
import { handleOf, platformOf, SOCIAL_PLATFORMS } from "../library/SocialCard";

// An untitled social post reads "@someone on X", or "Facebook post" when there is no handle (not "Facebook on Facebook").
const name = (p: SavedPost) => p.title ? displayText(p.title) : untitledName(p);
const site = (p: SavedPost) => SOCIAL_PLATFORMS.has(platformOf(p)) ? PLATFORM_META[platformOf(p)].label : p.siteName || p.domain;
const FROM: Partial<Record<SavedPost["source"], string>> = {
  telegram: "from Telegram", whatsapp: "from WhatsApp", browser: "from your browser", import: "imported", manual: "added by you", api: "added by an app",
};
type Move = "archived" | "to-review" | "reference";
const MOVES: Record<Move, { label: string; key: string; log: string }> = {
  archived: { label: "Archive", key: "ArrowLeft", log: "Archived" },
  "to-review": { label: "Later", key: "ArrowDown", log: "Saved for later" },
  reference: { label: "Keep", key: "ArrowRight", log: "Kept" },
};

function savedAgo(iso: string) {
  const r = relTime(iso);
  return r === "now" ? "saved just now" : /^\d+[mhd]$/.test(r) ? `saved ${r} ago` : `saved ${r}`;
}

const typing = (target: EventTarget | null) => target instanceof HTMLElement
  && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** Home: new links one at a time, what comes next, an old favourite, and every shelf as a row. */
export default function HomeView() {
  const navigate = useNavigate();
  const posts = useLibrary(s => s.posts);
  const categories = useLibrary(s => s.categories);
  const layout = usePrefs(s => s.homeLayout);
  const queue = useMemo(() => posts.filter(p => p.status === "inbox").sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [posts]);
  const shelves = useMemo(() => categories.filter(c => !c.archived).sort((a, b) => a.order - b.order).map(shelf => ({
    shelf, items: posts.filter(p => p.categories.includes(shelf.name) && p.status !== "archived" && p.status !== "inbox")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  })).filter(row => row.items.length > 0), [posts, categories]);
  const throwback = useMemo(() => {
    const favourites = rediscover(posts, new Date(), 6).find(r => r.post.favorite) ?? rediscover(posts, new Date(), 1)[0];
    return favourites?.post;
  }, [posts]);
  const due = useMemo(() => posts.filter(p => isDue(p)).sort(byFollowUp), [posts]);
  const often = useMemo(() => useOftenRow(posts), [posts]);
  const persistence = useLibraryPersistence(state => state.status);
  const loading = persistence === "idle" || persistence === "syncing";

  if (posts.length === 0) {
    return (
      <div className="home home--portrait">
        <section className="deck deck--empty" aria-labelledby="deck-title">
          {/* Before SQLite has answered once, an empty list means "not loaded yet", not "empty". */}
          <div className="deck__head"><h2 id="deck-title">{loading ? "Loading your library…" : "Your library is empty"}</h2></div>
          {!loading && <div className="deck__done">
            <p>Import browser bookmarks or a Telegram export in Settings, use the bookmark button, or add a link with Add link above.</p>
            <button className="btn btn-primary" onClick={() => navigate("/library/settings")}>Import links</button>
          </div>}
        </section>
      </div>
    );
  }

  return (
    <div className={`home home--${layout}`}>
      {often.length > 0 && <QuickRow items={often} />}
      <div className="home__top">
        <SortDeck queue={queue} />
        <div className="home__side">
          {due.length > 0 && <FollowUpCard items={due.slice(0, 3)} total={due.length} />}
          {queue.length > 1 && <UpNext items={queue.slice(1, layout === "wide" ? 4 : 5)} total={queue.length} />}
          {throwback && <Throwback post={throwback} />}
        </div>
      </div>
      {shelves.map(({ shelf, items }) => (
        <section key={shelf.id} className="shelf-row" aria-labelledby={`row-${shelf.id}`}>
          <div className="shelf-row__head">
            <h2 id={`row-${shelf.id}`}>{shelf.name}</h2><span>{items.length} link{items.length === 1 ? "" : "s"}</span>
            <Link to={`/library/category/${shelf.id}`} className="shelf-row__more" aria-label={`See shelf ${shelf.name}`}>See shelf <ArrowRight size={14} /></Link>
          </div>
          <ShelfTrack label={`${shelf.name}: newest links`}>
            {items.slice(0, 12).map(post => (
              <Link key={post.id} to={`/library/item/${post.id}`} className="row-card" role="listitem">
                <span className="row-card__media"><PostPreview post={post} fill caption={false} /></span>
                <span className="row-card__title">{name(post)}</span>
                <span className="row-card__site">{site(post)}</span>
              </Link>
            ))}
          </ShelfTrack>
        </section>
      ))}
    </div>
  );
}

function SortDeck({ queue }: { queue: SavedPost[] }) {
  const navigate = useNavigate();
  const updatePost = useLibrary(s => s.updatePost);
  const logActivity = useLibrary(s => s.logActivity);
  const [sorted, setSorted] = useState(0);
  const [leaving, setLeaving] = useState<Move | null>(null);
  const history = useRef<{ id: string; from: SavedPost["status"] }[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const current = queue[0];
  const total = queue.length + sorted;

  const move = useCallback((to: Move) => {
    if (!current || leaving) return;
    setLeaving(to);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(() => {
      history.current.push({ id: current.id, from: current.status });
      updatePost(current.id, { status: to });
      logActivity("organize", MOVES[to].log, current.title);
      setSorted(n => n + 1);
      setCanUndo(true);
      setLeaving(null);
    }, reduce ? 0 : 230);
  }, [current, leaving, updatePost, logActivity]);

  const undo = useCallback(() => {
    const last = history.current.pop();
    if (!last) return;
    updatePost(last.id, { status: last.from });
    setSorted(n => Math.max(0, n - 1));
    setCanUndo(history.current.length > 0);
  }, [updatePost]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey || document.querySelector("dialog[open], [role=dialog]")) return;
      const to = (Object.keys(MOVES) as Move[]).find(m => MOVES[m].key === e.key);
      if (to && current) { e.preventDefault(); move(to); }
      else if (e.key === "Enter" && current && (e.target === document.body
        || ((e.target as HTMLElement).closest?.(".deck") && !(e.target as HTMLElement).closest?.("button, a, [role=button]")))) {
        e.preventDefault(); navigate(`/library/item/${current.id}`);
      } else if (e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, move, undo, navigate]);

  if (!current) {
    return (
      <section className="deck deck--empty" aria-labelledby="deck-title">
        <div className="deck__head"><h2 id="deck-title">New to sort</h2></div>
        <div className="deck__done">
          <Check size={28} aria-hidden="true" />
          <p><b>Nothing new to sort.</b> Links you save from Telegram, your browser or by hand wait here, one at a time.</p>
          {canUndo && <button className="btn" onClick={undo}><Undo2 size={13} /> Undo the last one (Z)</button>}
        </div>
      </section>
    );
  }

  return (
    <section className="deck" aria-labelledby="deck-title" aria-describedby="deck-keys">
      <div className="deck__head">
        <h2 id="deck-title">New to sort</h2>
        <span className="deck__count">{sorted + 1} of {total}{FROM[current.source] ? ` · ${FROM[current.source]}` : ""}</span>
      </div>
      <div className="deck__progress" role="progressbar" aria-label="Sorted" aria-valuemin={0} aria-valuemax={total} aria-valuenow={sorted}>
        <span style={{ width: `${total ? ((sorted + 1) / total) * 100 : 0}%` }} />
      </div>
      <div className="deck__stack">
        {queue.length > 1 && <span className="deck__layer deck__layer--2" aria-hidden="true" />}
        {queue.length > 2 && <span className="deck__layer deck__layer--3" aria-hidden="true" />}
        <article key={current.id} className={`deck__card${leaving ? ` is-leaving-${leaving}` : ""}`} data-post-id={current.id}
          onClick={() => navigate(`/library/item/${current.id}`)}>
          <div className="deck__media"><PostPreview post={current} fill caption={false} /></div>
          <div className="deck__body">
            <span className="deck__meta">{site(current)} · {savedAgo(current.createdAt)}</span>
            <Link to={`/library/item/${current.id}`} className="deck__title" onClick={e => e.stopPropagation()}>{name(current)}</Link>
            {current.description && <p className="deck__desc">{displayText(current.description)}</p>}
            {(current.categories.length > 0 || current.tags.length > 0) && <div className="deck__chips">
              {current.categories[0] && <><span className="deck__label">Suggested shelf</span><span className="chip chip--accent">{current.categories[0]}</span></>}
              {current.tags.slice(0, 3).map(t => <span key={t} className="chip">#{t}</span>)}
            </div>}
          </div>
        </article>
      </div>
      <div className="deck__actions">
        {(Object.keys(MOVES) as Move[]).map(m => {
          const Icon = m === "archived" ? ArrowLeft : m === "to-review" ? ArrowDown : ArrowRight;
          return (
            <button key={m} className={`deck__btn${m === "reference" ? " deck__btn--keep" : ""}`} onClick={() => move(m)}
              aria-keyshortcuts={MOVES[m].key} aria-label={`${MOVES[m].label}: ${name(current)}`}>
              {MOVES[m].label} <kbd aria-hidden="true"><Icon size={13} /></kbd>
            </button>
          );
        })}
      </div>
      <p id="deck-keys" className="deck__keys">
        ← Archive · ↓ Later · → Keep · Enter opens it · Z undoes{canUndo && <> · <button className="text-link" onClick={undo}>Undo</button></>}
      </p>
    </section>
  );
}

/** Use often: one click opens the link (and counts the open). */
function QuickRow({ items }: { items: SavedPost[] }) {
  const touchOpened = useLibrary(s => s.touchOpened);
  return (
    <nav className="quick-row" aria-label="Use often">
      <span className="quick-row__label">Use often</span>
      {items.map(post => (
        <a key={post.id} href={post.url} target="_blank" rel="noopener noreferrer" className="quick-row__item"
          onClick={() => touchOpened(post.id)} title={`${name(post)} — opens ${post.domain}`}>
          <span className="quick-row__thumb"><PostPreview post={post} fill caption={false} /></span>
          <span className="quick-row__name">{name(post)}</span>
          <ArrowUpRight size={12} aria-hidden="true" />
        </a>
      ))}
    </nav>
  );
}

function FollowUpCard({ items, total }: { items: SavedPost[]; total: number }) {
  const updatePost = useLibrary(s => s.updatePost);
  return (
    <section className="panel up-next follow-card" aria-labelledby="follow-title">
      <div className="up-next__head">
        <h2 id="follow-title">Follow up</h2>
        <Link to="/library?status=followup" className="text-link">See all follow-ups <ArrowRight size={13} className="inline" /></Link>
      </div>
      <ul className="up-next__list">
        {items.map(post => (
          <li key={post.id}>
            <Link to={`/library/item/${post.id}`} className="up-next__item">
              <span className="up-next__thumb"><PostPreview post={post} fill caption={false} /></span>
              <span className="min-w-0"><b>{name(post)}</b><small><FollowUpBadge post={post} className="due-badge--inline" /></small></span>
            </Link>
            <button className="up-next__keep" onClick={() => updatePost(post.id, FOLLOW_UP_DONE)} aria-label={`Done: ${name(post)}`} title="Done: move to Kept">
              <Check size={14} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function UpNext({ items, total }: { items: SavedPost[]; total: number }) {
  const updatePost = useLibrary(s => s.updatePost);
  return (
    <section className="panel up-next" aria-labelledby="up-next-title">
      <div className="up-next__head">
        <h2 id="up-next-title">Up next</h2>
        <Link to="/library/inbox" className="text-link">See all {total} <ArrowRight size={13} className="inline" /></Link>
      </div>
      <ul className="up-next__list">
        {items.map(post => (
          <li key={post.id}>
            <Link to={`/library/item/${post.id}`} className="up-next__item">
              <span className="up-next__thumb"><PostPreview post={post} fill caption={false} /></span>
              <span className="min-w-0"><b>{name(post)}</b><small>{site(post)} · {relTime(post.createdAt)}</small></span>
            </Link>
            <button className="up-next__keep" onClick={() => updatePost(post.id, { status: "reference" })} aria-label={`Keep ${name(post)}`} title="Keep">
              <Check size={14} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Throwback({ post }: { post: SavedPost }) {
  const saved = new Date(post.createdAt), now = new Date();
  const months = (now.getFullYear() - saved.getFullYear()) * 12 + now.getMonth() - saved.getMonth();
  const when = months >= 12 ? `From ${Math.floor(months / 12)} year${months >= 24 ? "s" : ""} ago` : months >= 1 ? `From ${months} month${months === 1 ? "" : "s"} ago` : "From your library";
  return (
    <section className="panel throwback" aria-labelledby="throwback-title">
      <span className="throwback__thumb"><PostPreview post={post} fill caption={false} /></span>
      <div className="min-w-0">
        <span className="throwback__when">{when}</span>
        <h2 id="throwback-title" className="throwback__title">{name(post)}</h2>
        <span className="throwback__sub">{[post.categories[0], post.favorite ? "a favourite" : ""].filter(Boolean).join(" · ")}</span>
      </div>
      <Link to={`/library/item/${post.id}`} className="btn throwback__btn">Read it again</Link>
    </section>
  );
}
