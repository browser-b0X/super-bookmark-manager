import { useEffect, useMemo, useRef, useState } from "react";
import { GitMerge, Pencil, Plus, Search, X } from "lucide-react";
import { useLibrary, type TagMerge } from "../../store/library";
import { aliasProblem, cleanTagName, infoOf, parentProblem } from "../../lib/tags";

/** One tag, opened: its parents and other names, merge and rename. */
function TagEditor({ name, count, onMerged }: { name: string; count: number; onMerged(merge: TagMerge, text: string): void }) {
  const tagInfo = useLibrary(s => s.tagInfo);
  const allTags = useLibrary(s => s.allTags)();
  const info = infoOf(tagInfo, name);
  const [alias, setAlias] = useState("");
  const [parent, setParent] = useState("");
  const [into, setInto] = useState("");
  const [renameTo, setRenameTo] = useState("");
  const [problem, setProblem] = useState("");
  const others = [...new Set([...allTags, ...tagInfo.map(t => t.name)])].filter(t => t !== name).sort();
  const set = (change: { parents?: string[]; aliases?: string[] }) => { useLibrary.getState().setTagInfo(name, change); setProblem(""); };

  const addAlias = () => {
    const clean = cleanTagName(alias);
    const why = aliasProblem(tagInfo, allTags, name, clean);
    if (why) { setProblem(why); return; }
    set({ aliases: [...info.aliases, clean] });
    setAlias("");
  };
  const addParent = (value: string) => {
    const why = parentProblem(tagInfo, name, value);
    if (why) { setProblem(why); return; }
    set({ parents: [...info.parents, value] });
    setParent("");
  };
  const merge = (target: string, verb: string) => {
    const merge = useLibrary.getState().mergeTag(name, target);
    // The note lives in the dialog: this tag's row goes once no link carries it.
    onMerged(merge, `${verb} #${name} ${verb === "Renamed" ? "to" : "into"} #${target}: ${merge.links.length} link${merge.links.length === 1 ? "" : "s"} changed.`);
    setInto(""); setRenameTo("");
  };

  return (
    <div className="tag-editor">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="tag-editor__label">Under</span>
        {info.parents.map(p => <span key={p} className="chip smart-chip">#{p}
          <button type="button" aria-label={`Take #${name} out from under #${p}`} onClick={() => set({ parents: info.parents.filter(x => x !== p) })}><X size={10} /></button></span>)}
        <select className="input tag-editor__input" aria-label={`Put #${name} under another tag`} value={parent}
          onChange={e => { setParent(e.target.value); if (e.target.value) addParent(e.target.value); }}>
          <option value="">+ parent…</option>
          {others.filter(t => !info.parents.includes(t)).map(t => <option key={t} value={t}>#{t}</option>)}
        </select>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className="tag-editor__label">Other names</span>
        {info.aliases.map(a => <span key={a} className="chip smart-chip">{a}
          <button type="button" aria-label={`Remove the other name ${a}`} onClick={() => set({ aliases: info.aliases.filter(x => x !== a) })}><X size={10} /></button></span>)}
        <input className="input tag-editor__input" aria-label={`Another name for #${name}`} placeholder="+ name" value={alias}
          onChange={e => setAlias(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addAlias(); } }} />
        {alias && <button type="button" className="btn smart-small" onClick={addAlias}><Plus size={11} /> Add</button>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <select className="input tag-editor__input" aria-label={`Merge #${name} into`} value={into} onChange={e => setInto(e.target.value)}>
          <option value="">Merge into another tag…</option>
          {others.map(t => <option key={t} value={t}>#{t}</option>)}
        </select>
        <input className="input tag-editor__input" aria-label={`Rename #${name}`} placeholder="Rename to…" value={renameTo} onChange={e => setRenameTo(e.target.value)} />
        {renameTo && cleanTagName(renameTo) !== name && <button type="button" className="btn smart-small"
          onClick={() => merge(cleanTagName(renameTo), others.includes(cleanTagName(renameTo)) ? "Merged" : "Renamed")}><Pencil size={11} /> Rename</button>}
      </div>
      {into && <div className="tag-editor__confirm">
        <b>Merge #{name} into #{into}?</b> Its {count} link{count === 1 ? " gets" : "s get"} #{into}; “{name}” stays as another name, so searches for it
        still work. You can undo it right after.
        <span className="mt-1.5 flex gap-2"><button type="button" className="btn btn-primary smart-small" onClick={() => merge(into, "Merged")}><GitMerge size={11} /> Merge</button>
          <button type="button" className="btn smart-small" onClick={() => setInto("")}>Cancel</button></span>
      </div>}
      {problem && <p role="alert" className="mt-1.5 text-[.72rem] text-[var(--amber)]">{problem}</p>}
    </div>
  );
}

/** Settings for tags (v0.4.0): a tag can sit under several others and have other names; merging two keeps both names. */
export default function TagManager({ onClose }: { onClose(): void }) {
  const posts = useLibrary(s => s.posts);
  const tagInfo = useLibrary(s => s.tagInfo);
  const dialog = useRef<HTMLDialogElement>(null);
  const [find, setFind] = useState("");
  const [open, setOpen] = useState("");
  const [merged, setMerged] = useState<{ merge: TagMerge; text: string } | null>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const post of posts) for (const tag of post.tags) map.set(tag, (map.get(tag) ?? 0) + 1);
    return map;
  }, [posts]);
  const names = [...new Set([...counts.keys(), ...tagInfo.map(t => t.name)])].sort();
  const wanted = cleanTagName(find);
  const shown = names.filter(n => !wanted || n.includes(wanted) || infoOf(tagInfo, n).aliases.some(a => a.includes(wanted)));
  return (
    <dialog ref={dialog} className="smart-dialog" aria-labelledby="tags-title" onClose={onClose}>
      <div className="flex items-center justify-between gap-3">
        <h2 id="tags-title" className="font-semibold">Tags</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={() => dialog.current?.close()}><X size={14} /></button>
      </div>
      <p className="mt-1 text-[.74rem] text-[var(--dim)]">A tag can sit under several others and have other names. Searching a tag finds its other names and the tags under it.</p>
      {merged && <div className="tag-merged" role="status">
        <span>{merged.text} “{merged.merge.source}” stays as another name of #{merged.merge.target}.</span>
        <button type="button" className="btn smart-small" onClick={() => { useLibrary.getState().undoTagMerge(merged.merge); setMerged(null); }}>Undo</button>
        <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setMerged(null)}><X size={12} /></button>
      </div>}
      <label className="relative mt-3 block">
        <Search size={13} className="absolute top-1/2 left-3 -translate-y-1/2 text-[var(--faint)]" />
        <input className="input pl-8" aria-label="Find a tag" placeholder="Find a tag" value={find} onChange={e => setFind(e.target.value)} />
      </label>
      <ul className="mt-3 flex flex-col gap-2" aria-label="All tags">
        {shown.map(name => {
          const info = infoOf(tagInfo, name);
          return (
            <li key={name} className="tag-row" aria-label={`#${name}`}>
              <button type="button" className="tag-row__head" aria-expanded={open === name} onClick={() => setOpen(open === name ? "" : name)}>
                <b>#{name}</b>
                {info.aliases.length > 0 && <span className="text-[.72rem] text-[var(--faint)]">also: {info.aliases.join(", ")}</span>}
                {info.parents.length > 0 && <span className="text-[.72rem] text-[var(--dim)]">under {info.parents.map(p => `#${p}`).join(", ")}</span>}
                <span className="flex-1" />
                <span className="text-[.72rem] text-[var(--dim)]">{counts.get(name) ?? 0} link{counts.get(name) === 1 ? "" : "s"}</span>
              </button>
              {open === name && <TagEditor name={name} count={counts.get(name) ?? 0} onMerged={(merge, text) => { setMerged({ merge, text }); setOpen(merge.target); }} />}
            </li>
          );
        })}
        {!shown.length && <li className="text-[.76rem] text-[var(--dim)]">{names.length ? "No tag matches." : "No tags yet."}</li>}
      </ul>
    </dialog>
  );
}
