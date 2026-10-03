import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { RotateCcw } from "lucide-react";
import { useLibrary } from "../store/library";
import { syncLibrary, useLibraryPersistence } from "../lib/libraryPersistence";
import { useStorageHealth } from "../lib/libraryStorage";
import { useEnrichmentQueue } from "../lib/metadataEnrichment";

export function useSaveMessage() {
  const pending = useLibrary(s => Object.keys(s.pending).length);
  const demo = useLibrary(s => s.demo);
  const persistence = useLibraryPersistence();
  const message = pending ? `${pending} change${pending === 1 ? "" : "s"} pending SQLite save`
    : demo ? "Demo only — not saved to SQLite"
    : persistence.status === "saved" ? "Library saved to SQLite"
    : persistence.status === "error" ? "SQLite unavailable — using browser cache"
    : "Checking SQLite…";
  return { pending, demo, persistence, message };
}

/**
 * Save status as a small floating toast at the bottom-left of the content (just
 * right of the sidebar, clear of drawers on the right). It appears
 * only while something is happening (saving, preview fetching) or needs you
 * (SQLite unavailable, changes needing attention, demo data), shows "Saved"
 * briefly when work finishes, then fades away. It floats over the page, so it
 * never changes the height of the sidebar or anything else.
 *
 * The element itself always stays in the page (only faded out), so screen
 * readers and tests can always read the current save message.
 */
const SHOW_AFTER_MS = 400;   // quick background saves never flash a toast
const LINGER_MS = 1800;      // how long "Saved" stays after visible work ends

export default function SyncIndicator() {
  const { pending, demo, persistence, message } = useSaveMessage();
  const attention = useLibrary(s => Object.keys(s.rejected).length);
  const storageError = useStorageHealth(s => s.error);
  const queue = useEnrichmentQueue();
  const error = persistence.status === "error";
  const previews = queue.total > 0 && queue.done < queue.total;
  const problem = error || attention > 0 || !!storageError || demo;
  const busy = pending > 0 || persistence.status === "syncing" || previews;
  const [visible, setVisible] = useState(false);
  const [lingering, setLingering] = useState(false);
  const shownRef = useRef(false);

  useEffect(() => {
    if (problem) { shownRef.current = true; setVisible(true); setLingering(false); return; }
    if (busy) {
      setLingering(false);
      const timer = setTimeout(() => { shownRef.current = true; setVisible(true); }, SHOW_AFTER_MS);
      return () => clearTimeout(timer);
    }
    if (!shownRef.current) { setVisible(false); return; }
    // Work just finished while the toast was showing: say "Saved", then fade.
    setLingering(true);
    const timer = setTimeout(() => { shownRef.current = false; setVisible(false); setLingering(false); }, LINGER_MS);
    return () => clearTimeout(timer);
  }, [busy, problem]);

  const warn = error || attention > 0 || !!storageError;
  const colour = warn || demo ? "var(--amber)" : busy ? "var(--accent)" : "var(--green)";
  const shown = attention ? `${attention} change${attention === 1 ? "" : "s"} need${attention === 1 ? "s" : ""} attention`
    : storageError ? "Browser cache problem"
    : previews && !error && !pending ? `${queue.paused ? "Previews paused" : "Fetching previews"} · ${queue.done}/${queue.total}`
    : pending && !error ? `Saving ${pending} change${pending === 1 ? "" : "s"}…`
    : lingering && !busy ? "Saved"
    : message;
  const detail = [message, error ? persistence.error : ""].filter(Boolean).join(". ");

  return (
    <div role="status" aria-label="SQLite save status" title={detail}
      className={"save-toast" + (visible ? " is-visible" : "") + (warn ? " is-warning" : "")}>
      <Link to="/library/settings#library" className="save-toast__link" tabIndex={visible ? undefined : -1}>
        <span className="dot shrink-0" style={{ background: colour }} aria-hidden="true" />
        {/* The accessible text is always the exact save message; what is drawn
            comes from CSS so the element's text content stays stable. */}
        <span className="sr-only">{message}</span>
        {persistence.error && <span className="sr-only">. {persistence.error}</span>}
        <span className="save-toast__text" aria-hidden="true" data-label={shown} />
      </Link>
      {error && <button className="save-toast__retry" title="Retry SQLite save" aria-label="Retry SQLite save" onClick={() => { void syncLibrary(); }}>
        <RotateCcw size={11} aria-hidden="true" />Retry<span className="sr-only"> SQLite save</span>
      </button>}
      {previews && <span className="save-toast__bar" aria-hidden="true"
        style={{ width: `${Math.round((queue.done / queue.total) * 100)}%` }} />}
    </div>
  );
}
