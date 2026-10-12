import { create } from "zustand";
import { parseTelegramExport } from "./telegram";
import { importFilePosts } from "./importCategorization";
import { usePrefs } from "../store/prefs";
import { useLibrary } from "../store/library";
import { syncLibrary } from "./libraryPersistence";

/**
 * Reading Saved Messages from the connected account: the Refresh button in
 * Settings and the optional check when the app starts share this. The server
 * reads; the import here owns every library write, as for a JSON export.
 */

export interface MediaCounts { links: number; photos: number; videos: number; kept: number; skipped: number; failed: number }

export interface RefreshOutcome {
  ok: boolean;
  /** The full result line for Settings, or the server's error. */
  message: string;
  added: number;
  photos: number;
  videos: number;
  /** The start-up check already ran in this app run (another tab, or a reload). */
  skipped?: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2 photos and 1 video", "1 photo", "" */
export function mediaPhrase(photos: number, videos: number): string {
  return [photos ? plural(photos, "photo") : "", videos ? plural(videos, "video") : ""].filter(Boolean).join(" and ");
}

export async function refreshTelegram(options: { startup?: boolean } = {}): Promise<RefreshOutcome> {
  const media = usePrefs.getState().telegramKeepMedia;
  const failed = (message: string): RefreshOutcome => ({ ok: false, message, added: 0, photos: 0, videos: 0 });
  try {
    const response = await fetch("/api/telegram/refresh", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options.startup ? { confirm: true, media, startup: true } : { confirm: true, media }),
      // The read has 60 s and previews 20 s; photos and videos get up to 3 minutes more.
      signal: AbortSignal.timeout(media ? 300000 : 90000),
    });
    const data = await response.json();
    if (!response.ok || data.ok !== true) {
      return failed(typeof data.error === "string" ? data.error : "Telegram refresh unavailable. Try again or import a JSON export.");
    }
    if (data.skipped) return { ok: true, message: "", added: 0, photos: 0, videos: 0, skipped: true };
    const result = data.checked === 0 ? null : parseTelegramExport(JSON.stringify(data.export));
    if (result?.errors.length) return failed(result.errors.join(" "));
    const { added, updated, skipped } = importFilePosts(result?.posts ?? [], { newOnly: true });
    const counts: MediaCounts | undefined = data.media;
    const photos = counts?.photos ?? 0, videos = counts?.videos ?? 0;
    const kept = mediaPhrase(photos, videos);
    const message = `Checked ${plural(data.checked, "message")} (limit ${data.limit}) — ${plural(added, "new link")}, ${updated} already present, ${plural(result?.duplicates ?? 0, "duplicate occurrence")}, ${skipped} conflicts/deleted links skipped, ${plural(result?.unsupported ?? 0, "unsupported target")}, ${plural(result?.skipped ?? 0, "linkless message")}, ${plural(data.malformed, "malformed message")} skipped.`
      + (kept ? ` Kept ${kept} sent with your links.` : "")
      + (counts?.failed ? ` ${plural(counts.failed, "photo or video", "photos or videos")} couldn't be downloaded; Refresh tries again.` : "")
      + " Existing titles and curation were preserved. New links use local categorization. Check SQLite save status: pending links are only cached in this browser until saved.";
    return { ok: true, message, added, photos, videos };
  } catch {
    return failed("Could not finish Telegram refresh. Check the local server and connection, then retry. Check SQLite save status for any pending changes.");
  }
}

/** A short line that floats above the save status for a few seconds. */
interface NoticeState { text: string; tone: "ok" | "warn"; id: number; show(text: string, tone?: "ok" | "warn"): void; clear(): void }
export const useNotice = create<NoticeState>(set => ({
  text: "", tone: "ok", id: 0,
  show(text, tone = "ok") { set(s => ({ text, tone, id: s.id + 1 })); },
  clear() { set({ text: "" }); },
}));

/** The toast after a check at start: only when it found something, or could not run. */
export function startupNotice(outcome: RefreshOutcome): string {
  if (outcome.skipped) return "";
  if (!outcome.ok) return `Telegram check at start didn't run: ${outcome.message}`;
  if (!outcome.added && !outcome.photos && !outcome.videos) return "";
  const kept = mediaPhrase(outcome.photos, outcome.videos);
  return `Telegram: ${outcome.added ? `${plural(outcome.added, "new link")} from Saved Messages` : "no new links"}${kept ? `, with ${kept}` : ""}`;
}

let started = false;
/** "Check when the app starts": once per page load here, once per app run on the server. */
export function checkTelegramAtStart() {
  // Decided once, when the app opens: turning the switch on later never starts a check mid-session.
  if (started) return;
  started = true;
  if (!usePrefs.getState().telegramCheckOnStart) return;
  void (async () => {
    // Import against the library SQLite holds, never a half-loaded one.
    if (!await syncLibrary() || useLibrary.getState().demo) return;
    const outcome = await refreshTelegram({ startup: true });
    const text = startupNotice(outcome);
    if (text) useNotice.getState().show(text, outcome.ok ? "ok" : "warn");
  })();
}
