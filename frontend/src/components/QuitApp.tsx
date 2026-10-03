import { useEffect, useRef } from "react";
import { create } from "zustand";
import { Power } from "lucide-react";
import { runtimeToken } from "../lib/publicRuntime";
import { syncLibrary } from "../lib/libraryPersistence";
import { useLibrary } from "../store/library";

/**
 * Quitting the installed app stops the local server every open tab uses, so it
 * is always confirmed, never loses unsaved work (changes are saved first, and
 * quitting is refused while any are still pending), and ends on a clear
 * "stopped" screen instead of a browser error page.
 *
 * Only the installed app can quit itself; in source mode the server runs in a
 * terminal and stops with Ctrl+C, so none of this is shown.
 */
type Phase = "closed" | "confirm" | "saving" | "pending" | "stopping" | "stopped" | "error";
interface QuitState { phase: Phase; message: string }
const useQuit = create<QuitState>(() => ({ phase: "closed", message: "" }));
const pendingCount = () => Object.keys(useLibrary.getState().pending).length;

export const canQuit = !!runtimeToken;
export function requestQuit() { useQuit.setState({ phase: "confirm", message: "" }); }

async function quitNow() {
  useQuit.setState({ phase: "saving", message: "" });
  if (!await syncLibrary() || pendingCount()) {
    useQuit.setState({ phase: "pending", message: "Changes are still pending. Retry SQLite save before quitting." });
    return;
  }
  try {
    const response = await fetch("/api/runtime/quit", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }),
    });
    if (!response.ok) throw new Error();
  } catch {
    useQuit.setState({ phase: "error", message: "Could not quit. Check that the app is still running and try again." });
    return;
  }
  useQuit.setState({ phase: "stopping", message: "" });
  // The server stops a moment after acknowledging; switch once it is gone.
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { await fetch("/api/runtime", { cache: "no-store" }); } catch { break; }
  }
  useQuit.setState({ phase: "stopped" });
}

/** Small power button for the sidebar footer. */
export function QuitButton({ className, label }: { className: string; label?: boolean }) {
  if (!canQuit) return null;
  return (
    <button className={className} onClick={requestQuit} aria-label="Quit app" title="Quit Super Bookmark Manager">
      <Power size={15} className="shrink-0" aria-hidden="true" />{label && "Quit"}
    </button>
  );
}

/** The confirmation dialog and the stopped screen; mounted once in the shell. */
export function QuitHost() {
  const { phase, message } = useQuit();
  const pending = useLibrary(s => Object.keys(s.pending).length);
  const dialog = useRef<HTMLDialogElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const asking = phase === "confirm" || phase === "saving" || phase === "pending" || phase === "error";

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (asking && !el.open) { el.showModal(); primary.current?.focus(); }
    if (!asking && el.open) el.close();
  }, [asking]);

  if (!canQuit) return null;
  if (phase === "stopping" || phase === "stopped") {
    return (
      <div className="quit-screen" role="alertdialog" aria-modal="true" aria-labelledby="quit-screen-title">
        <div className="quit-screen__card">
          <Power size={28} aria-hidden="true" />
          <h1 id="quit-screen-title">{phase === "stopping" ? "Super Bookmark Manager is stopping…" : "Super Bookmark Manager has stopped"}</h1>
          <p>Your library is saved. You can close this tab — open the app again from the Start Menu or your Desktop shortcut.</p>
        </div>
      </div>
    );
  }

  const busy = phase === "saving";
  const blocked = phase === "pending" || pending > 0;
  return (
    <dialog ref={dialog} className="quit-dialog" aria-labelledby="quit-title"
      onCancel={e => { if (busy) e.preventDefault(); }} onClose={() => useQuit.setState({ phase: "closed", message: "" })}>
      <h2 id="quit-title" className="font-semibold">Quit Super Bookmark Manager?</h2>
      <p className="mt-2 text-[.82rem] text-[var(--dim)]">
        {blocked
          ? `${pending || "Some"} change${pending === 1 ? " hasn't" : "s haven't"} reached SQLite yet. Save first so nothing is lost; the app quits once everything is saved.`
          : "The app stops in every open tab. Closing the browser alone leaves it running in the background."}
      </p>
      {message && <p role="status" className="mt-2 text-[.8rem] text-[var(--amber)]">{message}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn" onClick={() => dialog.current?.close()} disabled={busy}>Cancel</button>
        <button ref={primary} className="btn btn-primary" onClick={() => void quitNow()} disabled={busy}>
          <Power size={13} aria-hidden="true" /> {busy ? "Saving…" : blocked ? "Save and quit" : "Quit now"}
        </button>
      </div>
    </dialog>
  );
}
