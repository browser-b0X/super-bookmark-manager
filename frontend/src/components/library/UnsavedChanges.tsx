import { AlertTriangle, RotateCcw, X } from "lucide-react";
import { useLibrary } from "../../store/library";
import { useStorageHealth } from "../../lib/libraryStorage";
import { syncLibrary } from "../../lib/libraryPersistence";

const REASONS: Record<string, string> = {
  invalid: "The saved data for this link was malformed.",
  shelf_limit: "It would add a 13th shelf. Remove or merge a shelf, then retry.",
  unknown_shelf: "It was auto-filed onto a shelf SQLite does not have.",
  id_conflict: "Another link already uses this ID.",
};

/** Changes SQLite refused and cache failures — shown until the owner acts. */
export default function UnsavedChanges() {
  const rejected = useLibrary(s => s.rejected);
  const retry = useLibrary(s => s.retryRejected);
  const discard = useLibrary(s => s.discardRejected);
  const storageError = useStorageHealth(s => s.error);
  const items = Object.entries(rejected);
  if (!items.length && !storageError) return null;

  return (
    <section id="unsaved-changes" className="panel mt-5 p-5" aria-labelledby="unsaved-heading" style={{ borderColor: "var(--amber)" }}>
      <h2 id="unsaved-heading" className="flex items-center gap-2 text-[.9rem] font-semibold">
        <AlertTriangle size={15} className="text-[var(--amber)]" /> Changes that need attention
      </h2>
      {storageError && <p role="alert" className="mt-2 text-[.76rem] text-[var(--dim)]">{storageError}</p>}
      {items.length > 0 && (
        <>
          <p className="mt-1.5 text-[.76rem] text-[var(--dim)]">
            SQLite did not save these edits. Everything else saved normally. Retry after fixing the cause, or discard to keep the saved version.
          </p>
          <ul className="mt-3 space-y-2">
            {items.map(([url, item]) => (
              <li key={url} className="flex items-start gap-2 rounded-lg border border-[var(--border)] p-2.5 text-[.76rem]">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{item.post.title || url}</div>
                  <div className="truncate text-[var(--faint)]">{url}</div>
                  <div className="mt-0.5 text-[var(--dim)]">{REASONS[item.reason] ?? item.error ?? "SQLite refused this change."}</div>
                </div>
                <button className="btn" onClick={() => { retry(url); void syncLibrary(); }}><RotateCcw size={12} /> Retry</button>
                <button className="btn" onClick={() => discard(url)} aria-label={`Discard unsaved change for ${item.post.title || url}`}><X size={12} /> Discard</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
