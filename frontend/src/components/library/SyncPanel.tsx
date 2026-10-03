import { useState } from "react";
import { Database, RotateCcw } from "lucide-react";
import { syncLibrary } from "../../lib/libraryPersistence";
import { useSaveMessage } from "../SyncIndicator";
import { useLibrary } from "../../store/library";

/** Full save status and controls (the sidebar only shows a steady dot). */
export default function SyncPanel() {
  const { pending, persistence, message } = useSaveMessage();
  const total = useLibrary(s => s.posts.length);
  const rev = useLibrary(s => s.syncRev);
  const [note, setNote] = useState<string | null>(null);
  const busy = persistence.status === "syncing";
  const error = persistence.status === "error";

  const resync = async () => {
    const saved = await syncLibrary();
    setNote(saved
      ? "Re-synced with SQLite. Imported links and curation are saved."
      : "SQLite sync failed. Unsaved changes remain pending in this browser; use Retry SQLite save.");
  };

  return (
    <section className="panel p-5" aria-labelledby="sync-heading">
      <h3 id="sync-heading" className="flex items-center gap-2 text-[.9rem] font-semibold">
        <Database size={15} className="text-[var(--accent)]" /> Saving to SQLite
      </h3>
      <p className="mt-1.5 flex items-center gap-2 text-[.78rem]" aria-label="Library sync details">
        <span className="dot" style={{ background: error ? "var(--amber)" : pending || busy ? "var(--accent)" : "var(--green)" }} />
        <span style={{ color: error ? "var(--amber)" : undefined }}>{busy && !pending ? "Saving…" : message}</span>
      </p>
      {persistence.error && <p className="mt-1 text-[.74rem] text-[var(--dim)]">{persistence.error}</p>}
      <p className="mt-2 text-[.72rem] text-[var(--faint)]">
        {total} link{total === 1 ? "" : "s"} in this browser{rev ? ` · database revision ${rev}` : ""}.
        Edits are cached here first and saved to the local database in the background; the sidebar dot turns amber if a save fails.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="btn" onClick={() => void resync()} disabled={busy}>
          <Database size={13} /> Re-sync from SQLite
        </button>
        {(pending > 0 || error) && <button className="btn" onClick={() => void syncLibrary()} disabled={busy}>
          <RotateCcw size={13} /> Save {pending ? `${pending} pending change${pending === 1 ? "" : "s"}` : "again"} now
        </button>}
      </div>
      {note && <p role="status" className="mt-3 rounded-lg border p-2.5 text-[.76rem]" style={{ borderColor: "var(--border-hi)", background: "var(--surface2)" }}>{note}</p>}
    </section>
  );
}
