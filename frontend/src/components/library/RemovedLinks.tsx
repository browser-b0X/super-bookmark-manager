import { useMemo, useState } from "react";
import { RotateCcw, Trash } from "lucide-react";
import { useLibrary } from "../../store/library";
import { whatItHad } from "../../lib/removedLinks";

const shortAddress = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "");
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const SHOWN = 20;

/** Removed links, remembered (v0.4.0): what each held, so it comes back as it was, and an import or Telegram doesn't
 *  bring the same post back at another address. */
export default function RemovedLinks() {
  const removed = useLibrary(s => s.removed);
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(false);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...(removed ?? [])].sort((a, b) => b.removedAt.localeCompare(a.removedAt))
      .filter(r => !q || (r.post.title ?? "").toLowerCase().includes(q) || r.url.toLowerCase().includes(q));
  }, [removed, query]);

  const bringBack = (id: string, title: string) => {
    const { restored } = useLibrary.getState().bringBack([id]);
    setNote(restored ? `“${title}” is back, as it was.` : `“${title}” is already in your library at that address.`);
  };

  return (
    <section className="panel mt-5 p-5" aria-labelledby="removed-heading">
      <h3 id="removed-heading" className="flex items-center gap-2 text-[.9rem] font-semibold">
        <Trash size={15} className="text-[var(--accent)]" /> Removed links {list.length > 0 && !query && <span className="chip">{list.length}</span>}
      </h3>
      <p className="mt-1.5 text-[.76rem] text-[var(--dim)]">
        Links you removed are remembered with their notes, tags, shelves and marks, so an import or Telegram doesn't bring them back. Bring one back and it returns as it was (its saved copy doesn't).
      </p>
      {note && <p role="status" className="mt-2 text-[.76rem]">{note}</p>}
      {(removed ?? []).length > 0 && (
        <input className="input mt-3" placeholder="Find a removed link" aria-label="Find a removed link" value={query} onChange={e => setQuery(e.target.value)} />
      )}
      {!(removed ?? []).length && <p className="mt-3 text-[.76rem] text-[var(--faint)]">Nothing removed yet.</p>}
      <ul className="mt-2">
        {(all ? list : list.slice(0, SHOWN)).map(r => {
          const title = r.post.title || shortAddress(r.url);
          const had = whatItHad(r.post);
          return (
            <li key={r.id} className="flex items-center gap-2.5 border-t border-[var(--border)] py-2 text-[.78rem]" aria-label={title}>
              <span className="min-w-0 flex-1">
                <b className="block truncate">{title}</b>
                <span className="block truncate text-[.72rem] text-[var(--faint)]">
                  {shortAddress(r.url)} · {r.how === "merged" ? `merged into ${shortAddress(r.into ?? "")} on` : "removed"} {day(r.removedAt)}{had.length ? ` · ${had.join(", ")}` : ""}
                </span>
              </span>
              <button className="btn" style={{ fontSize: ".72rem" }} onClick={() => bringBack(r.id, title)}><RotateCcw size={12} /> Bring back</button>
              {forgetting === r.id
                ? <button className="btn btn-danger" style={{ fontSize: ".72rem" }} onClick={() => { useLibrary.getState().forgetRemoved([r.id]); setForgetting(null); }}
                    title="An import can bring it back after this">Forget it</button>
                : <button className="btn" style={{ fontSize: ".72rem" }} onClick={() => setForgetting(r.id)} aria-label={`Forget ${title}`}>Forget…</button>}
            </li>
          );
        })}
      </ul>
      {!all && list.length > SHOWN && <button className="btn mt-2" style={{ fontSize: ".72rem" }} onClick={() => setAll(true)}>Show {list.length - SHOWN} more</button>}
    </section>
  );
}
