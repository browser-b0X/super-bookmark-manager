import { create } from "zustand";
import { parseTelegramExport } from "./telegram";
import { importFilePosts } from "./importCategorization";
import { usePrefs } from "../store/prefs";
import { useLibrary } from "../store/library";
import { syncLibrary } from "./libraryPersistence";
import { useLargeVideos } from "./largeVideos";

/**
 * Reading Saved Messages from the connected account: the Refresh button in
 * Settings, the optional check when the app starts and the optional timed check share this. The server
 * reads; the import here owns every library write, as for a JSON export.
 */

export interface MediaCounts {
  links: number; photos: number; videos: number; audio?: number; kept: number; skipped: number; failed: number;
  /** Large videos and audio downloading after the refresh ("Keep large videos and audio" on). */
  waiting?: number;
  /** Videos and audio over 50 MB left out with that switch off. */
  over?: number;
  /** Videos sent with a link that aren't MP4 files, and videos or audio over the 2 GB ceiling: never kept. */
  not_mp4?: number;
  too_big?: number;
  /** Files sent with a link that already keeps 10 files (from other messages too): not added. */
  not_added?: number;
}

export interface RefreshOutcome {
  ok: boolean;
  /** The full result line for Settings, or the server's error. */
  message: string;
  added: number;
  photos: number;
  videos: number;
  audio: number;
  /** Large videos and audio downloading in the background after this refresh. */
  waiting: number;
  /** The start-up check already ran in this app run (another tab, or a reload). */
  skipped?: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2 photos and 1 video", "1 photo, 1 video and 2 audio files", "" */
export function mediaPhrase(photos: number, videos: number, audio = 0): string {
  const parts = [photos ? plural(photos, "photo") : "", videos ? plural(videos, "video") : "", audio ? plural(audio, "audio file") : ""]
    .filter(Boolean);
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0] ?? "";
}

const count = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0);

/** `retry`: the Refresh button, which also tries large downloads that broke off earlier in this app run. */
export async function refreshTelegram(options: { startup?: boolean; retry?: boolean } = {}): Promise<RefreshOutcome> {
  const media = usePrefs.getState().telegramKeepMedia;
  const failed = (message: string): RefreshOutcome => ({ ok: false, message, added: 0, photos: 0, videos: 0, audio: 0, waiting: 0 });
  try {
    const response = await fetch("/api/telegram/refresh", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options.startup ? { confirm: true, media, startup: true }
        : { confirm: true, media, ...(options.retry ? { retry: true } : {}) }),
      // The read has 60 s and previews 20 s; photos and videos get up to 3 minutes more.
      signal: AbortSignal.timeout(media ? 300000 : 90000),
    });
    const data = await response.json();
    if (!response.ok || data.ok !== true) {
      return failed(typeof data.error === "string" ? data.error : "Telegram refresh unavailable. Try again or import a JSON export.");
    }
    if (data.skipped) return { ok: true, message: "", added: 0, photos: 0, videos: 0, audio: 0, waiting: 0, skipped: true };
    const result = data.checked === 0 ? null : parseTelegramExport(JSON.stringify(data.export));
    if (result?.errors.length) return failed(result.errors.join(" "));
    const { added, updated, skipped } = importFilePosts(result?.posts ?? [], { newOnly: true });
    const counts: MediaCounts | undefined = data.media;
    const photos = count(counts?.photos), videos = count(counts?.videos), audio = count(counts?.audio);
    const waiting = count(counts?.waiting), over = count(counts?.over), notMp4 = count(counts?.not_mp4), tooBig = count(counts?.too_big);
    const notAdded = count(counts?.not_added);
    const kept = mediaPhrase(photos, videos, audio);
    if (waiting) void useLargeVideos.getState().load();     // follow the download where it shows
    const message = `Checked ${plural(data.checked, "message")} (limit ${data.limit}) — ${plural(added, "new link")}, ${updated} already present, ${plural(result?.duplicates ?? 0, "duplicate occurrence")}, ${skipped} conflicts/deleted links skipped, ${plural(result?.unsupported ?? 0, "unsupported target")}, ${plural(result?.skipped ?? 0, "linkless message")}, ${plural(data.malformed, "malformed message")} skipped.`
      + (kept ? ` Kept ${kept} sent with your links.` : "")
      + (waiting ? ` ${plural(waiting, "large video or audio file", "large videos or audio files")} ${waiting === 1 ? "is" : "are"} downloading`
        + ` in the background; ${waiting === 1 ? "it shows" : "they show"} below.` : "")
      + (over ? ` ${plural(over, "video or audio file", "videos or audio files")} over 50 MB ${over === 1 ? "was" : "were"} left out;`
        + ` “Keep large videos and audio” in Saved copies keeps ${over === 1 ? "it" : "them"}.` : "")
      + (notMp4 ? ` ${plural(notMp4, "video")} sent with your links ${notMp4 === 1 ? "isn't an MP4 file, so it wasn't" : "aren't MP4 files, so they weren't"}`
        + " kept: SuperBookmarks keeps MP4 videos." : "")
      + (tooBig ? ` ${plural(tooBig, "video or audio file", "videos or audio files")} over 2 GB ${tooBig === 1 ? "was" : "were"} left out.` : "")
      + (notAdded ? ` ${plural(notAdded, "photo, video or audio file", "photos, videos or audio files")} sent with a link that already`
        + ` keeps 10 files ${notAdded === 1 ? "wasn't" : "weren't"} added.` : "")
      + (counts?.failed ? ` ${plural(counts.failed, "photo, video or audio file", "photos, videos or audio files")} couldn't be downloaded; Refresh tries again.` : "")
      + " Existing titles and curation were preserved. New links use local categorization. Check SQLite save status: pending links are only cached in this browser until saved.";
    return { ok: true, message, added, photos, videos, audio, waiting };
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

/** "Telegram: 1 new link from Saved Messages, with 2 photos; 1 large file downloading", or "" when nothing came. */
function foundNotice(outcome: RefreshOutcome): string {
  if (!outcome.added && !outcome.photos && !outcome.videos && !outcome.audio && !outcome.waiting) return "";
  const kept = mediaPhrase(outcome.photos, outcome.videos, outcome.audio);
  return `Telegram: ${outcome.added ? `${plural(outcome.added, "new link")} from Saved Messages` : "no new links"}${kept ? `, with ${kept}` : ""}`
    + (outcome.waiting ? `; ${plural(outcome.waiting, "large file")} downloading` : "");
}

/** The toast after a check at start: only when it found something, or could not run. */
export function startupNotice(outcome: RefreshOutcome): string {
  if (outcome.skipped) return "";
  if (!outcome.ok) return `Telegram check at start didn't run: ${outcome.message}`;
  return foundNotice(outcome);
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

/** When the timed check last ran (in any tab) and what it found; shared by the tabs through local storage. */
interface TimedCheck { lastAt?: number; added?: number; nextAt?: number }
export const useTimedTelegram = create<TimedCheck>(() => ({}));
const LAST_CHECK = "sbm-telegram-timed-check";

function readLast(): { at: number; added: number } | null {
  try {
    const value = JSON.parse(localStorage.getItem(LAST_CHECK) ?? "null");
    return value && Number.isFinite(value.at) && Number.isFinite(value.added) ? value : null;
  } catch { return null; }
}

function writeLast(at: number, added: number) {
  try { localStorage.setItem(LAST_CHECK, JSON.stringify({ at, added })); } catch { /* private window: this tab only */ }
  useTimedTelegram.setState({ lastAt: at, added });
}

/**
 * "Check again while the app is open": the same read as the Refresh button, every 30 minutes, hour or
 * 3 hours while a tab of the app is open. Nothing runs while it is closed. The tabs share the time of
 * the last check, so two open tabs don't both check. A note appears only when new links arrive, or once
 * when a check can't run (until one works again). Returns a function that stops it.
 */
export function startTimedTelegramRefresh(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let since = Date.now();          // first check one interval after the app opens or the switch goes on
  let failing = false;
  let running = false;
  const every = () => usePrefs.getState().telegramCheckMinutes * 60_000;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const last = readLast();
    useTimedTelegram.setState({ lastAt: last?.at, added: last?.added });
    if (!usePrefs.getState().telegramTimedCheck) { useTimedTelegram.setState({ nextAt: undefined }); return; }
    const due = Math.max(last?.at ?? 0, since) + every();
    useTimedTelegram.setState({ nextAt: due });
    timer = setTimeout(() => { void run(); }, Math.max(1000, due - Date.now()));
  };
  const run = async () => {
    timer = undefined;
    const last = readLast();
    // Another tab checked meanwhile: wait for the next turn.
    if (running || !usePrefs.getState().telegramTimedCheck || (last && Date.now() - last.at < every() * 0.9)) { schedule(); return; }
    running = true;
    writeLast(Date.now(), 0);      // claim this turn before the read, which can take a minute
    try {
      // Import against the library SQLite holds, never a half-loaded one.
      if (await syncLibrary() && !useLibrary.getState().demo) {
        const outcome = await refreshTelegram();
        writeLast(Date.now(), outcome.added);
        if (!outcome.ok) {
          if (!failing) useNotice.getState().show(`Telegram check didn't run: ${outcome.message}`, "warn");
          failing = true;
        } else {
          failing = false;
          const found = foundNotice(outcome);
          if (found) useNotice.getState().show(found);
        }
      }
    } finally {
      running = false;
      schedule();
    }
  };
  const onStorage = (event: StorageEvent) => { if (event.key === LAST_CHECK) schedule(); };
  addEventListener("storage", onStorage);
  const stopPrefs = usePrefs.subscribe((state, previous) => {
    if (state.telegramTimedCheck === previous.telegramTimedCheck && state.telegramCheckMinutes === previous.telegramCheckMinutes) return;
    if (state.telegramTimedCheck && !previous.telegramTimedCheck) since = Date.now();
    schedule();
  });
  schedule();
  return () => {
    if (timer) clearTimeout(timer);
    removeEventListener("storage", onStorage);
    stopPrefs();
  };
}
