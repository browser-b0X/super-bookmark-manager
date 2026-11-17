import { useLargeVideos, useWatchLargeVideos } from "../../lib/largeVideos";
import { formatBytes } from "../../lib/savedCopies";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const size = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : formatBytes(bytes) || "0 KB");

/** Why a large file from Telegram wasn't kept (telegram_refresh.py's reasons), in words. */
export function largeReason(reason: string): string {
  switch (reason) {
    case "no_space": return "there wasn't room for it and 512 MB to spare";
    case "slow": return "the download stalled or was too slow";
    case "too_large": return "it was bigger than Telegram said";
    case "gone": return "it is no longer in Saved Messages";
    case "busy": return "Telegram was busy with another step";
    case "rejected": return "it isn't a video or audio file the app can keep";
    default: return "Telegram didn't send it";
  }
}

/** What came of the last download, once it has ended. Files not kept are counted from the total, so a download
 * that broke off counts the ones it never reached too. */
function outcome({ total, kept, reason }: { total: number; kept: number; reason: string }): string {
  if (reason === "stopped") {
    return `Stopped${kept ? ` after keeping ${plural(kept, "large file")}` : ""}. What was stopped is tried again when SuperBookmarks starts again.`;
  }
  if (kept >= total) return `Kept ${plural(kept, "large video or audio file", "large videos and audio files")} from Telegram.`;
  const left = total - kept;
  const again = reason === "rejected" || reason === "gone" ? "" : " Refresh tries again.";
  if (!kept) return `${total === 1 ? "The large file" : "The large files"} from Telegram ${total === 1 ? "wasn't" : "weren't"} kept: ${largeReason(reason)}.${again}`;
  return `Kept ${kept} of ${plural(total, "large file")} from Telegram; ${left === 1 ? "1 wasn't" : `${left} weren't`} kept: ${largeReason(reason)}.${again}`;
}

/**
 * Under the Telegram refresh: large videos and audio downloading in the background after a refresh, with how far
 * the current one got and Stop, then what came of it. Nothing shows before a download has run in this app run.
 */
export default function TelegramLargeDownload() {
  useWatchLargeVideos();
  const download = useLargeVideos(s => s.state?.telegram);
  const stop = useLargeVideos(s => s.stop);
  if (!download || (!download.running && !download.total)) return null;
  if (!download.running) {
    return <p role="status" aria-label="Large files from Telegram" className="mt-3 text-[.72rem] text-[var(--dim)]">{outcome(download)}</p>;
  }
  const share = download.size ? Math.min(100, Math.round((download.received / download.size) * 100)) : 0;
  return (
    <div role="status" aria-label="Large files from Telegram" className="mt-3">
      <div className="flex items-center gap-2 text-[.72rem] text-[var(--dim)]">
        <div className="h-1 flex-1 overflow-hidden rounded-full" style={{ background: "var(--surface2)" }} aria-hidden="true">
          <div className="h-full rounded-full" style={{ width: `${share}%`, background: "var(--accent)", transition: "width .2s var(--ease)" }} />
        </div>
        <span className="shrink-0">
          Downloading a large file from Telegram{download.size ? ` · ${size(download.received)} of ${size(download.size)}` : ""}
          {" · "}{Math.min(download.done + 1, download.total)} of {download.total}
        </span>
        <button type="button" className="btn shrink-0" style={{ padding: "2px 10px", fontSize: ".72rem" }} onClick={() => void stop()}>Stop</button>
      </div>
      <p className="mt-1 text-[.7rem] text-[var(--faint)]">
        The links are already in your library. Refreshing and Disconnect wait until this finishes or you stop it.
      </p>
    </div>
  );
}
