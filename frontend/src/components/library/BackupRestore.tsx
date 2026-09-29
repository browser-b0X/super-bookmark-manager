import { useRef, useState } from "react";
import { useLibrary } from "../../store/library";
import { useLibraryPersistence } from "../../lib/libraryPersistence";

interface Preview { version: number; exportedAt: string; recordCount: number; deletedCount: number; sha256: string }

export default function BackupRestore() {
  const file = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pending = useLibrary(s => Object.keys(s.pending).length);
  const status = useLibraryPersistence(s => s.status);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [content, setContent] = useState("");
  const [restored, setRestored] = useState("");
  const request = async (action: string, data: object) => {
    const response = await fetch(`/api/backup/${action}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw new Error(result.error || "Backup action failed.");
    return result;
  };
  const attempt = async (action: () => Promise<void>) => {
    setBusy(true); setMessage(""); setRestored("");
    try { await action(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not read the backup file."); }
    finally { setBusy(false); }
  };
  const exportFile = () => attempt(async () => {
    const result = await request("export", { confirm: true });
    const url = URL.createObjectURL(new Blob([result.content], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = result.filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage(`Exported ${result.recordCount} SQLite-saved items. Download: ${result.filename}. Check your downloads to keep this backup.`);
  });
  const selectFile = (selected: File) => {
    setPreview(null); setContent("");
    void attempt(async () => {
      const text = await selected.text();
      const result: Preview = await request("preview", { content: text });
      setContent(text); setPreview(result);
      setMessage("Backup integrity verified. Review the details before creating a restored database.");
    });
  };
  const restore = () => attempt(async () => {
    if (!preview) return;
    const result = await request("restore", { content, sha256: preview.sha256, confirm: true });
    setRestored(result.path); setPreview(null); setContent("");
    setMessage(`Restored ${result.recordCount} items into a new database. Your current library and browser preferences are unchanged. The new database is not active yet.`);
    trigger.current?.focus();
  });
  return <section className="panel mt-5 p-5" aria-labelledby="backup-heading">
    <h2 id="backup-heading" className="text-[.9rem] font-semibold">Backup &amp; Restore</h2>
    <p className="mt-2 text-[.76rem] text-[var(--dim)]">
      JSON backup includes SQLite-saved links, full notes/tags/favorites/statuses, category choices,
      source and Telegram associations, category definitions and deletion markers.
      It excludes unsaved browser edits, Saved Views, theme/sidebar preferences, image files,
      sessions/credentials and legacy dashboard tasks, scratchpad and layouts. Image URLs are retained.
    </p>
    <p className="mt-2 text-[.76rem] text-[var(--dim)]">
      Restore creates a separate database in the restored-libraries folder beside your current database.
      It never replaces your current library or switches automatically. Keep your downloaded JSON.
      SHA-256 checks file integrity, not who created it.
    </p>
    <div className="mt-3 flex flex-wrap gap-2">
      <button className="btn" disabled={busy || pending > 0 || status !== "saved"} onClick={() => void exportFile()}>Export backup</button>
      <button ref={trigger} className="btn" disabled={busy} onClick={() => file.current?.click()}>Restore backup</button>
      <input ref={file} type="file" accept=".json,application/json" className="hidden" aria-label="Select library backup"
        disabled={busy} onChange={e => { const selected = e.target.files?.[0]; e.target.value = ""; if (selected) selectFile(selected); }} />
    </div>
    {(pending > 0 || status !== "saved") && <p className="mt-2 text-[.76rem]">Export is available after SQLite confirms all changes are saved.</p>}
    {busy && <p role="status" className="mt-2 text-sm">Working on your backup…</p>}
    {preview && <div role="region" aria-label="Restore preview" className="mt-3 rounded border border-[var(--border)] p-3 text-sm">
      <p>Version {preview.version} · {preview.recordCount} items · {preview.deletedCount} deletion markers</p>
      <p>Exported: {preview.exportedAt}</p>
      <p className="mt-2">Create a new database only. Current library will NOT be replaced. Saved Views and other browser preferences are not included.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="btn" disabled={busy} onClick={() => void restore()}>Confirm restore to new database</button>
        <button className="btn" disabled={busy} onClick={() => { setPreview(null); setContent(""); setMessage("Restore canceled. Nothing changed."); trigger.current?.focus(); }}>Cancel restore</button>
      </div>
    </div>}
    {message && <p role="status" aria-label="Backup result" className="mt-3 break-words text-[.76rem]">{message}</p>}
    {restored && <div className="mt-3 break-words text-[.76rem]">
      <p>New database: <span data-restored-path>{restored}</span></p>
      <p className="mt-2">To use it, stop your current server yourself. Open a fresh browser profile to avoid merging old cached library items, then launch from the project folder in PowerShell:</p>
      <pre className="mt-2 whitespace-pre-wrap break-all">{`$env:SAVED_POSTS_DB_PATH='${restored.replaceAll("'", "''")}'\npy -3.12 run.py --serve-only`}</pre>
      <p className="mt-2">Your original browser's Saved Views remain there; the fresh profile starts without those preferences. To return, restart with your original database path.</p>
    </div>}
  </section>;
}
