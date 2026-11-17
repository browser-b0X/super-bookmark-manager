import { useMemo, useState } from "react";
import { History, Undo2 } from "lucide-react";
import { useLibrary } from "../../store/library";

const IMPORTED: Record<string, string> = { html: "a bookmarks file", chromium: "Chrome, Edge or Brave", "firefox-db": "Firefox", "firefox-json": "a Firefox backup",
  telegram: "Telegram", whatsapp: "WhatsApp", pocket: "Pocket", "pocket-html": "Pocket", instapaper: "Instapaper" };
const when = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? `today ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};
const links = (n: number) => `${n} link${n === 1 ? "" : "s"}`;
/** Why links of a batch didn't come back: removed links may be in the library again or forgotten. */
const leftOver = (kind: string, n: number) => kind === "removed"
  ? `already in the library again or no longer remembered`
  : `changed since ${n === 1 ? "was" : "were"} left as ${n === 1 ? "it is" : "they are"}`;

interface Row { id: string; at: string; text: string; count: number; undone?: string; undo: () => string }

/** History (v0.4.0): what changed many links at once, newest first, in this browser. Any batch can be undone, not
 *  only the last; links and records changed since are left as they are. */
export default function HistoryPanel() {
  const history = useLibrary(s => s.history);
  const imports = useLibrary(s => s.imports);
  const [note, setNote] = useState("");
  const rows = useMemo<Row[]>(() => [
    ...(history ?? []).map(h => ({
      id: h.id, at: h.at, text: h.text, count: h.count,
      undone: h.undone ? `undone; ${h.undone.restored} put back${h.undone.skipped ? `, ${h.undone.skipped} ${leftOver(h.undo.kind, h.undone.skipped)}` : ""}` : undefined,
      undo: () => {
        const result = useLibrary.getState().undoHistory(h.id);
        return result ? `Undid “${h.text}”: ${links(result.restored)} put back${result.skipped ? `; ${result.skipped} ${leftOver(h.undo.kind, result.skipped)}` : ""}.` : "";
      },
    })),
    ...(imports ?? []).filter(r => r.added > 0).map(r => ({
      id: r.id, at: r.at, text: `Imported from ${IMPORTED[r.source] ?? r.source}${r.fileName ? ` (${r.fileName})` : ""}`, count: r.added,
      undone: r.undone ? `undone; ${r.undone.removed} removed${r.undone.kept ? `, ${r.undone.kept} you changed since kept` : ""}` : undefined,
      undo: () => {
        const { removed, kept } = useLibrary.getState().undoImport(r.id, false);
        return `Undid the import: ${links(removed)} removed${kept ? `; ${links(kept)} you changed since kept` : ""}.`;
      },
    })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50), [history, imports]);

  return (
    <section className="panel mt-5 p-5" aria-labelledby="history-heading">
      <h3 id="history-heading" className="flex items-center gap-2 text-[.9rem] font-semibold"><History size={15} className="text-[var(--accent)]" /> History</h3>
      <p className="mt-1.5 text-[.76rem] text-[var(--dim)]">
        What changed many links at once, newest first, in this browser. Any of them can be undone: links changed since are left as they are.
      </p>
      {note && <p role="status" className="mt-2 text-[.76rem]">{note}</p>}
      {!rows.length && <p className="mt-3 text-[.76rem] text-[var(--faint)]">Nothing yet. Bulk edits, merges, removals, imports and Tidy up with AI are listed here.</p>}
      <ul className="mt-2">
        {rows.map(row => (
          <li key={row.id} className="flex items-center gap-2.5 border-t border-[var(--border)] py-2 text-[.78rem]" style={row.undone ? { color: "var(--faint)" } : undefined} aria-label={row.text}>
            <span className="min-w-0 flex-1">
              <b className="block truncate">{row.text}</b>
              <span className="block text-[.72rem] text-[var(--faint)]">{when(row.at)} · {links(row.count)}{row.undone ? ` · ${row.undone}` : ""}</span>
            </span>
            {!row.undone && <button className="btn" style={{ fontSize: ".72rem" }} onClick={() => setNote(row.undo())}><Undo2 size={12} /> Undo</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}
