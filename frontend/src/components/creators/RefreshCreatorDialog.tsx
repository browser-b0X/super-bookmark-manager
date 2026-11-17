import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useLibrary } from "../../store/library";
import type { Creator } from "../../types";
import { applyRefresh, refreshRows, type ProfilePage, type RefreshChoice, type RefreshRow } from "../../lib/creators";

const LABEL: Record<RefreshChoice, string> = { keep: "keep", take: "take", alias: "add as another name" };
const FIELD: Record<RefreshRow["field"], string> = { name: "Name", about: "About", picture: "Picture" };
const ERRORS: Record<string, string> = {
  invalid_url: "That isn't a page address the app can read.", timeout: "The page took too long to answer.", busy: "The app is reading other pages: try again in a moment.",
  http_error: "The page answered with an error (it may need a login).", empty: "The page shows nothing the app can read (it may need a login).",
};

/**
 * Refresh a creator from one profile page, read now because the owner clicked: only what differs is listed, what the
 * creator has is kept unless the owner takes the page's value, and values kept are remembered so a refresh with
 * nothing new says so. Nothing changes until Apply.
 */
export default function RefreshCreatorDialog({ creator, onClose, onDone }: { creator: Creator; onClose(): void; onDone(text: string, undo: () => void): void }) {
  const creators = useLibrary(s => s.creators);
  const dialog = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState(creator.urls[0] ?? "");
  const [rows, setRows] = useState<RefreshRow[] | null>(null);
  const [problem, setProblem] = useState("");
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let live = true;
    setRows(null); setProblem("");
    void (async () => {
      try {
        const response = await fetch("/api/creators/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
        const data = await response.json();
        if (!live) return;
        if (!response.ok || !data.ok) { setProblem(ERRORS[data.error] ?? "The page couldn't be read."); setRows([]); return; }
        setRows(refreshRows(creator, data as ProfilePage, creators));
      } catch {
        if (live) { setProblem("The app didn't answer. Try again."); setRows([]); }
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const apply = () => {
    if (!rows) return;
    const before: Partial<Creator> = { name: creator.name, aliases: creator.aliases, about: creator.about, picture: creator.picture, kept: creator.kept };
    const at = useLibrary.getState().updateCreator(creator.id, applyRefresh(creator, rows));
    const taken = rows.filter(r => r.choice !== "keep").length;
    onDone(taken ? `Took ${taken} change${taken === 1 ? "" : "s"} from the profile page.` : "Kept what you had; the profile page's values won't be offered again.",
      () => { useLibrary.getState().revertCreator(creator.id, at, before); });
    dialog.current?.close();
  };
  const show = (row: RefreshRow, value: string) => row.field === "picture"
    ? (value ? <img src={value} alt="" width={40} height={40} className="creator-avatar" /> : <i className="text-[var(--faint)]">none</i>)
    : (value || <i className="text-[var(--faint)]">none</i>);

  return (
    <dialog ref={dialog} className="smart-dialog merge-dialog" aria-labelledby="refresh-title" onClose={onClose}>
      <h2 id="refresh-title" className="font-semibold">Refresh {creator.name} from the profile page</h2>
      <p className="mt-1 text-[.74rem] text-[var(--dim)]">One page, read now:{" "}
        {creator.urls.length > 1 ? <select className="input" style={{ width: "auto", padding: "2px 8px", fontSize: ".74rem" }} aria-label="Profile page" value={url}
          onChange={e => setUrl(e.target.value)}>{creator.urls.map(u => <option key={u} value={u}>{u}</option>)}</select> : <code>{url}</code>}.
        Only what differs is listed. What {creator.name} has is kept unless you take the new value.</p>
      {rows === null && <p className="mt-3 flex items-center gap-2 text-[.78rem]" role="status"><Loader2 size={14} className="animate-spin" /> Reading the page…</p>}
      {problem && <p className="mt-3 text-[.78rem] text-[var(--amber)]" role="alert">{problem}</p>}
      {rows && !problem && !rows.length && <p className="mt-3 text-[.78rem]" role="status">Nothing new on the profile page.</p>}
      {rows && rows.length > 0 && <table className="merge-table" aria-label="What the profile page shows">
        <thead><tr><th /><th>Now</th><th>On the profile page</th><th /></tr></thead>
        <tbody>{rows.map((row, i) => (
          <tr key={row.field}>
            <th>{FIELD[row.field]}</th><td>{show(row, row.now)}</td>
            <td>{show(row, row.page)}{row.clash && <span className="block text-[.7rem] text-[var(--amber)]">That's the name of {row.clash}: merge them instead, if they're the same.</span>}</td>
            <td><span className="flex flex-wrap gap-1" role="radiogroup" aria-label={`${FIELD[row.field]}: keep or take`}>{row.options.map(option => (
              <button key={option} type="button" role="radio" aria-checked={row.choice === option} className={"btn smart-small" + (row.choice === option ? " btn-on" : "")}
                onClick={() => setRows(rs => rs!.map((r, at) => (at === i ? { ...r, choice: option } : r)))}>{LABEL[option]}</button>
            ))}</span></td>
          </tr>
        ))}</tbody>
      </table>}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button type="button" className="btn" onClick={() => dialog.current?.close()}>{rows && rows.length ? "Cancel" : "Close"}</button>
        {rows && rows.length > 0 && <button type="button" className="btn btn-primary" onClick={apply}>
          Apply {rows.filter(r => r.choice !== "keep").length || ""}</button>}
      </div>
    </dialog>
  );
}
