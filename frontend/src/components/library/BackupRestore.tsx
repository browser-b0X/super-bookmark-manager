import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { useLibrary } from "../../store/library";
import { syncRestoredLibrary, useLibraryPersistence } from "../../lib/libraryPersistence";
import { useCopyAvailability } from "../../lib/copyAvailability";
import { formatBytes, restoreCopies } from "../../lib/savedCopies";
import { useCopySummary } from "./SavedCopiesSettings";

interface Preview { version: number; exportedAt: string; recordCount: number; deletedCount: number; sha256: string; currentCount: number }

const links = (n: number) => `${n} link${n === 1 ? "" : "s"}`;

export default function BackupRestore() {
  const file = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pending = useLibrary(s => Object.keys(s.pending).length);
  const status = useLibraryPersistence(s => s.status);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [content, setContent] = useState("");
  // Where a restore saved the library it replaced ("" when that library was empty).
  const [safetyCopy, setSafetyCopy] = useState("");
  // Focus goes back to Restore backup once the panel is usable again (a disabled button can't take it).
  const refocus = useRef(false);
  useEffect(() => { if (!busy && refocus.current) { refocus.current = false; trigger.current?.focus(); } }, [busy]);
  const copiesEnabled = useCopyAvailability(s => s.enabled);
  const copies = useCopySummary();
  const request = async (action: string, data: object) => {
    const response = await fetch(`/api/backup/${action}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw new Error(result.error || "Backup action failed.");
    return result;
  };
  const attempt = async (action: () => Promise<void>) => {
    setBusy(true); setMessage(""); setSafetyCopy("");
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
  // Saved copies never go into the JSON backup; this is the opt-in zip that has both.
  const exportWithCopies = () => attempt(async () => {
    const response = await fetch("/api/archive/export", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      throw new Error(result?.error || "The backup with saved copies could not be exported.");
    }
    const filename = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? "saved-posts-with-copies.zip";
    const url = URL.createObjectURL(await response.blob());
    const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage(`Exported the library and its saved copies as one zip. Download: ${filename}. The zip opens without the app: start with index.html inside it.`);
  });
  const zipFile = useRef<HTMLInputElement>(null);
  const restoreZip = (selected: File) => attempt(async () => {
    const result = await restoreCopies(selected);
    const count = result.restored.length;
    const parts = [count ? `Restored ${count} saved cop${count === 1 ? "y" : "ies"}.` : "No saved copies were restored."];
    if (result.telegram) parts.push(`Telegram photos and videos restored for ${result.telegram} link${result.telegram === 1 ? "" : "s"}.`);
    if (result.already) parts.push(`${result.already} ${result.already === 1 ? "was" : "were"} already here and ${result.already === 1 ? "was" : "were"} kept.`);
    if (result.notInLibrary) parts.push(`${result.notInLibrary} belong${result.notInLibrary === 1 ? "s" : ""} to links that are not in this library and ${result.notInLibrary === 1 ? "was" : "were"} skipped.`);
    if (result.invalid) parts.push(`${result.invalid} ${result.invalid === 1 ? "was" : "were"} damaged or not made by this app and ${result.invalid === 1 ? "was" : "were"} skipped.`);
    setMessage(parts.join(" "));
  });
  const selectFile = (selected: File) => {
    setPreview(null); setContent("");
    void attempt(async () => {
      const text = await selected.text();
      const result: Preview = await request("preview", { content: text });
      setContent(text); setPreview(result);
      setMessage("Backup integrity verified. Review the details before restoring.");
    });
  };
  const restore = () => attempt(async () => {
    if (!preview) return;
    const result = await request("restore", { content, sha256: preview.sha256, confirm: true });
    setPreview(null); setContent("");
    // This tab still shows the replaced library until it reads the restored one.
    const shown = await syncRestoredLibrary(result.epoch);
    setSafetyCopy(result.safetyCopy);
    setMessage(`Restored ${links(result.recordCount)} from the backup.`
      + (shown ? "" : " This page could not show them yet: reload the page."));
    refocus.current = true;
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
      Restore replaces the links, deletion markers and shelves in this library with the backup's. If the library
      has links, they are saved first as a backup file in a backups folder beside it, so you can restore them the
      same way. Keep your downloaded JSON. SHA-256 checks file integrity, not who created it.
    </p>
    <div className="mt-3 flex flex-wrap gap-2">
      <button className="btn" disabled={busy || pending > 0 || status !== "saved"} onClick={() => void exportFile()}>Export backup</button>
      <button ref={trigger} className="btn" disabled={busy || pending > 0 || status !== "saved"} onClick={() => file.current?.click()}>Restore backup</button>
      {copiesEnabled && <button className="btn" disabled={busy || pending > 0 || status !== "saved"} onClick={() => void exportWithCopies()}
        title="One zip with the same backup, every saved copy and a page that lists them">
        Export backup with saved copies (.zip{copies && copies.bytes ? `, about ${formatBytes(copies.bytes)}` : ""})
      </button>}
      {copiesEnabled && <button className="btn" disabled={busy} onClick={() => zipFile.current?.click()}
        title="Put back saved copies from a zip made by Export backup with saved copies">
        <Upload size={13} /> Restore saved copies from a zip
      </button>}
      <input ref={zipFile} type="file" accept=".zip,application/zip" className="hidden" aria-label="Select backup zip with saved copies"
        disabled={busy} onChange={e => { const selected = e.target.files?.[0]; e.target.value = ""; if (selected) void restoreZip(selected); }} />
      <input ref={file} type="file" accept=".json,application/json" className="hidden" aria-label="Select library backup"
        disabled={busy} onChange={e => { const selected = e.target.files?.[0]; e.target.value = ""; if (selected) selectFile(selected); }} />
    </div>
    {copiesEnabled && <p className="mt-2 text-[.74rem] text-[var(--dim)]">
      Saved copies of pages are not in the JSON backup. The zip holds the same backup plus every saved copy. Restoring from the zip
      adds copies for links in this library and never replaces a copy you already have; to restore the links themselves, use
      library.json from the zip with Restore backup.
    </p>}
    {(pending > 0 || status !== "saved") && <p className="mt-2 text-[.76rem]">Export and restore are available after SQLite confirms all changes are saved.</p>}
    {busy && <p role="status" className="mt-2 text-sm">Working on your backup…</p>}
    {preview && <div role="region" aria-label="Restore preview" className="mt-3 rounded border border-[var(--border)] p-3 text-sm">
      <p>Version {preview.version} · {links(preview.recordCount)} · {preview.deletedCount} deletion marker{preview.deletedCount === 1 ? "" : "s"}</p>
      <p>Exported: {preview.exportedAt}</p>
      <p className="mt-2">{preview.currentCount
        ? `This replaces the ${links(preview.currentCount)} in this library with the backup's ${links(preview.recordCount)}. This library is saved first as a backup file, so you can go back.`
        : `This library is empty: the backup's ${links(preview.recordCount)} become your library.`}</p>
      <p className="mt-2">Saved Views and other browser preferences stay as they are.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="btn" disabled={busy} onClick={() => void restore()}>Confirm restore</button>
        <button className="btn" disabled={busy} onClick={() => { setPreview(null); setContent(""); setMessage("Restore canceled. Nothing changed."); trigger.current?.focus(); }}>Cancel restore</button>
      </div>
    </div>}
    {message && <p role="status" aria-label="Backup result" className="mt-3 break-words text-[.76rem]">{message}</p>}
    {safetyCopy && <div className="mt-3 break-words text-[.76rem]">
      <p>Your previous library was saved as <span data-safety-copy className="font-mono">{safetyCopy}</span></p>
      <p className="mt-1">To go back to it, choose Restore backup and pick that file.</p>
    </div>}
  </section>;
}
