import { useEffect, useRef, useState } from "react";
import { useLibrary, type CreatorChange } from "../../store/library";
import { cleanName, nameOwner } from "../../lib/creators";

/** Move the selected posts to another creator, or to a new one (splitting a creator). Undo comes right after. */
export default function MoveToCreatorDialog({ fromId, postIds, onClose, onDone }:
  { fromId: string; postIds: string[]; onClose(): void; onDone(change: CreatorChange): void }) {
  const creators = useLibrary(s => s.creators);
  const dialog = useRef<HTMLDialogElement>(null);
  const others = creators.filter(c => c.id !== fromId);
  const [target, setTarget] = useState<"existing" | "new">(others.length ? "existing" : "new");
  const [existing, setExisting] = useState(others[0]?.id ?? "");
  const [name, setName] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);
  const clean = cleanName(name);
  const owner = target === "new" && clean ? nameOwner(creators, "", clean) : null;
  const ready = target === "existing" ? !!existing : !!clean && !owner;
  const move = () => {
    const change = useLibrary.getState().moveToCreator(postIds, target === "existing" ? { id: existing } : { name: clean });
    onDone(change);
    dialog.current?.close();
  };
  const n = postIds.length;
  return (
    <dialog ref={dialog} className="smart-dialog" style={{ width: "min(520px, calc(100vw - 24px))" }} aria-labelledby="move-title" onClose={onClose}>
      <h2 id="move-title" className="font-semibold">Move {n} post{n === 1 ? "" : "s"} to another creator</h2>
      {others.length > 0 && <label className="mt-3 flex flex-wrap items-center gap-2 text-[.78rem]">
        <input type="radio" name="move-target" checked={target === "existing"} onChange={() => setTarget("existing")} /> An existing creator
        <select className="input" style={{ width: "auto" }} aria-label="Existing creator" value={existing} onChange={e => { setExisting(e.target.value); setTarget("existing"); }}>
          {others.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>}
      <label className="mt-2 flex flex-wrap items-center gap-2 text-[.78rem]">
        <input type="radio" name="move-target" checked={target === "new"} onChange={() => setTarget("new")} /> A new creator
        <input className="input" style={{ width: 240 }} aria-label="New creator's name" value={name} onFocus={() => setTarget("new")} onChange={e => setName(e.target.value)} />
      </label>
      {owner && <p role="alert" className="mt-1.5 text-[.72rem] text-[var(--amber)]">“{clean}” is {owner.name === clean ? "the name" : "another name"} of {owner.name}: choose them above instead.</p>}
      <p className="mt-2.5 text-[.74rem] text-[var(--dim)]">A post's handle moves with it when no other post of this creator uses it. Undo right after.</p>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button type="button" className="btn" onClick={() => dialog.current?.close()}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!ready} onClick={move}>Move</button>
      </div>
    </dialog>
  );
}
