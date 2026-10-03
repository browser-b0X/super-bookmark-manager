import { useMemo, useRef, useState, type DragEvent } from "react";
import { ChevronDown, FileUp, History, RotateCcw, Upload, X } from "lucide-react";
import { parseBookmarkHtml, type BookmarkImportResult } from "../../lib/bookmarks";
import { parseChromiumBookmarks } from "../../lib/chromiumBookmarks";
import { parseFirefoxCopy } from "../../lib/firefoxBookmarks";
import { parseFirefoxJson } from "../../lib/firefoxJson";
import { parseTelegramExport } from "../../lib/telegram";
import { detectImportFormat, FORMAT_LABELS, type ImportFormat } from "../../lib/importDetect";
import { chatNameFrom, parseWhatsAppChat } from "../../lib/whatsapp";
import { applyImportOptions, planImport, type FolderNode, type ImportPlan } from "../../lib/importPlan";
import { applyImportTriage, IMPORT_TRIAGE_LABELS } from "../../lib/importTriage";
import { importFilePosts } from "../../lib/importCategorization";
import { touchedSinceImport, useLibrary, type ImportRecord } from "../../store/library";
import { usePrefs, type ImportTriage } from "../../store/prefs";
import { RESERVED_SHELVES } from "../../lib/shelves";
import type { SavedPost } from "../../types";

interface Preview {
  fileName: string;
  format: Exclude<ImportFormat, "unknown">;
  parsed: BookmarkImportResult & { historyIgnored?: number; walMode?: boolean };
  plan: ImportPlan;
}

const SAMPLE = 8;

/** Where each browser keeps its bookmarks (Windows), for the guidance panel. */
const GUIDE: { browser: string; easy: string; file: string }[] = [
  { browser: "Chrome", easy: "chrome://bookmarks → ⋮ → Export bookmarks", file: "%LOCALAPPDATA%\\Google\\Chrome\\User Data\\Default\\Bookmarks (other profiles: Profile 1, Profile 2…)" },
  { browser: "Edge", easy: "edge://favorites → ⋯ → Export favorites", file: "%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\Default\\Bookmarks" },
  { browser: "Brave", easy: "brave://bookmarks → ⋮ → Export bookmarks", file: "%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\User Data\\Default\\Bookmarks" },
  { browser: "Firefox", easy: "Ctrl+Shift+O → Import and Backup → Backup… (JSON, keeps folders and dates) or Export Bookmarks to HTML…", file: "%APPDATA%\\Mozilla\\Firefox\\Profiles\\<id>.default-release\\places.sqlite (about:profiles → Open Folder)" },
];

function FolderRow({ node, excluded, shelfFor, shelves, onToggle, onShelf }: {
  node: FolderNode; excluded: Set<string>; shelfFor: Map<string, string>; shelves: string[];
  onToggle: (node: FolderNode, on: boolean) => void; onShelf: (key: string, value: string | null) => void;
}) {
  const off = excluded.has(node.key);
  const value = shelfFor.has(node.key) ? (shelfFor.get(node.key) || "__none") : "__auto";
  return (
    <>
      <li className="flex items-center gap-2 py-0.5" style={{ paddingLeft: node.depth * 16 }}>
        <input type="checkbox" className="h-3.5 w-3.5 accent-[var(--accent)]" checked={!off}
          aria-label={`Import folder ${node.name}`} onChange={e => onToggle(node, e.target.checked)} />
        <span className={`min-w-0 flex-1 truncate ${off ? "text-[var(--faint)] line-through" : ""}`}>{node.name}</span>
        <span className="text-[var(--faint)]">{node.count}</span>
        <select className="input" style={{ width: 150, padding: "1px 6px", fontSize: ".7rem" }} disabled={off}
          aria-label={`Shelf for folder ${node.name}`} value={value}
          onChange={e => onShelf(node.key, e.target.value === "__auto" ? null : e.target.value === "__none" ? "" : e.target.value)}>
          <option value="__auto">Auto (keywords)</option>
          <option value="__none">Don't file</option>
          {shelves.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </li>
      {!off && node.depth < 3 && node.children.map(child => (
        <FolderRow key={child.key} node={child} excluded={excluded} shelfFor={shelfFor} shelves={shelves} onToggle={onToggle} onShelf={onShelf} />
      ))}
    </>
  );
}

function Samples({ title, items }: { title: string; items: { post: SavedPost; note?: string }[] }) {
  if (!items.length) return null;
  return (
    <details className="text-[.72rem]">
      <summary className="cursor-pointer text-[var(--dim)]">{title} ({items.length})</summary>
      <ul className="mt-1 space-y-0.5 pl-3">
        {items.slice(0, SAMPLE).map(({ post, note }) => (
          <li key={post.id} className="truncate text-[var(--faint)]" title={post.url}>{post.title || post.url}{note ? ` — ${note}` : ""}</li>
        ))}
        {items.length > SAMPLE && <li className="text-[var(--faint)]">…and {items.length - SAMPLE} more</li>}
      </ul>
    </details>
  );
}

function UndoDialog({ record, onClose }: { record: ImportRecord; onClose: (message?: string) => void }) {
  const posts = useLibrary(s => s.posts);
  const undoImport = useLibrary(s => s.undoImport);
  const [includeTouched, setIncludeTouched] = useState(false);
  const batch = posts.filter(p => p.importBatchId === record.id);
  const touched = batch.filter(touchedSinceImport);
  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal mt-[16vh] w-[min(480px,92vw)] p-5" role="dialog" aria-label="Undo import">
        <h3 className="text-[.9rem] font-semibold">Undo import of {record.fileName}?</h3>
        <p className="mt-2 text-[.78rem] text-[var(--dim)]">
          {batch.length - touched.length} link{batch.length - touched.length === 1 ? "" : "s"} from this import will be removed.
          They are not marked as deleted, so you can import the file again later.
        </p>
        {touched.length > 0 && (
          <label className="mt-3 flex items-start gap-2 text-[.76rem]">
            <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={includeTouched} onChange={e => setIncludeTouched(e.target.checked)} />
            <span>Also remove the {touched.length} link{touched.length === 1 ? "" : "s"} you have already worked with (notes, favourites, opened or triaged). Otherwise they stay.</span>
          </label>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn" onClick={() => onClose()}>Keep everything</button>
          <button className="btn btn-danger" onClick={() => {
            const { removed, kept } = undoImport(record.id, includeTouched);
            onClose(`Removed ${removed} link${removed === 1 ? "" : "s"} from ${record.fileName}${kept ? `; kept ${kept} you worked with` : ""}.`);
          }}>Remove {includeTouched ? batch.length : batch.length - touched.length}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * One place to bring links in: drop or choose any supported export, see what
 * will happen, choose folders and shelves, then import — and undo if needed.
 */
export default function BookmarkImport() {
  const categories = useLibrary(s => s.categories);
  const imports = useLibrary(s => s.imports);
  const importTriage = usePrefs(s => s.importTriage);
  const setImportTriage = usePrefs(s => s.setImportTriage);
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [shelfFor, setShelfFor] = useState<Map<string, string>>(new Map());
  const [tagMode, setTagMode] = useState<"none" | "leaf" | "path">("none");
  const [includeDuplicates, setIncludeDuplicates] = useState(false);
  const [undoing, setUndoing] = useState<ImportRecord | null>(null);

  const shelves = useMemo(() => categories.filter(c => !c.archived && !RESERVED_SHELVES.has(c.name))
    .sort((a, b) => a.order - b.order).map(c => c.name), [categories]);

  const reset = () => { setPreview(null); setExcluded(new Set()); setShelfFor(new Map()); setTagMode("none"); setIncludeDuplicates(false); };

  const read = async (file: File) => {
    reset();
    setMessage(null);
    setBusy(`Reading ${file.name}…`);
    try {
      const { format, text } = await detectImportFormat(file);
      if (format === "unknown") {
        setMessage("This file isn't a bookmark export this app can read. Use an HTML export, a Chrome/Edge/Brave Bookmarks file, a Firefox backup (.json) or places.sqlite copy, a Telegram JSON export, or a WhatsApp chat export (.txt or .zip).");
        return;
      }
      setBusy(`Reading ${FORMAT_LABELS[format].toLowerCase()}…`);
      await new Promise(resolve => setTimeout(resolve, 0)); // let the status paint before a big parse
      let parsed: Preview["parsed"];
      if (format === "html") parsed = parseBookmarkHtml(text!);
      else if (format === "chromium") parsed = parseChromiumBookmarks(text!);
      else if (format === "firefox-json") parsed = parseFirefoxJson(text!);
      else if (format === "firefox-db") parsed = await parseFirefoxCopy(file);
      else if (format === "whatsapp") parsed = parseWhatsAppChat(text!, chatNameFrom(file.name));
      else {
        const telegram = parseTelegramExport(text!);
        parsed = telegram.errors.length
          ? { posts: [], duplicates: 0, unsupported: 0, malformed: 0, error: telegram.errors.join(" ") }
          : { posts: telegram.posts, duplicates: telegram.duplicates, unsupported: telegram.unsupported, malformed: 0 };
      }
      if (parsed.error) { setMessage(parsed.error); return; }
      const state = useLibrary.getState();
      setPreview({ fileName: file.name, format, parsed, plan: planImport(parsed.posts, state.demo ? [] : state.posts, state.deletedUrls) });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not read this file. Choose an exported copy and try again.");
    } finally {
      setBusy(null);
    }
  };

  const toggleFolder = (node: FolderNode, on: boolean) => setExcluded(prev => {
    const next = new Set(prev);
    if (on) next.delete(node.key); else next.add(node.key);
    return next;
  });
  const setShelf = (key: string, value: string | null) => setShelfFor(prev => {
    const next = new Map(prev);
    if (value === null) next.delete(key); else next.set(key, value);
    return next;
  });

  const selected = useMemo(() => preview ? applyImportOptions(preview.plan, {
    excluded, shelfFor, tagMode, includeDuplicates, batchId: "preview",
  }) : [], [preview, excluded, shelfFor, tagMode, includeDuplicates]);

  const commit = () => {
    if (!preview) return;
    const batchId = `imp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const chosen = applyImportOptions(preview.plan, { excluded, shelfFor, tagMode, includeDuplicates, batchId });
    // Chat links are new by nature (Catch Up); browser bookmarks may be years old.
    const browser = preview.format !== "telegram" && preview.format !== "whatsapp";
    const triaged = browser ? applyImportTriage(chosen, importTriage) : { posts: chosen, filed: 0 };
    // Links already saved still refresh their source details (Telegram text, folders).
    const { added, updated, skipped } = importFilePosts([...triaged.posts, ...preview.plan.existing]);
    // A skipped likely duplicate still lends its folder to the saved link.
    if (!includeDuplicates) {
      const update = useLibrary.getState().updatePost;
      for (const { post, match } of preview.plan.likelyDuplicates) {
        if (post.folderPath?.length && !match.folderPath?.length) update(match.id, { folderPath: post.folderPath });
      }
    }
    useLibrary.getState().recordImport({ id: batchId, source: preview.format, fileName: preview.fileName, added, updated, skipped, filed: triaged.filed });
    const notes = [
      `${added} new link${added === 1 ? "" : "s"} imported`,
      updated ? `${updated} already saved` : "",
      preview.plan.likelyDuplicates.length && !includeDuplicates ? `${preview.plan.likelyDuplicates.length} likely duplicates skipped` : "",
      triaged.filed ? `${triaged.filed} older bookmark${triaged.filed === 1 ? "" : "s"} filed in the library instead of Catch Up` : "",
      preview.parsed.walMode ? "this copy was taken while Firefox was running, so the newest bookmarks may be missing" : "",
    ].filter(Boolean);
    setMessage(notes.join(" · ") + ". Shelves and previews fill in over the next minutes.");
    reset();
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void read(file);
  };

  const plan = preview?.plan;
  const recent = imports.slice(0, 8);

  return (
    <section className="panel mt-5 p-5" aria-labelledby="import-heading">
      <h2 id="import-heading" className="flex items-center gap-2 text-[.9rem] font-semibold"><FileUp size={15} className="text-[var(--accent)]" /> Import links</h2>
      <p className="mt-1.5 text-[.76rem] text-[var(--dim)]">
        Drop any bookmark export here — HTML, a Chrome/Edge/Brave <b>Bookmarks</b> file, a Firefox backup (.json) or places.sqlite copy,
        a Telegram JSON export, or a WhatsApp chat export (.txt, or the .zip an iPhone makes). The file type is detected
        for you and nothing is saved until you confirm.
      </p>

      {!preview && (
        <div
          className={`import-drop mt-3 ${dragging ? "is-dragging" : ""}`}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <Upload size={18} className="text-[var(--accent)]" />
          <span>{busy ?? "Drop a file here, or"}</span>
          {!busy && <button className="btn btn-primary" onClick={() => input.current?.click()}>Choose a file…</button>}
          <input ref={input} type="file" className="hidden" aria-label="Choose a file to import"
            onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void read(file); }} />
        </div>
      )}

      {message && <p role="status" aria-label="Import result" className="mt-3 rounded-lg border p-2.5 text-[.76rem]"
        style={{ borderColor: "var(--border-hi)", background: "var(--surface2)" }}>{message}</p>}

      {preview && plan && (
        <div className="mt-3 rounded-lg border p-3" style={{ borderColor: "var(--border-hi)" }} aria-label="Import preview">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[.8rem] font-semibold">{preview.fileName}</div>
              <div className="text-[.7rem] text-[var(--faint)]">{FORMAT_LABELS[preview.format]} · nothing saved yet</div>
            </div>
            <button className="icon-btn" aria-label="Cancel import" onClick={reset}><X size={14} /></button>
          </div>

          <dl className="import-counts mt-3">
            <div><dt>New</dt><dd>{plan.fresh.length}</dd></div>
            <div><dt>Already saved</dt><dd>{plan.existing.length}</dd></div>
            <div><dt>Likely duplicates</dt><dd>{plan.likelyDuplicates.length}</dd></div>
            <div><dt>Skipped</dt><dd>{plan.skipped.length + preview.parsed.duplicates + preview.parsed.unsupported + preview.parsed.malformed}</dd></div>
          </dl>
          <div className="mt-2 space-y-1">
            <Samples title="New" items={plan.fresh.map(post => ({ post }))} />
            <Samples title="Likely duplicates of links you already have" items={plan.likelyDuplicates.map(d => ({ post: d.post, note: `matches “${d.match.title || d.match.url}”` }))} />
            <Samples title="Skipped" items={plan.skipped.map(s => ({ post: s.post, note: s.reason === "deleted" ? "you deleted this link" : "ID already used by another link" }))} />
            {(preview.parsed.duplicates + preview.parsed.unsupported + preview.parsed.malformed) > 0 && (
              <p className="text-[.7rem] text-[var(--faint)]">
                In the file: {preview.parsed.duplicates} repeated, {preview.parsed.unsupported} non-web (javascript:, file:, place:) and {preview.parsed.malformed} unreadable entries are left out.
                {preview.parsed.historyIgnored ? ` ${preview.parsed.historyIgnored} history-only rows ignored.` : ""}
              </p>
            )}
            {preview.parsed.walMode && <p className="text-[.7rem] text-[var(--amber)]">This copy was taken while Firefox was running; bookmarks from the last few minutes may be missing. Close Firefox and copy places.sqlite again to include them.</p>}
          </div>

          {plan.folders.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-[.7rem] font-semibold text-[var(--dim)]">Folders — untick to leave out, or file a folder onto a shelf</div>
              <ul className="max-h-64 overflow-y-auto text-[.74rem]">
                {plan.folders.map(node => <FolderRow key={node.key} node={node} excluded={excluded} shelfFor={shelfFor} shelves={shelves} onToggle={toggleFolder} onShelf={setShelf} />)}
              </ul>
            </div>
          )}

          <div className="mt-3 grid gap-2 text-[.74rem] sm:grid-cols-2">
            {plan.folders.length > 0 && (
              <label className="flex items-center gap-2">Tags from folders
                <select className="input" style={{ width: "auto", padding: "2px 6px", fontSize: ".72rem" }} value={tagMode}
                  onChange={e => setTagMode(e.target.value as typeof tagMode)}>
                  <option value="none">None</option>
                  <option value="leaf">Folder name</option>
                  <option value="path">Full folder path</option>
                </select>
              </label>
            )}
            {preview.format !== "telegram" && (
              <label className="flex items-center gap-2">Show in Catch Up
                <select className="input" style={{ width: "auto", padding: "2px 6px", fontSize: ".72rem" }} value={importTriage}
                  onChange={e => setImportTriage(e.target.value as ImportTriage)} aria-label="Which imported bookmarks appear in Catch Up">
                  {(Object.keys(IMPORT_TRIAGE_LABELS) as ImportTriage[]).map(k => <option key={k} value={k}>{IMPORT_TRIAGE_LABELS[k]}</option>)}
                </select>
              </label>
            )}
            {plan.likelyDuplicates.length > 0 && (
              <label className="flex items-center gap-2 sm:col-span-2">
                <input type="checkbox" className="accent-[var(--accent)]" checked={includeDuplicates} onChange={e => setIncludeDuplicates(e.target.checked)} />
                Also import the {plan.likelyDuplicates.length} likely duplicates as separate links
              </label>
            )}
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button className="btn btn-primary" disabled={!selected.length && !plan.existing.length} onClick={commit}>
              Import {selected.length} new link{selected.length === 1 ? "" : "s"}
            </button>
            <button className="btn" onClick={reset}>Cancel</button>
          </div>
        </div>
      )}

      <details className="mt-3 text-[.74rem]">
        <summary className="flex cursor-pointer items-center gap-1 text-[var(--dim)]"><ChevronDown size={12} /> How to export bookmarks from your browser</summary>
        <table className="tbl mt-2 w-full text-[.72rem]">
          <thead><tr><th>Browser</th><th>Easiest</th><th>Or copy the file (close the browser first)</th></tr></thead>
          <tbody>
            {GUIDE.map(g => <tr key={g.browser}><td>{g.browser}</td><td>{g.easy}</td><td className="break-all text-[var(--dim)]">{g.file}</td></tr>)}
          </tbody>
        </table>
        <p className="mt-2 text-[var(--dim)]"><b>WhatsApp:</b> on your phone, open the chat (for example <i>Message yourself</i>, where
          you send links to keep) → ⋮ or the contact name → <b>Export chat</b> → <b>Without media</b>, then send the file to this
          computer and drop it here. Android makes a .txt, iPhone a .zip; both work. Previews are fetched afterwards, the same way
          WhatsApp makes its own.</p>
        <p className="mt-2 text-[var(--faint)]">Tip: paste a path into File Explorer's address bar, copy the file to your Desktop, then choose the copy. The app never reads live browser profiles.</p>
      </details>

      {recent.length > 0 && (
        <div className="mt-4 border-t border-[var(--border)] pt-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[.7rem] font-semibold text-[var(--dim)]"><History size={12} /> Recent imports</div>
          <ul className="space-y-1 text-[.72rem]">
            {recent.map(r => (
              <li key={r.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">
                  {new Date(r.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} · {r.fileName}
                  <span className="text-[var(--faint)]"> · {r.added} new{r.updated ? `, ${r.updated} already saved` : ""}{r.undone ? ` · undone (${r.undone.removed} removed)` : ""}</span>
                </span>
                {!r.undone && r.added > 0 && <button className="btn" style={{ padding: "1px 8px", fontSize: ".68rem" }} onClick={() => setUndoing(r)}><RotateCcw size={11} /> Undo</button>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {undoing && <UndoDialog record={undoing} onClose={text => { setUndoing(null); if (text) setMessage(text); }} />}
    </section>
  );
}
