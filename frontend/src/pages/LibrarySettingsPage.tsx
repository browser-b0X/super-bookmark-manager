import { useEffect, useRef, useState } from "react";
import { Camera, Database, FileJson, Link2, PlugZap, RefreshCw, Sparkles, Upload } from "lucide-react";
import { parseTelegramExport } from "../lib/telegram";
import { parseBookmarkHtml } from "../lib/bookmarks";
import { parseChromiumBookmarks } from "../lib/chromiumBookmarks";
import { parseFirefoxCopy } from "../lib/firefoxBookmarks";
import { backendAvailable } from "../lib/providers";
import { enrichSavedPost } from "../lib/metadataEnrichment";
import { useLibrary } from "../store/library";
import { syncLibrary } from "../lib/libraryPersistence";
import { importFilePosts } from "../lib/importCategorization";
import AddLinkDialog from "../components/library/AddLinkDialog";
import BackupRestore from "../components/library/BackupRestore";
import TelegramConfig from "../components/library/TelegramConfig";
import TelegramAccount from "../components/library/TelegramAccount";

/** Repoint posts holding expired Instagram CDN URLs at the locally cached copies. */
function repointIgThumbs(): number {
  let n = 0;
  const next = useLibrary.getState().posts.map(p => {
    const m = p.url.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]{5,})/);
    if (m && p.thumbnailUrl?.includes("cdninstagram.com")) {
      n++;
      return { ...p, thumbnailUrl: `/thumb/${m[1]}`, metadataStatus: "enriched" as const };
    }
    return p;
  });
  if (n) useLibrary.setState({ posts: next });
  return n;
}

export default function LibrarySettingsPage() {
  const posts = useLibrary(s => s.posts);
  const logActivity = useLibrary(s => s.logActivity);
  const [addLink, setAddLink] = useState(false);
  const [backend, setBackend] = useState<boolean | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importingTelegram, setImportingTelegram] = useState(false);
  const [bookmarkMsg, setBookmarkMsg] = useState<string | null>(null);
  const [importingBookmarks, setImportingBookmarks] = useState(false);
  const chromiumInput = useRef<HTMLInputElement>(null);
  const [chromiumMsg, setChromiumMsg] = useState<string | null>(null);
  const [importingChromium, setImportingChromium] = useState(false);
  const firefoxInput = useRef<HTMLInputElement>(null);
  const [firefoxMsg, setFirefoxMsg] = useState<string | null>(null);
  const [importingFirefox, setImportingFirefox] = useState(false);
  const [working, setWorking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);

  const refreshTelegram = async () => {
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      const response = await fetch("/api/telegram/refresh", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }), signal: AbortSignal.timeout(70000),
      });
      const data = await response.json();
      if (!response.ok || data.ok !== true) {
        setRefreshMsg(typeof data.error === "string" ? data.error : "Telegram refresh unavailable. Try again or import a JSON export.");
        return;
      }
      const result = data.checked === 0 ? null : parseTelegramExport(JSON.stringify(data.export));
      if (result?.errors.length) { setRefreshMsg(result.errors.join(" ")); return; }
      const { added, updated, skipped } = importFilePosts(result?.posts ?? [], { newOnly: true });
      setRefreshMsg(`Checked ${data.checked} messages (limit ${data.limit}) — ${added} new links, ${updated} already present, ${result?.duplicates ?? 0} duplicate occurrences, ${skipped} conflicts/deleted links skipped, ${result?.unsupported ?? 0} unsupported targets, ${result?.skipped ?? 0} linkless messages, ${data.malformed} malformed messages skipped.`
        + " Existing titles and curation were preserved. New links use local categorization. Check SQLite save status: pending links are only cached in this browser until saved.");
    } catch {
      setRefreshMsg("Could not finish Telegram refresh. Check the local server and connection, then retry. Check SQLite save status for any pending changes.");
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => { backendAvailable().then(setBackend); }, []);

  const onImportBookmarks = async (file: File) => {
    setImportingBookmarks(true);
    setBookmarkMsg(null);
    try {
      const result = parseBookmarkHtml(await file.text());
      if (result.error) {
        setBookmarkMsg(result.error);
        return;
      }
      const { added, updated, skipped } = importFilePosts(result.posts);
      setBookmarkMsg(`Bookmark import complete — ${added} new, ${updated} already present, ${result.duplicates} duplicate entries in this file, ${result.unsupported} unsupported-scheme entries skipped.`
        + (skipped ? ` ${skipped} conflicting entries skipped.` : "")
        + " Existing titles and curation were preserved. Check the SQLite save status below for durability.");
    } catch {
      setBookmarkMsg("Could not read or store this bookmark file. Check browser storage is available and try again.");
    } finally {
      setImportingBookmarks(false);
    }
  };

  const onImportChromium = async (file: File) => {
    setImportingChromium(true);
    setChromiumMsg(null);
    try {
      const result = parseChromiumBookmarks(await file.text());
      if (result.error) { setChromiumMsg(result.error); return; }
      const { added, updated, skipped } = importFilePosts(result.posts);
      setChromiumMsg(`Chromium import complete — ${result.posts.length} valid unique links found, ${added} new, ${updated} already present, ${result.duplicates} duplicate entries in this file, ${skipped} conflicts/deleted links skipped, ${result.unsupported} unsupported-scheme entries skipped.`
        + " Existing titles and curation were preserved. Check SQLite save status: pending changes are only cached in this browser.");
    } catch {
      setChromiumMsg("Could not read or import this file. Choose a copied/exported Bookmarks file instead of a locked live file, and check browser storage is available.");
    } finally { setImportingChromium(false); }
  };

  const onImportFirefox = async (file: File) => {
    setImportingFirefox(true);
    setFirefoxMsg(null);
    try {
      const result = await parseFirefoxCopy(file);
      const { added, updated, skipped } = importFilePosts(result.posts);
      setFirefoxMsg(`Firefox import complete — ${result.posts.length} valid unique bookmark URLs, ${added} new, ${updated} already present, ${result.duplicates} duplicate entries, ${result.unsupported} unsupported entries, 0 malformed entries, ${result.historyIgnored} history-only rows ignored, ${skipped} conflicts/deleted links skipped. Existing curation was preserved. Check SQLite save status for durability.`);
    } catch (error) {
      setFirefoxMsg(error instanceof Error ? error.message : "Could not import the Firefox copy. Check the local server and browser storage.");
    } finally { setImportingFirefox(false); }
  };

  const onImportFile = async (file: File) => {
    setImportMsg(null);
    setImportingTelegram(true);
    try {
      const result = parseTelegramExport(await file.text());
      if (result.errors.length) {
        setImportMsg(result.errors.join(" "));
        return;
      }
      const { added, updated, skipped } = importFilePosts(result.posts);
      setImportMsg(`Telegram import complete — ${added} new, ${updated} already present; ${result.messages} messages checked, ${result.skipped} without eligible links, ${result.duplicates} duplicate URLs, ${result.unsupported} unsupported/invalid targets, ${result.ignored} service messages skipped.`
        + (skipped ? ` ${skipped} conflicting entries skipped.` : "")
        + " Existing curation was preserved. Check the SQLite save status below for durability.");
    } catch {
      setImportMsg("Could not read or store this Telegram file. Check browser storage is available and try again.");
    } finally {
      setImportingTelegram(false);
    }
  };

  const resyncBackend = async () => {
    setWorking(true);
    const saved = await syncLibrary();
    setImportMsg(saved
      ? "Re-synced with SQLite. Imported links and curation are saved."
      : "SQLite sync failed. Unsaved changes remain pending in this browser; use Retry SQLite save.");
    setWorking(false);
  };

  const retryFailed = async () => {
    setWorking(true);
    const targets = posts.filter(p => p.metadataStatus !== "enriched" || !p.thumbnailUrl).slice(0, 30);
    for (const p of targets) await enrichSavedPost(p.id);
    logActivity("organize", `Retried metadata for ${targets.length} items`);
    setWorking(false);
    setImportMsg(`Retried enrichment for ${targets.length} item(s).`);
  };

  const repairIgThumbs = async () => {
    setWorking(true);
    try {
      const res = await fetch("/api/refresh-instagram-thumbs", { method: "POST" });
      if (!res.ok) throw new Error("backend unavailable");
      const { repaired } = await res.json();
      // Repoint local posts at the freshly cached copies.
      const n = repointIgThumbs();
      setImportMsg(`Repaired ${repaired} expired Instagram thumbnail(s) — ${n} updated in your library. They are now cached locally and won't expire.`);
    } catch {
      setImportMsg("Backend is not reachable — start the local server to repair thumbnails.");
    }
    setWorking(false);
  };

  const bulkCategorize = async () => {
    setWorking(true);
    try {
      const res = await fetch("/api/categorize/unprocessed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch_size: 2000, untagged: true }),
        signal: AbortSignal.timeout(1800000), // batches can take a while
      });
      if (!res.ok) throw new Error("backend unavailable");
      const { processed } = await res.json() as { processed: number };
      logActivity("organize", `Bulk-categorized ${processed} posts`);
      setImportMsg(processed
        ? `Bulk-categorized ${processed} post(s) via the LiteLLM chain (Groq → Gemini → Mistral → local). Run Re-sync from SQLite to pull the results into the library.`
        : "Nothing to categorize — every post in the database already has a category.");
    } catch {
      setImportMsg("Backend is not reachable — start the local server to bulk-categorize.");
    }
    setWorking(false);
  };

  const failedCount = posts.filter(p => p.metadataStatus !== "enriched" || !p.thumbnailUrl).length;

  return (
    <div className="mx-auto max-w-[720px] p-6">
      <h1 className="text-[1.15rem] font-bold">Library settings</h1>
      <p className="mt-1 text-[.8rem] text-[var(--dim)]">
        Imported links and curation save to local SQLite while the backend is available.
        Cached edits stay in this browser until SQLite confirms the save.
        File imports automatically use local keywords to assign existing shelves.
        Unmatched or unavailable results stay in other for review; manual choices always win.
      </p>

      <BackupRestore />
      <TelegramConfig />
      <TelegramAccount />

      <section className="panel mt-5 p-5" aria-labelledby="bookmark-import-heading">
        <h2 id="bookmark-import-heading" className="flex items-center gap-2 text-[.9rem] font-semibold"><Upload size={15} className="text-[var(--accent)]" /> Browser bookmarks</h2>
        <p className="mt-1.5 text-[.76rem] text-[var(--dim)]">
          Export bookmarks as HTML from Firefox's Library → Import and Backup → Export Bookmarks to HTML,
          or Chrome/Edge's Bookmarks/Favorites manager → Export bookmarks/favorites. Nested folders are included.
        </p>
        <p className="mt-2 text-[.72rem] text-[var(--faint)]">
          Imports HTTP(S) links and bookmark titles. Reimporting preserves your existing titles, categories,
          tags, notes, favorites and reading state. Check the SQLite save status for confirmed durability;
          pending changes are only cached in this browser. Keep your exported HTML file.
        </p>
        <label className="btn btn-primary mt-3 cursor-pointer">
          <Upload size={13} /> {importingBookmarks ? "Importing bookmarks…" : "Choose bookmarks HTML…"}
          <input type="file" accept=".html,.htm,text/html" className="hidden"
            aria-label="Import bookmarks HTML" disabled={importingBookmarks}
            onChange={e => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void onImportBookmarks(file);
            }} />
        </label>
        {bookmarkMsg && <p role="status" className="mt-3 rounded-lg border p-2.5 text-[.76rem]" style={{ borderColor: "var(--border-hi)", background: "var(--surface2)" }}>{bookmarkMsg}</p>}
        <div className="mt-4 border-t border-[var(--border)] pt-3">
          <p id="firefox-import-hint" className="text-[.76rem] text-[var(--dim)]">
            Select a copied Firefox <b>places.sqlite</b> file. Close Firefox or copy the database first. Only bookmarks are imported.
            Browsing history is ignored. Use a complete standalone copy made with Firefox closed; accompanying WAL files are not read.
            Renamed copies are accepted. Limits: 64 MiB and 50,000 bookmark entries; use HTML for larger exports.
          </p>
          <button className="btn mt-3 max-w-full whitespace-normal" disabled={importingFirefox}
            aria-describedby="firefox-import-hint" onClick={() => firefoxInput.current?.click()}>
            <Upload size={13} /> {importingFirefox ? "Importing Firefox copy…" : "Import Firefox bookmarks database copy"}
          </button>
          <input ref={firefoxInput} type="file" className="hidden" aria-label="Select copied Firefox places.sqlite"
            disabled={importingFirefox} onChange={e => {
              const file = e.target.files?.[0]; e.target.value = "";
              if (file) void onImportFirefox(file);
            }} />
          {firefoxMsg && <p role="status" aria-label="Firefox import result" className="mt-3 rounded-lg border p-2.5 text-[.76rem]"
            style={{ borderColor: "var(--border-hi)", background: "var(--surface2)" }}>{firefoxMsg}</p>}
        </div>
        <div className="mt-4 border-t border-[var(--border)] pt-3">
          <p id="chromium-import-hint" className="text-[.76rem] text-[var(--dim)]">
            Or select a copy of the Chromium-family <b>Bookmarks</b> JSON file (Chrome, Edge or Brave).
            The file may have no extension. Only your selected copy is read; no browser profiles are scanned,
            and the source file is never changed. Nested folders are included; folders do not become categories.
          </p>
          <button className="btn mt-3 max-w-full whitespace-normal" disabled={importingChromium}
            aria-describedby="chromium-import-hint" onClick={() => chromiumInput.current?.click()}>
            <Upload size={13} /> {importingChromium ? "Importing Chromium bookmarks…" : "Import Chromium Bookmarks file"}
          </button>
          <input ref={chromiumInput} type="file" className="hidden" aria-label="Select copied Chromium Bookmarks file"
            disabled={importingChromium} onChange={e => {
              const file = e.target.files?.[0]; e.target.value = "";
              if (file) void onImportChromium(file);
            }} />
          {chromiumMsg && <p role="status" aria-label="Chromium import result" className="mt-3 rounded-lg border p-2.5 text-[.76rem]"
            style={{ borderColor: "var(--border-hi)", background: "var(--surface2)" }}>{chromiumMsg}</p>}
        </div>
      </section>

      {/* Telegram import */}
      <section className="panel mt-5 p-5">
        <h2 className="flex items-center gap-2 text-[.9rem] font-semibold"><FileJson size={15} className="text-[var(--accent)]" /> Telegram import</h2>
        <p className="mt-1.5 text-[.76rem] text-[var(--dim)]">
          Import a Telegram Desktop export of <b>Saved Messages</b>. The importer is idempotent:
          re-running it never duplicates links, and your categories, tags, notes and statuses are never overwritten.
        </p>
        <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-[.72rem] text-[var(--faint)]">
          <li>Open <b>Saved Messages</b> in Telegram Desktop → chat menu → <b>Export chat history</b></li>
          <li>Choose <b>Machine-readable JSON</b> and the full date range</li>
          <li>Import that chat's <code>result.json</code> (top-level <code>messages</code> array). Whole-account archives are not supported.</li>
        </ol>
        <p className="mt-2 text-[.72rem] text-[var(--faint)]">
          All messages in the file are checked; there is no item limit. Only HTTP(S) links are imported.
          For repeated URLs, the first imported message's text and date are retained.
          New links fetch metadata in the background after SQLite saves and local categorization.
          Unavailable previews never block import; unsaved changes remain pending in this browser. Keep your export.
        </p>
        <label className="btn btn-primary mt-3 cursor-pointer">
          <Upload size={13} /> {importingTelegram ? "Importing Telegram…" : "Choose result.json…"}
          <input type="file" accept=".json,application/json" className="hidden"
            aria-label="Import Telegram JSON" disabled={importingTelegram}
            onChange={e => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void onImportFile(file);
            }} />
        </label>
        {importMsg && <p role="status" aria-label="Telegram import result" className="mt-3 rounded-lg border p-2.5 text-[.76rem]" style={{ borderColor: "var(--border-hi)", background: "var(--surface2)" }}>{importMsg}</p>}
        <div className="mt-4 border-t border-[var(--border)] pt-3">
          <p className="text-[.76rem] text-[var(--dim)]">
            Optional live refresh checks up to the most recent <b>200 Saved Messages</b> using your existing authorized session.
            A smaller positive MAX_MESSAGES server setting lowers this limit. Older history is not checked; use JSON import for it.
            Refresh runs only when requested, with no background sync or login prompts.
          </p>
          <button className="btn mt-3" onClick={() => void refreshTelegram()} disabled={refreshing}>
            <RefreshCw size={13} /> {refreshing ? "Checking Saved Messages…" : "Refresh Telegram Saved Messages"}
          </button>
          {refreshMsg && <p role="status" aria-label="Telegram refresh result" className="mt-3 rounded-lg border p-2.5 text-[.76rem]"
            style={{ borderColor: "var(--border-hi)", background: "var(--surface2)" }}>{refreshMsg}</p>}
        </div>
      </section>

      {/* manual add */}
      <section className="panel mt-4 p-5">
        <h2 className="flex items-center gap-2 text-[.9rem] font-semibold"><Link2 size={15} className="text-[var(--accent)]" /> Add a link manually</h2>
        <p className="mt-1.5 text-[.76rem] text-[var(--dim)]">Paste any URL — Instagram, X, YouTube, GitHub, Reddit, PDFs, articles.</p>
        <button className="btn mt-3" onClick={() => setAddLink(true)}><Link2 size={13} /> Add link</button>
      </section>

      {/* backend + enrichment */}
      <section className="panel mt-4 p-5">
        <h2 className="flex items-center gap-2 text-[.9rem] font-semibold"><PlugZap size={15} className="text-[var(--accent)]" /> Local backend &amp; enrichment</h2>
        <p className="mt-1.5 flex items-center gap-2 text-[.76rem]">
          <span className="dot" style={{ background: backend === null ? "var(--amber)" : backend ? "var(--green)" : "var(--red)" }} />
          {backend === null ? "Checking…" : backend ? "Flask backend online — rich metadata enrichment available." : "Backend offline — URL-derived fallback metadata is used."}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn" onClick={resyncBackend} disabled={working}>
            <Database size={13} /> Re-sync from SQLite
          </button>
          <button className="btn" onClick={retryFailed} disabled={working || failedCount === 0}>
            <RefreshCw size={13} className={working ? "animate-spin" : ""} /> Retry metadata ({failedCount})
          </button>
          <button className="btn" onClick={repairIgThumbs} disabled={working || backend !== true}
            title="Instagram CDN thumbnails expire; this re-caches them locally">
            <Camera size={13} /> Repair Instagram thumbnails
          </button>
          <button className="btn" onClick={bulkCategorize} disabled={working || backend !== true}
            title="Classify every uncategorized post in one sweep via Groq → Gemini → Mistral → local LLM">
            <Sparkles size={13} className={working ? "animate-pulse" : ""} /> Bulk categorize
          </button>
        </div>
        <p className="mt-3 text-[.66rem] text-[var(--faint)]">
          Providers: <code>local</code> (URL heuristics, always available) and <code>local-backend</code>
          (metadata_fetcher.py via <code>/api/enrich</code>, used when the server is running).
          Platform credentials can be added per-provider later without UI changes.
        </p>
      </section>

      {addLink && <AddLinkDialog onClose={() => setAddLink(false)} />}
    </div>
  );
}
