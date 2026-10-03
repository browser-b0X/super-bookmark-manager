import { useRef, useState } from "react";
import type { LibraryFilter, SavedView } from "../../types";
import { useLibrary } from "../../store/library";

export default function SavedViews({ criteria, onApply }: { criteria: LibraryFilter; onApply(view: SavedView): void }) {
  const views = useLibrary(s => s.views);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState<"update" | "delete" | null>(null);
  const choice = views.find(v => v.id === selected);
  const close = () => { dialog.current?.close(); trigger.current?.focus(); };
  const attempt = (action: () => void, success: string) => {
    try { action(); setMessage(success); setConfirm(null); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not save the preference. Check browser storage."); }
  };
  return <>
    <button ref={trigger} className="btn" onClick={() => { setMessage(""); setConfirm(null); dialog.current?.showModal(); }}>Saved Views</button>
    <dialog ref={dialog} aria-labelledby="saved-views-title" onClose={() => trigger.current?.focus()}
      className="m-auto max-h-[85vh] w-[min(480px,calc(100vw-24px))] overflow-y-auto rounded-xl border p-5 text-[var(--text)] backdrop:bg-black/50"
      style={{ background: "var(--surface-solid)", borderColor: "var(--border)" }}>
      <div className="flex items-center justify-between gap-3">
        <h2 id="saved-views-title" className="font-semibold">Saved Views</h2>
        <button className="btn" onClick={close}>Close</button>
      </div>
      <p className="mt-3 text-sm text-[var(--dim)]">Save the current search and active filter. Stored only in this browser profile for this site address, not in SQLite.</p>
      <label className="mt-4 block text-sm">View name
        <input ref={nameInput} className="input mt-1" value={name} maxLength={80} onChange={e => setName(e.target.value)} />
      </label>
      <button className="btn mt-2" onClick={() => attempt(() => {
        setSelected(useLibrary.getState().saveView(name, criteria));
      }, "View saved.")}>Save current</button>
      {views.length ? <>
        <label className="mt-4 block text-sm">Saved view
          <select aria-label="Saved view" className="input mt-1 w-full" value={selected} onChange={e => {
            setSelected(e.target.value); setName(views.find(v => v.id === e.target.value)?.name ?? ""); setConfirm(null); setMessage("");
          }}>
            <option value="">Choose a view</option>
            {views.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn btn-primary" disabled={!choice} onClick={() => { if (choice) { onApply(choice); close(); } }}>Apply view</button>
          <button className="btn" disabled={!choice} onClick={() => attempt(() => useLibrary.getState().renameView(selected, name), "View renamed.")}>Rename</button>
          <button className="btn" disabled={!choice} onClick={() => { setConfirm("update"); setMessage(""); }}>Update criteria</button>
          <button className="btn" disabled={!choice} onClick={() => { setConfirm("delete"); setMessage(""); }}>Delete view</button>
        </div>
      </> : <p className="mt-4 text-sm text-[var(--dim)]">No saved views yet. Set a search or filter, then save it here.</p>}
      {confirm && choice && <div className="mt-3 rounded border p-3" style={{ borderColor: "var(--border)" }}>
        <p className="text-sm break-words">{confirm === "update" ? `Replace criteria for “${choice.name}” with the current search and filter?` : `Delete “${choice.name}”? Library records will stay unchanged.`}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button className="btn" onClick={() => attempt(() => {
            if (confirm === "update") useLibrary.getState().updateView(selected, criteria);
            else { useLibrary.getState().deleteView(selected); setSelected(""); nameInput.current?.focus(); }
          }, confirm === "update" ? "View updated." : "View deleted.")}>Confirm {confirm}</button>
          <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
        </div>
      </div>}
      {message && <p role="status" className="mt-3 text-sm">{message}</p>}
    </dialog>
  </>;
}
