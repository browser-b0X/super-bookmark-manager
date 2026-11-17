import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import { useLibrary, type CreatorChange } from "../../store/library";
import { defaultChoices, handleLabel, mergeCreators, PLATFORM_LABEL, type Keep, type MergeChoices } from "../../lib/creators";

/**
 * "Same person": merge one creator into another, field by field. The kept creator's name stays and the other's
 * becomes another name; other names, handles and profile pages are joined; for the note, picture and about the
 * owner picks one. The merged creator's posts move over. Undo comes right after.
 */
export default function MergeCreatorsDialog({ intoId, fromId, onClose, onDone }:
  { intoId: string; fromId?: string; onClose(): void; onDone(change: CreatorChange, intoId: string): void }) {
  const creators = useLibrary(s => s.creators);
  const posts = useLibrary(s => s.posts);
  const dialog = useRef<HTMLDialogElement>(null);
  const [into, setInto] = useState(intoId);
  const [from, setFrom] = useState(fromId ?? creators.find(c => c.id !== intoId)?.id ?? "");
  useEffect(() => { dialog.current?.showModal(); }, []);
  const a = creators.find(c => c.id === into);
  const b = creators.find(c => c.id === from);
  const [choices, setChoices] = useState<MergeChoices | null>(null);
  const current = choices ?? (a && b ? defaultChoices(a, b) : null);
  useEffect(() => { setChoices(null); }, [into, from]);
  const after = useMemo(() => (a && b && current ? mergeCreators(a, b, current, "") : null), [a, b, current]);
  const moving = posts.filter(p => p.creatorId === from).length;
  const count = (id: string) => posts.filter(p => p.creatorId === id).length;
  const choose = (field: keyof MergeChoices, keep: Keep) => current && setChoices({ ...current, [field]: keep });
  const pick = (field: keyof MergeChoices) => current && (
    <span className="flex gap-1" role="radiogroup" aria-label={`${field}: which one`}>
      {(["this", "other"] as Keep[]).map(k => <button key={k} type="button" role="radio" aria-checked={current[field] === k}
        className={"btn smart-small" + (current[field] === k ? " btn-on" : "")} onClick={() => choose(field, k)}>{k === "this" ? a!.name : b!.name}</button>)}
    </span>
  );
  const text = (value?: string) => value?.trim() ? value : <i className="text-[var(--faint)]">none</i>;
  const merge = () => {
    if (!a || !b || !current) return;
    const change = useLibrary.getState().mergeCreator(b.id, a.id, current);
    onDone(change, a.id);
    dialog.current?.close();
  };

  return (
    <dialog ref={dialog} className="smart-dialog merge-dialog" aria-labelledby="merge-title" onClose={onClose}>
      <h2 id="merge-title" className="font-semibold">Merge creators</h2>
      <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[.78rem]">
        <select className="input" style={{ width: "auto" }} aria-label="Creator to merge" value={from} onChange={e => setFrom(e.target.value)}>
          {creators.filter(c => c.id !== into).map(c => <option key={c.id} value={c.id}>{c.name} ({count(c.id)})</option>)}
        </select>
        <span>into</span>
        <select className="input" style={{ width: "auto" }} aria-label="Creator to keep" value={into} onChange={e => setInto(e.target.value)}>
          {creators.filter(c => c.id !== from).map(c => <option key={c.id} value={c.id}>{c.name} ({count(c.id)})</option>)}
        </select>
        <button type="button" className="btn smart-small" onClick={() => { setInto(from); setFrom(into); }}><ArrowLeftRight size={11} /> Swap</button>
      </div>
      {a && b && after && current && <>
        <table className="merge-table" aria-label="What the merge keeps">
          <thead><tr><th /><th>{a.name}</th><th>After the merge</th><th /></tr></thead>
          <tbody>
            <tr><th>Name</th><td>{a.name}</td><td>{after.name} <span className="text-[var(--faint)]">(“{b.name}” becomes another name)</span></td><td /></tr>
            <tr><th>Other names</th><td>{a.aliases.join(", ") || text("")}</td><td>{after.aliases.map(n => <span key={n} className="chip">{n}</span>)}</td><td className="text-[var(--faint)]">both kept</td></tr>
            <tr><th>Handles</th><td>{a.handles.map(h => `${PLATFORM_LABEL[h.platform]} ${handleLabel(h)}`).join(", ") || text("")}</td>
              <td>{after.handles.map(h => <span key={`${h.platform}:${h.handle}`} className="chip">{PLATFORM_LABEL[h.platform]} {handleLabel(h)}</span>)}</td><td className="text-[var(--faint)]">both kept</td></tr>
            <tr><th>Note</th><td>{text(a.notes)}</td><td>{text(after.notes)}</td><td>{pick("notes")}</td></tr>
            <tr><th>About</th><td>{text(a.about)}</td><td>{text(after.about)}</td><td>{pick("about")}</td></tr>
            <tr><th>Picture</th><td>{a.picture ? "a picture" : text("")}</td><td>{after.picture ? `a picture (from ${current.picture === "this" ? a.name : b.name})` : text("")}</td><td>{pick("picture")}</td></tr>
          </tbody>
        </table>
        <p className="mt-2.5 text-[.74rem] text-[var(--dim)]" role="status"><b className="text-[var(--text)]">{moving} post{moving === 1 ? "" : "s"} move{moving === 1 ? "s" : ""} to {a.name}.</b> {b.name} goes; you can undo the merge right after.</p>
      </>}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button type="button" className="btn" onClick={() => dialog.current?.close()}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!a || !b} onClick={merge}>Merge</button>
      </div>
    </dialog>
  );
}
