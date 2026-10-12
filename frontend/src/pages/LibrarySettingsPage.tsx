import { type ReactNode, useState } from "react";
import { Archive, Database, FileJson, Link2, Palette, RefreshCw, Send, Sparkles, Upload } from "lucide-react";
import { parseTelegramExport } from "../lib/telegram";
import { refreshTelegram } from "../lib/telegramRefresh";
import { usePrefs } from "../store/prefs";
import { useCopyAvailability } from "../lib/copyAvailability";
import { importFilePosts } from "../lib/importCategorization";
import AddLinkDialog from "../components/library/AddLinkDialog";
import BackupRestore from "../components/library/BackupRestore";
import TelegramConfig from "../components/library/TelegramConfig";
import TelegramAccount from "../components/library/TelegramAccount";
import BookmarkImport from "../components/library/BookmarkImport";
import UnsavedChanges from "../components/library/UnsavedChanges";
import RuntimeControl from "../components/library/RuntimeControl";
import SyncPanel from "../components/library/SyncPanel";
import SavedCopiesSettings from "../components/library/SavedCopiesSettings";
import AiProviders from "../components/library/AiProviders";
import AiReview from "../components/library/AiReview";
import PreviewTools from "../components/library/PreviewTools";
import { SettingsGroup, SettingsNav } from "../components/library/SettingsLayout";
import SaveFromBrowserCard from "../components/library/SaveFromBrowserCard";
import AppearanceSettings from "../components/library/AppearanceSettings";

export default function LibrarySettingsPage() {
  const [addLink, setAddLink] = useState(false);
  const [telegramConfigRevision, setTelegramConfigRevision] = useState(0);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importingTelegram, setImportingTelegram] = useState(false);
  const [aiReady, setAiReady] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const checkOnStart = usePrefs(s => s.telegramCheckOnStart);
  const keepMedia = usePrefs(s => s.telegramKeepMedia);
  const copiesOn = useCopyAvailability(s => s.enabled);

  const runRefresh = async () => {
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      setRefreshMsg((await refreshTelegram()).message);
    } finally {
      setRefreshing(false);
    }
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
          <SaveFromBrowserCard />
          <BookmarkImport />
          <TelegramConfig onConfigurationChanged={() => setTelegramConfigRevision(revision => revision + 1)} />
          {/* Reload account status and discard transient login inputs after a confirmed credential change. */}
          <TelegramAccount key={telegramConfigRevision} />
      <section className="panel p-5" aria-labelledby="telegram-import-heading">
        <h3 id="telegram-import-heading" className="flex items-center gap-2 text-[.9rem] font-semibold"><Send size={15} className="text-[var(--accent)]" /> Telegram Saved Messages</h3>
        <p className="mt-1.5 text-[.76rem] text-[var(--dim)]">
          Bring in the links you sent yourself. Nothing is ever duplicated, and your shelves, tags, notes and statuses are never overwritten.
        </p>
        <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface2)] p-3.5">
          <div className="text-[.8rem] font-semibold">Automatic: refresh from your Telegram account</div>
          <p className="mt-1 text-[.74rem] text-[var(--dim)]">
            Checks your most recent <b>200 Saved Messages</b> with the account connected above. It runs when you click it, or once at
            start if you turn that on below: no background sync and no login prompts.
          </p>
          <button className="btn btn-primary mt-2.5" onClick={() => void runRefresh()} disabled={refreshing}>
            <RefreshCw size={13} /> {refreshing ? "Checking Saved Messages…" : "Refresh Telegram Saved Messages"}
          </button>
          {refreshMsg && <p role="status" aria-label="Telegram refresh result" className="mt-3 rounded-lg border p-2.5 text-[.76rem]"
            style={{ borderColor: "var(--border-hi)", background: "var(--surface)" }}>{refreshMsg}</p>}
          <div className="tg-switches mt-3.5 space-y-3 border-t border-[var(--border)] pt-3.5">
            <TelegramSwitch label="Check when the app starts" on={checkOnStart} onChange={usePrefs.getState().setTelegramCheckOnStart}>
              Looks for new Saved Messages once each time SuperBookmarks opens, with the account connected above.
              Off until you turn it on; no checks while the app is open.
            </TelegramSwitch>
            {copiesOn && <TelegramSwitch label="Keep photos and videos sent with your links" on={keepMedia} onChange={usePrefs.getState().setTelegramKeepMedia}>
              When a Saved Message has a link plus photos or a video, they are kept with that link's saved copy,
              downloaded from your own account. Videos up to 50 MB; nothing is kept for messages without a link.
            </TelegramSwitch>}
          </div>
        </div>
        <div className="mt-3 rounded-xl border border-dashed border-[var(--border-hi)] p-3.5">
          <div className="text-[.8rem] font-semibold">Manual: import an export <span className="font-normal text-[var(--faint)]">· for older messages, or without a connected account</span></div>
          <ol className="mt-1.5 list-decimal space-y-0.5 pl-5 text-[.72rem] text-[var(--faint)]">
            <li>Open <b>Saved Messages</b> in Telegram Desktop → chat menu → <b>Export chat history</b></li>
            <li>Choose <b>Machine-readable JSON</b> and the full date range</li>
            <li>Choose that chat's <code>result.json</code> here. Whole-account archives are not supported.</li>
          </ol>
          <label className="btn mt-2.5 cursor-pointer">
            <FileJson size={13} /> {importingTelegram ? "Importing Telegram…" : "Choose result.json…"}
            <input type="file" accept=".json,application/json" className="hidden"
              aria-label="Import Telegram JSON" disabled={importingTelegram}
              onChange={e => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void onImportFile(file);
              }} />
          </label>
          <p className="mt-2 text-[.7rem] text-[var(--faint)]">
            Every message in the file is checked. For a repeated link, the first message's text and date are kept. Keep your export.
          </p>
          {importMsg && <p role="status" aria-label="Telegram import result" className="mt-3 rounded-lg border p-2.5 text-[.76rem]" style={{ borderColor: "var(--border-hi)", background: "var(--surface2)" }}>{importMsg}</p>}
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
          <PreviewTools />
        </SettingsGroup>

        <SettingsGroup id="library" title="Library & sync" icon={<Database size={16} />}
          intro="Where your library is saved, and the local server that saves it.">
          <SavedCopiesSettings />
          <SyncPanel />
          <UnsavedChanges />
          <RuntimeControl />
        </SettingsGroup>

        <SettingsGroup id="backup" title="Backup" icon={<Archive size={16} />}
          intro="Copies of the whole library you can restore from.">
          <BackupRestore />
        </SettingsGroup>

        <SettingsGroup id="appearance" title="Appearance" icon={<Palette size={16} />}
          intro="Theme and Home layout. Only how the app looks; your links are not changed.">
          <AppearanceSettings />
        </SettingsGroup>
      </div>

      {addLink && <AddLinkDialog onClose={() => setAddLink(false)} />}
    </div>
  );
}

function TelegramSwitch({ label, on, onChange, children }: { label: string; on: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <button type="button" role="switch" aria-checked={on} aria-label={label} className="switch mt-0.5" onClick={() => onChange(!on)} />
      <div className="min-w-0">
        <div className="text-[.8rem] font-semibold">{label}</div>
        <p className="mt-0.5 text-[.72rem] text-[var(--dim)]">{children}</p>
      </div>
    </div>
  );
}
