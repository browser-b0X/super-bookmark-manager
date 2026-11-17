import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { useLibrary } from "../../store/library";
import type { PostStatus } from "../../types";
import { STATUS_META, STATUS_ORDER } from "../../lib/ui";
import { cleanTag, editPost, type BulkEdit, type EditMode, type EditRecord } from "../../lib/bulkEdit";

const MODES: [EditMode, string][] = [["add", "Add"], ["remove", "Remove"], ["replace", "Replace with"]];

function Modes({ label, mode, onChange }: { label: string; mode: EditMode; onChange(mode: EditMode): void }) {
  return (
    <span className="edit-modes" role="radiogroup" aria-label={`${label}: what to do`}>
      {MODES.map(([value, text]) => (
        <button key={value} type="button" role="radio" aria-checked={mode === value} className={mode === value ? "is-on" : ""}
          onClick={() => onChange(value)}>{text}</button>
      ))}
    </span>
  );
}

function Chips({ label, values, onRemove }: { label: string; values: string[]; onRemove(value: string): void }) {
  return <>{values.map(v => (
    <span key={v} className="chip smart-chip">{label === "Tags" ? `#${v}` : v}
      <button type="button" aria-label={`Remove ${v}`} onClick={() => onRemove(v)}><X size={10} /></button></span>
  ))}</>;
}

/**
 * Edit the selected links at once: tags and shelves added, removed or replaced, the status set. It says how many
 * links will change before anything does, and the change comes with Undo (links changed since are left alone).
 */
export default function BulkEditDialog({ ids, onClose, onDone }: { ids: string[]; onClose(): void; onDone(records: EditRecord[]): void }) {
  const posts = useLibrary(s => s.posts);
  const categories = useLibrary(s => s.categories);
  const allTags = useLibrary(s => s.allTags)();
  const dialog = useRef<HTMLDialogElement>(null);
  const [tagMode, setTagMode] = useState<EditMode>("add");
  const [tags, setTags] = useState<string[]>([]);
  const [typing, setTyping] = useState("");
  const [shelfMode, setShelfMode] = useState<EditMode>("add");
  const [shelves, setShelves] = useState<string[]>([]);
  const [status, setStatus] = useState<PostStatus | "">("");
  useEffect(() => { dialog.current?.showModal(); }, []);

  const addTag = (value: string) => {
    const tag = cleanTag(value);
    if (tag && !tags.includes(tag)) setTags([...tags, tag]);
    setTyping("");
  };
  // "Replace with" nothing empties the list; an empty "add" or "remove" changes nothing.
  const edit: BulkEdit = {
    ...(tags.length || tagMode === "replace" ? { tags: { mode: tagMode, values: tags } } : {}),
    ...(shelves.length || shelfMode === "replace" ? { shelves: { mode: shelfMode, values: shelves } } : {}),
    ...(status ? { status } : {}),
  };
  const chosen = useMemo(() => posts.filter(p => ids.includes(p.id)), [posts, ids]);
  const changing = chosen.filter(p => editPost(p, edit));
  const reviewed = changing.filter(p => p.reviewed).length;
  const apply = () => {
    const records = useLibrary.getState().bulkEdit(ids, edit);
    onDone(records);
    dialog.current?.close();
  };

  return (
    <dialog ref={dialog} className="smart-dialog" aria-labelledby="bulk-edit-title" onClose={onClose}>
      <h2 id="bulk-edit-title" className="font-semibold">Edit {ids.length} link{ids.length === 1 ? "" : "s"}</h2>

      <div className="mt-3">
        <div className="flex items-center gap-2 text-[.76rem]"><b>Tags</b><span className="flex-1" />
          <Modes label="Tags" mode={tagMode} onChange={setTagMode} /></div>
        <div className="input mt-1.5 flex min-h-[36px] flex-wrap items-center gap-1.5">
          <Chips label="Tags" values={tags} onRemove={v => setTags(tags.filter(t => t !== v))} />
          <input className="edit-type" aria-label="Tag to add to the list" list="bulk-edit-tags" value={typing} placeholder="type a tag, then Enter"
            onChange={e => { if (e.target.value.endsWith(",")) addTag(e.target.value.slice(0, -1)); else setTyping(e.target.value); }}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addTag(typing); } }} onBlur={() => typing && addTag(typing)} />
          <datalist id="bulk-edit-tags">{allTags.map(t => <option key={t} value={t} />)}</datalist>
        </div>
      </div>

      <div className="mt-3">
        <div className="flex items-center gap-2 text-[.76rem]"><b>Shelves</b><span className="flex-1" />
          <Modes label="Shelves" mode={shelfMode} onChange={setShelfMode} /></div>
        <div className="input mt-1.5 flex min-h-[36px] flex-wrap items-center gap-1.5">
          <Chips label="Shelves" values={shelves} onRemove={v => setShelves(shelves.filter(s => s !== v))} />
          <select className="edit-type" aria-label="Shelf to add to the list" value="" onChange={e => { if (e.target.value && !shelves.includes(e.target.value)) setShelves([...shelves, e.target.value]); }}>
            <option value="">choose a shelf…</option>
            {categories.filter(c => !c.archived && !shelves.includes(c.name)).map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
        </div>
      </div>

      <label className="mt-3 flex items-center gap-2 text-[.76rem]"><b>Status</b><span className="flex-1" />
        <select className="input" style={{ width: "auto", padding: "3px 8px" }} aria-label="Status" value={status} onChange={e => setStatus(e.target.value as PostStatus | "")}>
          <option value="">(leave as it is)</option>
          {STATUS_ORDER.map(s => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
        </select>
      </label>

      <p className="mt-3.5 text-[.74rem] text-[var(--dim)]" role="status">
        <b className="text-[var(--text)]">{changing.length} link{changing.length === 1 ? "" : "s"} will change.</b>
        {reviewed ? ` ${reviewed} ${reviewed === 1 ? "is" : "are"} marked Reviewed and change${reviewed === 1 ? "s" : ""} too, because you chose ${reviewed === 1 ? "it" : "them"}.` : ""}
      </p>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button type="button" className="btn" onClick={() => dialog.current?.close()}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!changing.length} onClick={apply}>
          Apply to {changing.length} link{changing.length === 1 ? "" : "s"}</button>
      </div>
    </dialog>
  );
}
