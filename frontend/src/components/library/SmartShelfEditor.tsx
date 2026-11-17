import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, X, Zap } from "lucide-react";
import { useLibrary } from "../../store/library";
import type { SavedView } from "../../types";
import { describeQuery, matchesQuery, parseQuery, type QueryNode } from "../../lib/librarySearch";
import { tagLookup } from "../../lib/tags";
import {
  CONDITION_KINDS, EMPTY_CHOICES, SAVED_CHOICES, STATUS_CHOICES, condition, groupsOf, searchOf,
  type ConditionKind, type GroupMode, type RuleGroup,
} from "../../lib/smartShelves";

const MODES: [GroupMode, string][] = [["any", "Any"], ["all", "All"], ["none", "None"]];
/** There is always one group to add conditions to. */
const withAGroup = (groups: RuleGroup[]): RuleGroup[] => (groups.length ? groups : [{ mode: "any", conditions: [] }]);
const chipText = (node: QueryNode) => describeQuery({ tree: node })[0] ?? "";

/** The inline "+ condition" row of one group. */
function AddCondition({ onAdd }: { onAdd(node: QueryNode): void }) {
  const [kind, setKind] = useState<ConditionKind>("tag");
  const [value, setValue] = useState("");
  const choices = kind === "is" ? STATUS_CHOICES : kind === "no" ? EMPTY_CHOICES : kind === "saved" ? SAVED_CHOICES : null;
  useEffect(() => { setValue(choices ? choices[0][0] : ""); }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const node = condition(kind, value);
  const add = () => { if (node) { onAdd(node); if (!choices) setValue(""); } };
  return (
    <span className="smart-add">
      <select className="input" aria-label="What the condition tests" value={kind} onChange={e => setKind(e.target.value as ConditionKind)}>
        {CONDITION_KINDS.map(c => <option key={c.kind} value={c.kind}>{c.label}</option>)}
      </select>
      {choices ? <select className="input" aria-label="Condition value" value={value} onChange={e => setValue(e.target.value)}>
        {choices.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        {kind === "saved" && <option value={value.startsWith(">") ? value : ">"}>After a day…</option>}
      </select> : null}
      {(!choices || (kind === "saved" && value.startsWith(">"))) && <input className="input" aria-label="Condition value"
        type={kind === "saved" ? "date" : "text"} value={kind === "saved" ? value.slice(1) : value}
        placeholder={CONDITION_KINDS.find(c => c.kind === kind)?.hint}
        onChange={e => setValue(kind === "saved" ? `>${e.target.value}` : e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />}
      <button type="button" className="btn smart-small" disabled={!node} onClick={add}><Plus size={11} /> Add</button>
    </span>
  );
}

/**
 * New or edit a smart shelf: a saved search shown as a shelf, made of groups of rules (any / all / none of their
 * conditions). It stores the search text; a search the groups can't show is edited as text, never cut down.
 */
export default function SmartShelfEditor({ view, onClose, onSaved }: { view?: SavedView; onClose(): void; onSaved?(id: string): void }) {
  const posts = useLibrary(s => s.posts);
  const tagInfo = useLibrary(s => s.tagInfo);
  const dialog = useRef<HTMLDialogElement>(null);
  const initial = view?.filter.search ?? "";
  const [name, setName] = useState(view?.name ?? "");
  const [groups, setGroups] = useState<RuleGroup[]>(() => withAGroup(groupsOf(initial) ?? []));
  const [asText, setAsText] = useState(() => groupsOf(initial) === null);
  const [text, setText] = useState(initial);
  const [problem, setProblem] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);

  const search = asText ? text.trim() : searchOf(groups);
  const matching = useMemo(() => {
    const parsed = parseQuery(search);
    const tags = tagLookup(tagInfo);
    return parsed.tree ? posts.filter(p => matchesQuery(p, parsed, tags)).length : 0;
  }, [posts, search, tagInfo]);
  const textFits = asText && groupsOf(text) !== null;

  const update = (index: number, change: Partial<RuleGroup>) => setGroups(gs => gs.map((g, i) => (i === index ? { ...g, ...change } : g)));
  const save = () => {
    setProblem("");
    try {
      const store = useLibrary.getState();
      const filter = { kind: "all" as const, search, smart: true };
      let id = view?.id ?? "";
      if (view) {
        if (name.trim() !== view.name) store.renameView(view.id, name);
        store.updateView(view.id, filter);
      } else {
        id = store.saveView(name, filter);
      }
      onSaved?.(id);
      onClose();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The smart shelf couldn't be saved.");
    }
  };

  return (
    <dialog ref={dialog} className="smart-dialog" aria-labelledby="smart-title" onClose={onClose}>
      <h2 id="smart-title" className="flex items-center gap-2 font-semibold"><Zap size={15} className="text-[var(--accent)]" />{view ? "Edit smart shelf" : "New smart shelf"}</h2>
      <p className="mt-1 text-[.74rem] text-[var(--dim)]">A shelf that fills itself: the links that match these rules, now and later. Nothing is moved.</p>
      <label className="mt-3 block text-[.76rem]">Name
        <input className="input mt-1" value={name} maxLength={80} onChange={e => setName(e.target.value)} placeholder="Bread to bake" />
      </label>

      {!asText ? <>
        {groups.map((group, index) => (
          <div key={index} className="smart-group" role="group" aria-label={`Rule group ${index + 1}`}>
            <div className="flex items-center gap-2 text-[.76rem]">
              <select className="input smart-mode" aria-label="Which of these" value={group.mode} onChange={e => update(index, { mode: e.target.value as GroupMode })}>
                {MODES.map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}
              </select>
              <span className="text-[var(--dim)]">of these</span>
              <span className="flex-1" />
              {groups.length > 1 && <button type="button" className="smart-link" onClick={() => setGroups(gs => gs.filter((_, i) => i !== index))}>
                <X size={11} /> Remove group</button>}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {group.conditions.map((node, at) => (
                <span key={at} className="chip smart-chip">{chipText(node)}
                  <button type="button" aria-label={`Remove ${chipText(node)}`} onClick={() => update(index, { conditions: group.conditions.filter((_, i) => i !== at) })}>
                    <X size={10} /></button></span>
              ))}
              <AddCondition onAdd={node => update(index, { conditions: [...group.conditions, node] })} />
            </div>
          </div>
        ))}
        <button type="button" className="btn mt-2.5 text-[.74rem]" onClick={() => setGroups(gs => [...gs, { mode: "all", conditions: [] }])}>
          <Plus size={12} /> Add a group</button>
      </> : <label className="mt-3 block text-[.76rem]">Search
        <textarea className="input mt-1 font-mono text-[.76rem]" rows={3} value={text} onChange={e => setText(e.target.value)} spellCheck={false}
          aria-describedby="smart-text-note" />
        <span id="smart-text-note" className="mt-1 block text-[.7rem] text-[var(--faint)]">
          {textFits ? "This search fits the rules again." : "Some parts of this search (an “and” inside an “or”, for example) can't be shown as rules, so it is edited as text. Nothing is left out."}
        </span>
      </label>}

      <p className="mt-3 text-[.72rem] text-[var(--faint)]">
        As a search: <code>{search || "—"}</code>{" "}
        {!asText ? <button type="button" className="smart-link" onClick={() => { setText(search); setAsText(true); }}>Edit as text</button>
          : <button type="button" className="smart-link" disabled={!textFits} onClick={() => { setGroups(withAGroup(groupsOf(text) ?? [])); setAsText(false); }}>Edit as rules</button>}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-[.76rem] text-[var(--dim)]" role="status"><b className="text-[var(--text)]">{matching} link{matching === 1 ? "" : "s"}</b> match now</span>
        <span className="flex-1" />
        {view && !confirmDelete && <button type="button" className="btn" onClick={() => setConfirmDelete(true)}><Trash2 size={12} /> Delete</button>}
        {view && confirmDelete && <button type="button" className="btn" onClick={() => { useLibrary.getState().deleteView(view.id); onClose(); }}>
          Delete “{view.name}”? Links stay as they are</button>}
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!name.trim() || !search} onClick={save}>Save smart shelf</button>
      </div>
      {problem && <p role="alert" className="mt-2 text-[.74rem] text-[var(--amber)]">{problem}</p>}
    </dialog>
  );
}
