import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, RotateCcw } from "lucide-react";
import { claudeChangesSettled, claudePost, useClaudeDesktop } from "../lib/claudeDesktop";

/** "a moment ago", "at 10:42", "on 23 Oct" */
function when(iso: string) {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  if (Date.now() - at < 2 * 60000) return "a moment ago";
  const day = new Date(at);
  return day.toDateString() === new Date().toDateString()
    ? `at ${day.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
    : `on ${day.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

/**
 * What Claude Desktop changed in the library, until the owner undoes or keeps it: a note above the save status.
 * Undo puts back every change it shows that isn't kept yet; each one stays listed in Settings → AI providers → Claude Desktop.
 */
export default function ClaudeDesktopNote() {
  const change = useClaudeDesktop(s => s.change);
  // Undo and Keep cover what this note shows: changes made since it was drawn still wait.
  const version = useClaudeDesktop(s => s.version);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const settle = async (path: string, body: unknown) => {
    setBusy(true); setProblem("");
    const { ok, data } = await claudePost(path, body);
    if (!ok) setProblem(typeof data.error === "string" ? data.error : "That didn't work. Try again.");
    await claudeChangesSettled();
    setBusy(false);
  };
  const all = change ? change.more + 1 : 0;
  return (
    <div role="status" aria-label="Changes from Claude Desktop" className={"claude-note" + (change ? " is-visible" : "")}>
      {change && <>
        <p className="claude-note__title">Claude Desktop {change.summary.charAt(0).toLowerCase()}{change.summary.slice(1)}
          {change.more ? <span className="font-normal text-[var(--dim)]"> and {change.more} more change{change.more === 1 ? "" : "s"}</span> : null}</p>
        <p className="claude-note__when">From your chat in Claude Desktop, {when(change.at)}. <Link to="/library/settings#ai" className="text-link">See them</Link></p>
        <div className="claude-note__actions">
          <button type="button" className="btn" disabled={busy} onClick={() => void settle("/api/claude-desktop/undo", { waiting: true, version })}>
            <RotateCcw size={12} /> {all > 1 ? `Undo all ${all}` : "Undo"}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void settle("/api/claude-desktop/keep", { version })}>
            <Check size={12} /> Keep
          </button>
        </div>
        {problem && <p role="alert" className="mt-1.5 text-[.72rem] text-[var(--amber)]">{problem}</p>}
      </>}
    </div>
  );
}
