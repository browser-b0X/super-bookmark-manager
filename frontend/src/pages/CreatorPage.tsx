import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Check, ChevronDown, ExternalLink, GitMerge, Lock, MoveRight, Plus, RefreshCw, X } from "lucide-react";
import { useLibrary, type CreatorChange } from "../store/library";
import type { Creator } from "../types";
import { PostGrid } from "../components/library/PostViews";
import MergeCreatorsDialog from "../components/creators/MergeCreatorsDialog";
import MoveToCreatorDialog from "../components/creators/MoveToCreatorDialog";
import RefreshCreatorDialog from "../components/creators/RefreshCreatorDialog";
import { CreatorAvatar, HandleChips, postsOf, since } from "../components/creators/CreatorBits";
import { cleanName, LIMITS, nameOwner } from "../lib/creators";

/** The name menu: the main name, other names (make one the main name, or take it off), and "+ Add a name". */
function NameMenu({ creator, onConflict, onUndoable }: { creator: Creator; onConflict(other: Creator): void; onUndoable(text: string, undo: () => void): void }) {
  const creators = useLibrary(s => s.creators);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState("");
  const [clash, setClash] = useState<Creator | null>(null);
  const update = (patch: Partial<Creator>, text: string) => {
    const before = { name: creator.name, aliases: creator.aliases };
    const at = useLibrary.getState().updateCreator(creator.id, patch);
    onUndoable(text, () => { useLibrary.getState().revertCreator(creator.id, at, before); });
  };
  const add = () => {
    const name = cleanName(adding);
    if (!name || name === creator.name || creator.aliases.includes(name) || creator.aliases.length >= LIMITS.aliases) { setAdding(""); return; }
    const other = nameOwner(creators, creator.id, name);
    if (other) { setClash(other); return; }
    update({ aliases: [...creator.aliases, name] }, `Added the name “${name}”.`);
    setAdding("");
  };
  return (
    <div className="relative">
      <button type="button" className="creator-name" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(!open)}>
        <h1 className="page-title" style={{ margin: 0 }}>{creator.name}</h1><ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && <div className="creator-menu" role="menu" aria-label={`Names of ${creator.name}`}>
        <div className="creator-menu__row"><Check size={13} /> <b>{creator.name}</b> <span className="text-[var(--faint)]">main name</span></div>
        {creator.aliases.map(alias => <div key={alias} className="creator-menu__row">
          <span className="flex-1">{alias}</span>
          <button type="button" className="smart-link" onClick={() => update({ name: alias, aliases: [creator.name, ...creator.aliases.filter(a => a !== alias)] },
            `“${alias}” is the main name now; “${creator.name}” stays as another name.`)}>make main</button>
          <button type="button" className="icon-btn" aria-label={`Take off the name ${alias}`}
            onClick={() => update({ aliases: creator.aliases.filter(a => a !== alias) }, `Took off the name “${alias}”.`)}><X size={11} /></button>
        </div>)}
        <div className="creator-menu__row">
          <input className="input" style={{ padding: "3px 8px", fontSize: ".76rem" }} aria-label={`Another name for ${creator.name}`} placeholder="+ Add a name…" value={adding}
            onChange={e => { setAdding(e.target.value); setClash(null); }} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
          {adding && <button type="button" className="btn smart-small" onClick={add}><Plus size={11} /> Add</button>}
        </div>
        {clash && <div className="creator-menu__clash" role="alert">
          “{adding.trim()}” is {clash.name.toLowerCase() === adding.trim().toLowerCase() ? "the name" : "another name"} of another creator, <b>{clash.name}</b>. Same person?
          <span className="mt-1.5 flex gap-2"><button type="button" className="btn btn-primary smart-small" onClick={() => { setOpen(false); onConflict(clash); }}>Merge them…</button>
            <button type="button" className="btn smart-small" onClick={() => { setClash(null); setAdding(""); }}>Not the same: cancel</button></span>
        </div>}
      </div>}
    </div>
  );
}

/** One creator: names, handles and profile pages, a note, merge and move, and their posts. */
export default function CreatorPage() {
  const { creatorId = "" } = useParams();
  const navigate = useNavigate();
  const creators = useLibrary(s => s.creators);
  const posts = useLibrary(s => s.posts);
  const creator = creators.find(c => c.id === creatorId);
  const seenAt = useLibrary(s => s.creatorSeen?.[creatorId]);
  const { own, fresh, last } = useMemo(() => (creator ? postsOf(creator, posts, seenAt) : { own: [], fresh: 0, last: undefined }), [creator, posts, seenAt]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [merging, setMerging] = useState<string | null>(null);     // the other creator, "" to choose
  const [moving, setMoving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [undo, setUndo] = useState<{ text: string; run: () => void } | null>(null);
  // "New since you looked": said once on arrival, then this visit counts as looking.
  const arrivedFresh = useRef<number | null>(null);
  if (creator && arrivedFresh.current === null) arrivedFresh.current = fresh;
  useEffect(() => {
    if (!creatorId) return;
    const timer = window.setTimeout(() => {
      if (useLibrary.getState().creators.some(c => c.id === creatorId)) useLibrary.getState().seeCreator(creatorId);
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [creatorId]);
  useEffect(() => { setSelected(new Set()); arrivedFresh.current = null; }, [creatorId]);

  if (!creator) return (
    <div className="creators-page"><p className="text-[.82rem]">This creator isn't in your library (merged or gone). <Link className="text-link" to="/creators">All creators</Link></p>
      {undo && <div className="site-moved" role="status"><span>{undo.text}</span><button className="btn" onClick={() => { undo.run(); setUndo(null); }}>Undo</button></div>}
    </div>);

  const changed = (change: CreatorChange, text: string) => setUndo({ text, run: () => { useLibrary.getState().undoCreatorChange(change); } });
  const toggle = (id: string) => setSelected(s => { const next = new Set(s); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return (
    <div className="creators-page">
      <p className="text-[.74rem]"><Link className="text-link" to="/creators">← Creators</Link></p>
      <div className="creator-hero">
        <CreatorAvatar creator={creator} size={72} />
        <div className="min-w-0 flex-1">
          <NameMenu creator={creator} onConflict={other => setMerging(other.id)} onUndoable={(text, run) => setUndo({ text, run })} />
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5"><HandleChips creator={creator} />
            {creator.urls.map(url => <a key={url} className="text-link inline-flex items-center gap-0.5 text-[.74rem]" href={url} target="_blank" rel="noopener noreferrer">
              Open {new URL(url).hostname.replace(/^www\./, "")} <ExternalLink size={10} /></a>)}
          </div>
          <div className="mt-1.5 text-[.74rem] text-[var(--dim)]">{own.length} saved{last ? ` · last ${since(last)}` : ""}
            {arrivedFresh.current ? <> · <b className="text-[var(--accent)]">{arrivedFresh.current} new since you last looked</b></> : null}</div>
          {creator.about && <p className="mt-1.5 text-[.76rem]">{creator.about}</p>}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn" onClick={() => setMerging("")} disabled={creators.length < 2}><GitMerge size={13} /> Merge with…</button>
        <button className="btn" onClick={() => setRefreshing(true)} disabled={!creator.urls.length || !!creator.reviewed}
          title={creator.reviewed ? "Reviewed: a refresh leaves it alone" : creator.urls.length ? "Read the profile page once and choose what to take" : "No profile page to read"}>
          <RefreshCw size={13} /> Refresh from the profile page</button>
        <label className="flex items-center gap-2 text-[.76rem]">
          <button type="button" role="switch" aria-checked={!!creator.reviewed} aria-label="Reviewed" className="switch"
            onClick={() => useLibrary.getState().updateCreator(creator.id, { reviewed: !creator.reviewed })} />
          Reviewed <Lock size={11} className="text-[var(--dim)]" aria-hidden="true" /><span className="text-[var(--faint)]">a refresh from the profile page leaves it alone</span>
        </label>
      </div>
      <label className="mt-3 block text-[.74rem] text-[var(--dim)]">Note
        <textarea className="input mt-1" rows={2} defaultValue={creator.notes ?? ""} key={creator.id + (creator.notes ?? "")}
          onBlur={e => { if (e.target.value !== (creator.notes ?? "")) useLibrary.getState().updateCreator(creator.id, { notes: e.target.value.slice(0, 2000) }); }} />
      </label>
      {undo && <div className="site-moved mt-3" role="status"><span>{undo.text}</span>
        <button className="btn" onClick={() => { undo.run(); setUndo(null); }}>Undo</button>
        <button className="icon-btn" aria-label="Dismiss" onClick={() => setUndo(null)}><X size={13} /></button></div>}
      <div className="mt-4 mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-[.9rem] font-semibold">Posts</h2><span className="chip">{own.length}</span>
        {selected.size > 0 && <button className="btn" onClick={() => setMoving(true)}><MoveRight size={13} /> Move {selected.size} to another creator…</button>}
      </div>
      <PostGrid posts={own} selected={selected} onToggle={toggle} resetKey={creator.id} />
      {merging !== null && <MergeCreatorsDialog intoId={creator.id} fromId={merging || undefined} onClose={() => setMerging(null)}
        onDone={(change, intoId) => { changed(change, "Merged."); navigate(`/creators/${encodeURIComponent(intoId)}`); }} />}
      {refreshing && <RefreshCreatorDialog creator={creator} onClose={() => setRefreshing(false)} onDone={(text, run) => setUndo({ text, run })} />}
      {moving && <MoveToCreatorDialog fromId={creator.id} postIds={[...selected]} onClose={() => setMoving(false)}
        onDone={change => { changed(change, `Moved ${change.links.length} post${change.links.length === 1 ? "" : "s"}.`); setSelected(new Set()); }} />}
    </div>
  );
}
