import { useEffect, useMemo, useRef, useState } from "react";
import { useLibrary } from "../../store/library";
import type { Creator } from "../../types";
import { creatorFor, findCreators, handleLabel, PLATFORM_LABEL, withAuthor, type PostAuthor } from "../../lib/creators";

const who = (a: PostAuthor) => `${PLATFORM_LABEL[a.platform]}${a.handle ? ` ${handleLabel(a)}` : ""}`;
const posts = (n: number) => `${n} post${n === 1 ? "" : "s"}`;

/**
 * "Find creators in your saved posts": who made the posts that have no creator yet, from each post's own address,
 * author and title; nothing is checked online. A post joins a creator you have only when exactly one fits; more
 * than one is yours to pick. Nothing changes until Apply.
 */
export default function FindCreatorsDialog({ onClose, onDone }: { onClose(): void; onDone(text: string): void }) {
  const library = useLibrary(s => s.posts);
  const creators = useLibrary(s => s.creators);
  const dialog = useRef<HTMLDialogElement>(null);
  const plan = useMemo(() => findCreators(library, creators), [library, creators]);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [picks, setPicks] = useState<Record<string, string>>({});      // ambiguous key -> creator id, "new" or "" (skip)
  useEffect(() => { dialog.current?.showModal(); }, []);
  const name = (id: string) => creators.find(c => c.id === id)?.name ?? id;
  const toggle = (key: string) => setOff(s => { const next = new Set(s); if (next.has(key)) next.delete(key); else next.add(key); return next; });

  const chosenFresh = plan.fresh.filter(f => !off.has(f.key));
  const chosenJoin = plan.joining.filter(j => !off.has(j.key));
  const picked = plan.ambiguous.filter(a => picks[a.key]);
  const madeCount = chosenFresh.length + picked.filter(a => picks[a.key] === "new").length;
  const attachCount = [...chosenFresh, ...chosenJoin, ...picked].reduce((n, g) => n + g.postIds.length, 0);

  const apply = () => {
    const at = new Date().toISOString();
    const changed = new Map<string, Creator>();
    const attach: Record<string, string> = {};
    const join = (id: string, author: PostAuthor, postIds: string[]) => {
      const base = changed.get(id) ?? creators.find(c => c.id === id);
      if (!base) return;
      const next = withAuthor(base, author);
      if (next !== base || changed.has(id)) changed.set(id, { ...next, updatedAt: at });
      for (const postId of postIds) attach[postId] = id;
    };
    for (const f of chosenFresh) { const made = creatorFor(f.author, at); changed.set(made.id, made); for (const id of f.postIds) attach[id] = made.id; }
    for (const j of chosenJoin) join(j.creatorId, j.author, j.postIds);
    for (const a of picked) {
      if (picks[a.key] === "new") { const made = creatorFor(a.author, at); changed.set(made.id, made); for (const id of a.postIds) attach[id] = made.id; }
      else join(picks[a.key], a.author, a.postIds);
    }
    useLibrary.getState().saveCreators([...changed.values()], attach);
    onDone(`Added ${madeCount} creator${madeCount === 1 ? "" : "s"}; ${posts(attachCount)} now say who made them.`);
    dialog.current?.close();
  };

  const nothing = !plan.fresh.length && !plan.joining.length && !plan.ambiguous.length;
  return (
    <dialog ref={dialog} className="smart-dialog" aria-labelledby="find-creators-title" onClose={onClose}>
      <h2 id="find-creators-title" className="font-semibold">Creators in your saved posts</h2>
      <p className="mt-1 text-[.74rem] text-[var(--dim)]">From each post's own address and author, as saved: nothing is checked online. A post joins a creator only when exactly one fits.</p>
      {nothing && <p className="mt-3 text-[.78rem]">Every post that says who made it already has its creator.</p>}

      {plan.fresh.length > 0 && <section aria-label="New creators">
        <h3 className="claude-heading">New creators ({plan.fresh.length})</h3>
        {plan.fresh.map(f => <label key={f.key} className="find-row"><input type="checkbox" checked={!off.has(f.key)} onChange={() => toggle(f.key)} />
          <span><b>{f.author.name}</b><span className="find-row__sub">{who(f.author)} · {posts(f.postIds.length)}
            {f.alsoNamed && <i> — maybe the same person as {f.alsoNamed}: merge them after, if so</i>}</span></span></label>)}
      </section>}

      {plan.joining.length > 0 && <section aria-label="Joining creators you have">
        <h3 className="claude-heading">Joining creators you have ({plan.joining.length})</h3>
        {plan.joining.map(j => <label key={j.key} className="find-row"><input type="checkbox" checked={!off.has(j.key)} onChange={() => toggle(j.key)} />
          <span><b>{name(j.creatorId)} ← {who(j.author)}</b><span className="find-row__sub">{posts(j.postIds.length)}, by the {j.by}</span></span></label>)}
      </section>}

      {plan.ambiguous.length > 0 && <section aria-label="Needs you">
        <h3 className="claude-heading text-[var(--amber)]">Needs you ({plan.ambiguous.length})</h3>
        {plan.ambiguous.map(a => <div key={a.key} className="find-row find-row--choice">
          <span><b>“{a.author.name}” on {who(a.author)}</b> fits {a.options.length} creators · {posts(a.postIds.length)}</span>
          <span className="mt-1.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label={`Who is ${a.author.name} on ${who(a.author)}?`}>
            {[...a.options.map(id => [id, name(id)]), ["new", "A new creator"], ["", "Skip"]].map(([value, label]) => (
              <button key={value} type="button" role="radio" aria-checked={(picks[a.key] ?? "") === value}
                className={"btn smart-small" + ((picks[a.key] ?? "") === value ? " btn-on" : "")} onClick={() => setPicks(p => ({ ...p, [a.key]: value }))}>{label}</button>
            ))}
          </span>
        </div>)}
      </section>}

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <button type="button" className="btn" onClick={() => dialog.current?.close()}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!madeCount && !attachCount} onClick={apply}>
          {madeCount ? `Add ${madeCount} creator${madeCount === 1 ? "" : "s"}, ` : ""}attach {posts(attachCount)}</button>
      </div>
    </dialog>
  );
}
