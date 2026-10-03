import { useEffect, useRef, useState } from "react";
import { Archive, Database, FileJson, Link2, PlugZap, RefreshCw, Sparkles, Upload } from "lucide-react";
import { parseTelegramExport } from "../lib/telegram";
import { parseBookmarkHtml } from "../lib/bookmarks";
import { parseChromiumBookmarks } from "../lib/chromiumBookmarks";
import { parseFirefoxCopy } from "../lib/firefoxBookmarks";
import { backendAvailable } from "../lib/providers";
import { enrichMany } from "../lib/metadataEnrichment";
import { useLibrary } from "../store/library";
import { importFilePosts } from "../lib/importCategorization";
import AddLinkDialog from "../components/library/AddLinkDialog";
import BackupRestore from "../components/library/BackupRestore";
import TelegramConfig from "../components/library/TelegramConfig";
import TelegramAccount from "../components/library/TelegramAccount";
import { usePrefs, type ImportTriage } from "../store/prefs";
import { applyImportTriage, IMPORT_TRIAGE_LABELS } from "../lib/importTriage";
import type { SavedPost } from "../types";
import BookmarkImport from "../components/library/BookmarkImport";
import UnsavedChanges from "../components/library/UnsavedChanges";
import RuntimeControl from "../components/library/RuntimeControl";
import SyncPanel from "../components/library/SyncPanel";
import AiProviders from "../components/library/AiProviders";
import AiReview from "../components/library/AiReview";
import EnrichmentProgress from "../components/library/EnrichmentProgress";
import { SettingsGroup, SettingsNav } from "../components/library/SettingsLayout";

const needsPreview = (p: SavedPost) => p.metadataStatus !== "none" && p.linkStatus !== "gone"
  && (p.metadataStatus !== "enriched" || !p.thumbnailUrl);

const triageNote = (filed: number) => filed
  ? ` ${filed} older bookmark${filed === 1 ? "" : "s"} went straight to the library instead of Catch Up.` : "";

export default function LibrarySettingsPage() {
  const posts = useLibrary(s => s.posts);
  const logActivity = useLibrary(s => s.logActivity);
  const importTriage = usePrefs(s => s.importTriage);
  const setImportTriage = usePrefs(s => s.setImportTriage);
  const [addLink, setAddLink] = useState(false);
  const [telegramConfigRevision, setTelegramConfigRevision] = useState(0);
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
  const [toolsMsg, setToolsMsg] = useState<string | null>(null);
  const [aiReady, setAiReady] = useState(false);
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
      const triaged = applyImportTriage(result.posts, usePrefs.getState().importTriage);
      const { added, updated, skipped } = importFilePosts(triaged.posts);
      setBookmarkMsg(`Bookmark import complete — ${added} new, ${updated} already present, ${result.duplicates} duplicate entries in this file, ${result.unsupported} unsupported-scheme entries skipped.`
        + (result.malformed ? ` ${result.malformed} malformed entries skipped.` : "")
        + (skipped ? ` ${skipped} conflicting entries skipped.` : "")
        + triageNote(triaged.filed)
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
      const triaged = applyImportTriage(result.posts, usePrefs.getState().importTriage);
      const { added, updated, skipped } = importFilePosts(triaged.posts);
      setChromiumMsg(`Chromium import complete — ${result.posts.length} valid unique links found, ${added} new, ${updated} already present, ${result.duplicates} duplicate entries in this file, ${skipped} conflicts/deleted links skipped, ${result.unsupported} unsupported-scheme entries skipped.`
        + (result.malformed ? ` ${result.malformed} malformed entries skipped.` : "")
        + triageNote(triaged.filed)
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
      const triaged = applyImportTriage(result.posts, usePrefs.getState().importTriage);
      const { added, updated, skipped } = importFilePosts(triaged.posts);
      setFirefoxMsg(`Firefox import complete — ${result.posts.length} valid unique bookmark URLs, ${added} new, ${updated} already present, ${result.duplicates} duplicate entries, ${result.unsupported} unsupported entries, ${result.malformed} malformed entries, ${result.historyIgnored} history-only rows ignored, ${skipped} conflicts/deleted links skipped.`
        + triageNote(triaged.filed)
        + " Existing curation was preserved. Check SQLite save status for durability."
        + (result.walMode ? " This copy was taken while Firefox was running, so bookmarks added in the last few minutes may be missing — close Firefox, copy places.sqlite again and re-import to pick them up." : ""));
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

  const retryFailed = () => {
    // Everything that could still improve, queued in the background with progress.
    const targets = posts.filter(needsPreview);
    void enrichMany(targets.map(p => p.id), { force: true });
    logActivity("organize", `Queued metadata for ${targets.length} items`);
    setToolsMsg(`Fetching previews for ${targets.length} item(s) in the background — progress shows in the sidebar.`);
  };

  // Sites with no preview at all ("none") and gone links are not counted: retrying cannot help.
  const failedCount = posts.filter(needsPreview).length;
  const goneCount = posts.filter(p => p.linkStatus === "gone" && p.status !== "archived").length;
  const archiveGone = () => {
    const ids = posts.filter(p => p.linkStatus === "gone" && p.status !== "archived").map(p => p.id);
    useLibrary.getState().bulkPatch(ids, { status: "archived" });
    logActivity("organize", `Archived ${ids.length} gone links`);
    setToolsMsg(`Archived ${ids.length} link${ids.length === 1 ? "" : "s"} whose pages no longer exist. They stay searchable (is:gone).`);
  };

  return (
    <div className="settings-layout">
      <SettingsNav />
      <div className="min-w-0">
        <h1 className="text-[1.15rem] font-bold">Settings</h1>
        <p className="mt-1 text-[.8rem] text-[var(--dim)]">
          Everything is stored on this computer: links and curation in a local SQLite database, keys and Telegram
          credentials in your user profile. Manual choices always win over automatic ones.
        </p>

        <SettingsGroup id="sources" title="Sources" icon={<Upload size={16} />}
          intro="Bring links in from browsers, Telegram Saved Messages or by hand.">
          <BookmarkImport />
      <section className="panel p-5" aria-labelledby="bookmark-import-heading">
        <h3 id="bookmark-import-heading" className="flex items-center gap-2 text-[.9rem] font-semibold"><Upload size={15} className="text-[var(--accent)]" /> Other import formats</h3>
        <p className="mt-1 text-[.72rem] text-[var(--faint)]">These buttons import straight away, without the preview above.</p>
        <p className="mt-1.5 text-[.76rem] text-[var(--dim)]">
          Export bookmarks as HTML from Firefox's Library → Import and Backup → Export Bookmarks to HTML,
          or Chrome/Edge's Bookmarks/Favorites manager → Export bookmarks/favorites. Nested folders are included.
        </p>
        <p className="mt-2 text-[.72rem] text-[var(--faint)]">
          Imports HTTP(S) links and bookmark titles. Reimporting preserves your existing titles, categories,
          tags, notes, favorites and reading state. Check the SQLite save status for confirmed durability;
          pending changes are only cached in this browser. Keep your exported HTML file.
        </p>
        <label className="mt-3 flex flex-wrap items-center gap-2 text-[.76rem] text-[var(--dim)]">
          Show in Catch Up:
          <select className="input" style={{ width: "auto", padding: "3px 8px", fontSize: ".74rem" }}
            value={importTriage} onChange={e => setImportTriage(e.target.value as ImportTriage)}
            aria-label="Which imported bookmarks appear in Catch Up">
            {(Object.keys(IMPORT_TRIAGE_LABELS) as ImportTriage[]).map(k => <option key={k} value={k}>{IMPORT_TRIAGE_LABELS[k]}</option>)}
          </select>
          <span className="text-[var(--faint)]">Older bookmarks are filed in the library as already seen.</span>
        </label>
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
            and the source file is never changed. Nested folders are kept on each link; folders do not become categories.
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
          <TelegramConfig onConfigurationChanged={() => setTelegramConfigRevision(revision => revision + 1)} />
          {/* Reload account status and discard transient login inputs after a confirmed credential change. */}
          <TelegramAccount key={telegramConfigRevision} />
      <section className="panel p-5">
        <h3 className="flex items-center gap-2 text-[.9rem] font-semibold"><FileJson size={15} className="text-[var(--accent)]" /> Telegram import</h3>
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
      <section className="panel p-5">
        <h3 className="flex items-center gap-2 text-[.9rem] font-semibold"><Link2 size={15} className="text-[var(--accent)]" /> Add a link manually</h3>
        <p className="mt-1.5 text-[.76rem] text-[var(--dim)]">Paste any URL — Instagram, X, YouTube, GitHub, Reddit, PDFs, articles.</p>
        <button className="btn mt-3" onClick={() => setAddLink(true)}><Link2 size={13} /> Add link</button>
      </section>
        </SettingsGroup>

        <SettingsGroup id="ai" title="AI & previews" icon={<Sparkles size={16} />}
          intro="Thumbnails, titles and shelves for your feed.">
          <AiProviders onChange={status => setAiReady(status.available)} />
          <AiReview aiReady={aiReady} />
      <section className="panel p-5">
        <h3 className="flex items-center gap-2 text-[.9rem] font-semibold"><PlugZap size={15} className="text-[var(--accent)]" /> Previews &amp; thumbnails</h3>
        <p className="mt-1.5 flex items-center gap-2 text-[.76rem]">
          <span className="dot" style={{ background: backend === null ? "var(--amber)" : backend ? "var(--green)" : "var(--red)" }} />
          {backend === null ? "Checking…" : backend ? "Flask backend online — rich metadata enrichment available." : "Backend offline — URL-derived fallback metadata is used."}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn" onClick={retryFailed} disabled={failedCount === 0}>
            <RefreshCw size={13} /> Fetch missing previews ({failedCount})
          </button>
          {goneCount > 0 && (
            <button className="btn" onClick={archiveGone} title="Pages that answered 404/410 no longer exist at their address">
              <Archive size={13} /> Archive {goneCount} gone link{goneCount === 1 ? "" : "s"}
            </button>
          )}
        </div>
        <EnrichmentProgress />
        {toolsMsg && <p role="status" aria-label="Library tools result" className="mt-3 rounded-lg border p-2.5 text-[.76rem]" style={{ borderColor: "var(--border-hi)", background: "var(--surface2)" }}>{toolsMsg}</p>}
        <p className="mt-3 text-[.66rem] text-[var(--faint)]">
          Previews come from each page's own metadata, fetched by the local server. Telegram's link previews supply
          Instagram images; when a site blocks previews the feed shows a styled caption card instead.
        </p>
      </section>
        </SettingsGroup>

        <SettingsGroup id="library" title="Library & sync" icon={<Database size={16} />}
          intro="Where your library is saved, and the local server that saves it.">
          <SyncPanel />
          <UnsavedChanges />
          <RuntimeControl />
        </SettingsGroup>

        <SettingsGroup id="backup" title="Backup" icon={<Archive size={16} />}
          intro="Copies of the whole library you can restore from.">
          <BackupRestore />
        </SettingsGroup>
      </div>

      {addLink && <AddLinkDialog onClose={() => setAddLink(false)} />}
    </div>
  );
}
