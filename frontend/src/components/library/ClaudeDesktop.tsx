import { useCallback, useEffect, useState } from "react";
import { Check, ChevronRight, Copy, ExternalLink, KeyRound, RotateCcw, Unplug, X } from "lucide-react";
import { PROJECT_URL } from "../TopNav";
import { ago } from "./ExtensionSetup";
import { claudeChangesSettled, claudePost, useClaudeDesktop } from "../../lib/claudeDesktop";

interface Change { id: string; at: string; summary: string; count: number; undone: boolean; kept: boolean }
interface Suggestion { id: string; at: string; name: string; description: string; count: number }
interface Status { connected: boolean; createdAt: string; lastUsedAt: string; changes: Change[]; suggestions: Suggestion[] }

const time = (iso: string) => {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? "" : new Date(at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
};

/**
 * Settings → AI providers → Claude Desktop (v0.4.0): the SuperBookmarks extension for Claude Desktop. A token made
 * here (shown once) lets it search the library and file links on shelves through this app; each change it makes is
 * listed with Undo, and a shelf it suggests is made only when the owner clicks Create.
 */
export default function ClaudeDesktopRow() {
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  // The tab's watcher hears when Claude Desktop changes something: the list follows.
  const version = useClaudeDesktop(s => s.version);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/claude-desktop", { cache: "no-store" });
      const data = await response.json();
      if (response.ok && Array.isArray(data?.changes)) setStatus(data as Status);
    } catch { /* the app is restarting: keep what is shown */ }
  }, []);
  useEffect(() => { void load(); }, [load, version]);
  // Something waits for the owner: open the row.
  const suggestions = status?.suggestions.length ?? 0;
  useEffect(() => { if (suggestions) setOpen(true); }, [suggestions]);

  const act = async (name: string, path: string, body: unknown, done?: (data: Record<string, unknown>) => string) => {
    setBusy(name); setNote(null);
    const { ok, data } = await claudePost(path, body);
    setBusy("");
    if (!ok) setNote({ ok: false, text: typeof data.error === "string" ? data.error : "That didn't work. Try again." });
    else if (done) setNote({ ok: true, text: done(data) });
    await load();
    return ok ? data : null;
  };
  const makeToken = async () => {
    const data = await act("token", "/api/claude-desktop/token", {});
    if (data && typeof data.token === "string") { setToken(data.token); setCopied(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(token); setCopied(true); } catch { setNote({ ok: false, text: "Couldn't copy: select the token and copy it." }); }
  };
  const disconnect = async () => {
    setBusy("disconnect");
    await fetch("/api/claude-desktop/token", { method: "DELETE" }).catch(() => {});
    setBusy(""); setToken("");
    await load();
  };
  const undo = async (id: string) => {
    if (await act(`undo-${id}`, "/api/claude-desktop/undo", { id }, data =>
      `Undone${Number(data.skipped) ? `; ${data.skipped} link${data.skipped === 1 ? "" : "s"} changed since ${data.skipped === 1 ? "was" : "were"} left as ${data.skipped === 1 ? "it is" : "they are"}` : ""}.`)) await claudeChangesSettled();
  };
  const resolve = async (id: string, create: boolean) => {
    if (await act(`suggestion-${id}`, "/api/claude-desktop/suggestion", { id, create }, data =>
      !create ? "Dismissed." : typeof data.problem === "string" ? `Shelf made. ${data.problem}` : `Shelf made${Number(data.filed) ? ` and ${data.filed} link${data.filed === 1 ? "" : "s"} filed on it` : ""}.`)) await claudeChangesSettled();
  };

  const connected = !!status?.connected;
  const tone = connected ? "var(--green)" : "var(--faint)";
  const chip = !status ? "Checking…" : !connected ? "Not connected yet"
    : status.lastUsedAt ? `Connected · last used ${ago(status.lastUsedAt)}` : "Connected · not used yet";
  const changes = status?.changes ?? [];

  return (
    <li className={"ai-provider" + (open ? " is-open" : "")} aria-label="Claude Desktop">
      <div className="ai-provider__head">
        <button type="button" className="ai-provider__toggle" aria-expanded={open} aria-controls="ai-provider-claude-desktop" onClick={() => setOpen(!open)}>
          <ChevronRight size={14} className="ai-provider__chevron" aria-hidden="true" />
          <span className="font-semibold text-[.84rem]">Claude Desktop</span>
          <span className="chip" style={{ color: tone, borderColor: tone }}>{chip}</span>
          {suggestions > 0 && <span className="ai-provider__tag">{suggestions} suggestion{suggestions === 1 ? "" : "s"}</span>}
          <span className="flex-1" />
          {!open && <span className="ai-provider__summary">No API key: Claude works through your Claude plan</span>}
        </button>
      </div>
      {open && <div id="ai-provider-claude-desktop" className="ai-provider__body">
        <p className="text-[.74rem] text-[var(--dim)]">
          Ask Claude in Claude Desktop to search your library, list what's unfiled, or file links on a shelf. It talks to
          SuperBookmarks on this computer only, and every change it makes can be undone here. What Claude reads from your
          library becomes part of your chat with Claude.
        </p>

        {(!connected || token) && <ol className="mt-2.5 list-decimal pl-[18px] text-[.76rem] leading-[1.7]">
          <li>Make a token and copy it:{" "}
            <button className="btn btn-primary" style={{ padding: "2px 10px", fontSize: ".72rem" }} disabled={!!busy} onClick={() => void makeToken()}>
              <KeyRound size={12} /> {token ? "Make another" : "Make a token"}
            </button>
          </li>
          <li>Download <b>SuperBookmarks.mcpb</b> from the{" "}
            <a className="text-link inline-flex items-center gap-0.5" href={`${PROJECT_URL}/releases/latest`} target="_blank" rel="noopener noreferrer">
              release page <ExternalLink size={10} /></a> and double-click it: Claude Desktop asks to install it and for the token. Paste it there.
          </li>
          <li>Already installed? In Claude Desktop: Settings → Extensions → SuperBookmarks → Configure, and paste the new token.</li>
        </ol>}
        {token && <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-[18px]">
          <code className="claude-token" aria-label="New token">{token}</code>
          <button className="btn" style={{ padding: "2px 10px", fontSize: ".72rem" }} onClick={() => void copy()}>
            {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
          </button>
        </div>}
        {(!connected || token) && <p className="mt-1.5 pl-[18px] text-[.7rem] text-[var(--faint)]">
          The token lets Claude Desktop read your links and shelves and file links on shelves. It is shown only now; only its
          fingerprint is kept here, and making a new one stops the old one.
        </p>}

        {suggestions > 0 && <>
          <h4 className="claude-heading">Shelves Claude Desktop suggests</h4>
          <ul className="claude-list" aria-label="Shelves Claude Desktop suggests">
            {status!.suggestions.map(s => <li key={s.id}>
              <span>A new shelf <b>{s.name}</b>{s.count ? ` for ${s.count} link${s.count === 1 ? "" : "s"}` : ""}
                {s.description && <span className="text-[var(--faint)]"> · {s.description}</span>}</span>
              <button className="btn btn-primary claude-small" disabled={!!busy} onClick={() => void resolve(s.id, true)}>Create it</button>
              <button className="btn claude-small" disabled={!!busy} onClick={() => void resolve(s.id, false)}><X size={11} /> Dismiss</button>
            </li>)}
          </ul>
        </>}

        {changes.length > 0 && <>
          <h4 className="claude-heading">Changes from Claude Desktop</h4>
          <ul className="claude-list" aria-label="Changes from Claude Desktop">
            {changes.slice(0, 10).map(c => <li key={c.id} className={c.undone ? "is-undone" : ""}>
              <span>{c.summary} · {time(c.at)}{c.undone ? " · undone" : ""}</span>
              {!c.undone && <button className="btn claude-small" disabled={!!busy} onClick={() => void undo(c.id)}
                aria-label={`Undo: ${c.summary}`}><RotateCcw size={11} /> Undo</button>}
            </li>)}
          </ul>
        </>}

        {connected && <div className="mt-3 flex flex-wrap gap-2">
          {!token && <button className="btn" style={{ fontSize: ".74rem" }} disabled={!!busy} onClick={() => void makeToken()}><KeyRound size={12} /> New token</button>}
          <button className="btn" style={{ fontSize: ".74rem" }} disabled={!!busy} onClick={() => void disconnect()}><Unplug size={12} /> Disconnect</button>
        </div>}
        {note && <p role="status" className="mt-2 text-[.74rem]" style={{ color: note.ok ? "var(--green)" : "var(--amber)" }}>{note.text}</p>}
      </div>}
    </li>
  );
}
