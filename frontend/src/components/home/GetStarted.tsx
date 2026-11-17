import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Check } from "lucide-react";
import { usePrefs } from "../../store/prefs";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The browsers paired with the extension, looked at again when this tab comes back: pairing happens in the
 *  extension's own tab. null until the app has answered. */
function usePairedBrowsers(): string[] | null {
  const [browsers, setBrowsers] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const data = await (await fetch("/api/extension", { cache: "no-store" })).json();
        if (live && Array.isArray(data?.connections)) {
          setBrowsers(data.connections.map((c: { browser?: unknown }) => (typeof c?.browser === "string" && c.browser ? c.browser : "A browser")));
        }
      } catch { /* the app is restarting: keep what is shown */ }
    };
    void load();
    const again = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", again);
    window.addEventListener("focus", again);
    return () => { live = false; document.removeEventListener("visibilitychange", again); window.removeEventListener("focus", again); };
  }, []);
  return browsers;
}

/**
 * Get started (owner, 2026-11-02; mockups in `Claude outputs/v040-review/phase9`): three steps that tick themselves, and
 * Telegram as one optional line. In place of "Your library is empty" on a new library (`first`), then as a strip above
 * the deck. Each step is a way in that already exists: no tour. lib/getStarted.ts decides which library gets it.
 */
export default function GetStarted({ first, links, waiting, onAddLink, onDone, onDismiss }: {
  first: boolean; links: number; waiting: number; onAddLink(): void; onDone(): void; onDismiss(): void;
}) {
  const navigate = useNavigate();
  const sorted = usePrefs(s => s.getStartedSorted);
  const browsers = usePairedBrowsers();
  const steps = [links > 0, (browsers ?? []).length > 0, sorted];
  const done = steps.filter(Boolean).length;
  useEffect(() => { if (done === steps.length) onDone(); }, [done, steps.length, onDone]);

  const connected = !browsers?.length ? "" : browsers.length === 1 ? `${browsers[0]} is connected.` : `${browsers.length} browsers are connected.`;
  const rows: { title: string; text: string; actions?: ReactNode }[] = [
    { title: "Bring your links in", text: steps[0] ? `${plural(links, "link")} in your library.` : "Import your browser's bookmarks, or add one link by hand.",
      actions: steps[0] ? undefined : <>
        <button type="button" className="btn btn-primary" onClick={() => navigate("/library/settings")}>Import links</button>
        <button type="button" className="btn" onClick={onAddLink}>Add link</button>
      </> },
    { title: "Save from your browser", text: steps[1] ? connected : "Add the extension and save the page you're on in one click.",
      actions: steps[1] ? undefined : <button type="button" className="btn" onClick={() => navigate("/library/settings#save-from-browser-heading")}>Set it up</button> },
    { title: "Sort your first link", text: steps[2] ? "You sorted your first link." : waiting > 0 ? "Press Keep, Later or Archive on the link below."
      : "New links wait here one at a time, for Keep, Later or Archive." },
  ];
  return (
    <section className={`panel get-started ${first ? "get-started--first" : "get-started--strip"}`} aria-labelledby="get-started-title">
      <div className="get-started__head">
        <h2 id="get-started-title">Get started</h2>
        <span className="get-started__count">{done} of {steps.length}</span>
        <button type="button" className="get-started__close" onClick={onDismiss} aria-label="Dismiss Get started">Dismiss</button>
      </div>
      <ol className="get-started__steps">
        {rows.map((row, i) => (
          <li key={row.title} className={`get-started__step${steps[i] ? " is-done" : ""}`}>
            <span className="get-started__tick" aria-hidden="true"><Check size={14} strokeWidth={3} /></span>
            <div className="min-w-0"><b>{steps[i] && <span className="sr-only">Done: </span>}{row.title}</b><p>{row.text}</p></div>
            {row.actions && <div className="get-started__actions">{row.actions}</div>}
          </li>
        ))}
      </ol>
      <p className="get-started__extra">
        Use Telegram? <Link to="/library/settings#telegram-config-heading" className="text-link" style={{ fontSize: "inherit" }}>Connect it</Link> to
        bring in your Saved Messages.
      </p>
    </section>
  );
}
