import { useEffect, useState } from "react";
import { FileCheck, FileDown, Pause, Play } from "lucide-react";
import { useLibrary } from "../../store/library";
import { usePrefs } from "../../store/prefs";
import { useCopyAvailability } from "../../lib/copyAvailability";
import { canStillCopy, formatBytes, saveCopies, setCopiesPaused, useCopyQueue } from "../../lib/savedCopies";
import { checkLostCopies, hasCopy, useLostCopies } from "../../lib/lostCopies";
import { useLargeVideos, useWatchLargeVideos } from "../../lib/largeVideos";
import SocialPostsSettings from "./SocialPostsSettings";

interface Summary { count: number; bytes: number }

/** How many copies there are and how much disk they use, straight from the server. */
export function useCopySummary(refreshKey: unknown = 0): Summary | null {
  const [summary, setSummary] = useState<Summary | null>(null);
  useEffect(() => {
    let current = true;
    fetch("/api/archive", { cache: "no-store" }).then(r => (r.ok ? r.json() : null))
      .then(d => { if (current && Number.isSafeInteger(d?.count) && Number.isSafeInteger(d?.bytes)) setSummary({ count: d.count, bytes: d.bytes }); })
      .catch(() => {});
    return () => { current = false; };
  }, [refreshKey]);
  return summary;
}

/** Settings → Library & sync: the auto-save switch and what the copies take up. */
export default function SavedCopiesSettings() {
  // "Keep large videos and audio": X videos, and Telegram videos and audio, over the 50 MB cap, up to a 2 GB
  // ceiling, streamed to disk (archive.py, telegram_refresh.py).
  useWatchLargeVideos();
  const largeVideos = useLargeVideos();
  const enabled = useCopyAvailability(s => s.enabled);
  const autoSave = usePrefs(s => s.autoSaveCopies);
  const setAutoSave = usePrefs(s => s.setAutoSaveCopies);
  const queue = useCopyQueue();
  const posts = useLibrary(s => s.posts);
  // Copies the links say they have but this computer hasn't (after restoring a JSON backup).
  // Asked again when the number of links with a copy changes: the library may still be loading.
  const lost = useLostCopies(s => s.keys);
  const withKey = posts.reduce((n, p) => n + (p.archiveStatus === "saved" && p.archiveKey ? 1 : 0), 0);
  useEffect(() => { if (enabled) void checkLostCopies(useLibrary.getState().posts); }, [withKey, enabled]);
  const without = posts.filter(p => !hasCopy(p, lost)).length;
  // Links a try could still help: not saved, not under way, not refused for good.
  const eligible = posts.filter(canStillCopy).map(p => p.id);
  const [confirming, setConfirming] = useState(false);
  // Ask again whenever a copy finishes or the queue empties.
  const summary = useCopySummary(`${queue.done}/${queue.total}`);
  const working = queue.total > 0 && queue.done < queue.total;
  const cap = largeVideos.state ? Math.round(largeVideos.state.cap / (1024 * 1024)) : 50;
  const limit = largeVideos.state ? Math.round(largeVideos.state.limit / (1024 * 1024 * 1024)) : 2;

  return (
    <section className="panel p-5" aria-labelledby="copies-heading">
      <h3 id="copies-heading" className="flex items-center gap-2 text-[.9rem] font-semibold">
        <FileCheck size={15} className="text-[var(--accent)]" /> Saved copies
      </h3>
      <p className="mt-2 text-[.76rem] text-[var(--dim)]">
        A saved copy is the page as it was when you saved it: text and pictures in one file on this computer,
        readable after the site changes or disappears. Scripts are removed, so a copy can't track you or run anything.
      </p>
      {!enabled ? (
        <p role="note" className="mt-3 text-[.76rem] text-[var(--amber)]">Saved copies are switched off for this run of the app.</p>
      ) : (
        <>
          <div className="mt-3 flex items-start gap-3">
            <button type="button" role="switch" aria-checked={autoSave} aria-labelledby="copies-auto-label" aria-describedby="copies-auto-hint"
              className="switch mt-0.5" onClick={() => setAutoSave(!autoSave)} />
            <div>
              <div id="copies-auto-label" className="text-[.82rem] font-semibold">Automatically save a copy of new links</div>
              <div id="copies-auto-hint" className="text-[.74rem] text-[var(--dim)]">
                Runs in the background, three pages at a time. Imported links are included. Links you already have are
                not touched by this switch; use the button below, or select links in the library and choose Save copies.
              </div>
            </div>
          </div>
          <div className="mt-4 flex items-start gap-3">
            <button type="button" role="switch" aria-checked={largeVideos.state?.on === true} aria-labelledby="copies-large-label"
              aria-describedby="copies-large-hint" className="switch mt-0.5" disabled={!largeVideos.state}
              onClick={() => void largeVideos.set(!largeVideos.state?.on)} />
            <div>
              <div id="copies-large-label" className="text-[.82rem] font-semibold">Keep large videos and audio</div>
              <div id="copies-large-hint" className="text-[.74rem] text-[var(--dim)]">
                X videos, and Telegram videos and audio sent with your links, bigger than {cap} MB are kept too, up to {limit} GB each. Each is
                downloaded to disk with the free space checked first; if there isn't enough, it is left out (an X copy keeps its cover picture).
                Large Telegram files download in the background after a refresh. Copies and zip backups get much bigger with this on. TikTok videos keep
                the {cap} MB limit.
              </div>
              {queue.received > 0 && <div className="mt-1 text-[.74rem]" role="status">
                Downloading a large video: {formatBytes(queue.received)} received so far.
              </div>}
            </div>
          </div>
          <dl className="import-counts mt-4" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))", maxWidth: 520 }} aria-label="Saved copies in numbers">
            <div><dt>Copies</dt><dd>{summary ? summary.count.toLocaleString() : "…"}</dd></div>
            <div><dt>Space used</dt><dd>{summary ? (formatBytes(summary.bytes) || "0 KB") : "…"}</dd></div>
            <div><dt>Links without a copy</dt><dd>{without.toLocaleString()}</dd></div>
          </dl>
          {eligible.length > 0 && !confirming && <div className="mt-3">
            <button className="btn" onClick={() => setConfirming(true)}>
              <FileDown size={13} /> Save copies of the {eligible.length.toLocaleString()} link{eligible.length === 1 ? "" : "s"} without one
            </button>
          </div>}
          {eligible.length > 0 && confirming && <div className="mt-3 rounded-lg border p-3" style={{ borderColor: "var(--border-hi)" }} role="group" aria-label="Confirm saving copies">
            <p className="text-[.78rem]">
              Save copies of {eligible.length.toLocaleString()} link{eligible.length === 1 ? "" : "s"}? Each page is fetched once from its site, three at a
              time, in the background. You can pause it here. Links whose copy can't be made (files, pages over 3 MB) are skipped.
            </p>
            <div className="mt-2.5 flex gap-2">
              <button className="btn btn-primary" onClick={() => { saveCopies(eligible, { skipFinal: true }); setConfirming(false); }}>
                <FileDown size={13} /> Save {eligible.length.toLocaleString()} cop{eligible.length === 1 ? "y" : "ies"}
              </button>
              <button className="btn" onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          </div>}
          {working && <div role="status" aria-label="Copy progress" className="mt-3 flex items-center gap-2 text-[.7rem] text-[var(--dim)]">
            <div className="h-1 flex-1 overflow-hidden rounded-full" style={{ background: "var(--surface2)" }}>
              <div className="h-full rounded-full" style={{ width: `${Math.round((queue.done / queue.total) * 100)}%`, background: "var(--accent)", transition: "width .2s var(--ease)" }} />
            </div>
            <span className="shrink-0">{queue.paused ? "Copies paused" : "Saving copies"} · {queue.done}/{queue.total}</span>
            <button className="icon-btn shrink-0" style={{ width: 20, height: 20 }}
              aria-label={queue.paused ? "Resume saving copies" : "Pause saving copies"} onClick={() => setCopiesPaused(!queue.paused)}>
              {queue.paused ? <Play size={11} /> : <Pause size={11} />}
            </button>
          </div>}
          <p className="mt-3 text-[.72rem] text-[var(--dim)]">
            Limits: 15 MB a page, 40 pictures, 4 MB a picture. Deleting a link deletes its copy. Copies are not part of
            the normal backup; Backup below can export them as a zip.
          </p>
          <SocialPostsSettings />
        </>
      )}
    </section>
  );
}
