import { useCallback, useEffect, useState } from "react";
import { PROJECT_URL } from "../TopNav";

interface Connection { id: string; browser: string; pairedAt: string; lastUsedAt: string }
interface Code { code: string; expiresIn: number }

/** "2 min ago", "3 h ago", "24 Oct" */
export function ago(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
  return new Date(time).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/**
 * Settings → Sources → Save from your browser: the SuperBookmarks extension (v0.4.0). Install steps,
 * a one-time pairing code (works once, for 10 minutes; the extension can then add links and ask
 * whether a page is saved, nothing else), and the browsers that are connected.
 */
export default function ExtensionSetup() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [code, setCode] = useState<Code | null>(null);
  const [problem, setProblem] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await (await fetch("/api/extension", { cache: "no-store" })).json();
      if (Array.isArray(data?.connections)) setConnections(data.connections);
      setCode(data?.code ?? null);
    } catch { /* the app is restarting: keep what is shown */ }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // While a code is shown, look for the extension to use it (then the code goes and the browser shows up).
  useEffect(() => {
    if (!code) return;
    const timer = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(timer);
  }, [code, load]);

  const newCode = async () => {
    setProblem("");
    try {
      const response = await fetch("/api/extension/code", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await response.json();
      if (response.ok && data?.code) setCode(data.code); else setProblem("A pairing code couldn't be made. Try again.");
    } catch { setProblem("The app didn't answer. Try again."); }
  };
  const disconnect = async (id: string) => {
    await fetch(`/api/extension/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
    void load();
  };

  const connected = (connections ?? []).length > 0;
  return (
    <div className="mt-3 rounded-xl border p-3.5" style={{ borderColor: "var(--border)", background: "var(--surface2)" }} aria-label="SuperBookmarks extension">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[.82rem] font-semibold">SuperBookmarks extension <span className="font-normal text-[var(--faint)]">· Chrome, Edge, Brave and Firefox</span></div>
        {connections !== null && (connected
          ? <span className="chip" style={{ color: "var(--green)", borderColor: "var(--green)" }}>● Connected</span>
          : <span className="chip">○ Not connected yet</span>)}
      </div>
      <p className="mt-1.5 text-[.74rem] text-[var(--dim)]">
        A toolbar button and a right-click “Save link to SuperBookmarks” that open the Save window; on X, Instagram and TikTok it lists
        the posts loaded in your tab so you can tick the ones to save. In the extension's options you can turn on a Download button
        on each post (one site at a time) and a check mark on the button when the page you're on is already saved.
      </p>
      {connected && <ul className="mt-2.5 space-y-1.5" aria-label="Connected browsers">
        {connections!.map(c => (
          <li key={c.id} className="flex flex-wrap items-center gap-2 text-[.76rem]">
            <span style={{ color: "var(--green)" }}>●</span>
            <span><b>{c.browser}</b> · connected {ago(c.pairedAt)}{c.lastUsedAt && c.lastUsedAt !== c.pairedAt ? ` · last used ${ago(c.lastUsedAt)}` : ""}</span>
            <button className="btn" style={{ padding: "2px 10px", fontSize: ".72rem" }} onClick={() => void disconnect(c.id)}>Disconnect</button>
          </li>
        ))}
      </ul>}
      {!connected && connections !== null && <ol className="mt-2.5 list-decimal space-y-1 pl-5 text-[.76rem]">
        <li>Download it from the <a className="text-link" href={`${PROJECT_URL}/releases/latest`} target="_blank" rel="noopener noreferrer">release page</a>:{" "}
          <b>SuperBookmarks-extension-chrome.zip</b> (Chrome, Edge, Brave) or <b>SuperBookmarks.xpi</b> (Firefox).</li>
        <li>Chrome, Edge, Brave: unzip it, open <code>chrome://extensions</code>, turn on Developer mode, click Load unpacked and choose the folder.
          Firefox: open the .xpi file.</li>
        <li>In the extension's options, enter a pairing code from here.</li>
      </ol>}
      <div className={`mt-2.5 flex flex-wrap items-center gap-2.5 ${connected ? "" : "pl-5"}`}>
        {code ? <>
          <span aria-label="Pairing code" className="rounded-lg border px-3 py-1.5 text-[1.15rem] font-semibold tracking-[.12em]"
            style={{ borderColor: "var(--border-hi)", background: "var(--surface)", fontFamily: "ui-monospace, Consolas, monospace" }}>{code.code}</span>
          <button className="btn" onClick={() => void newCode()}>New code</button>
          <span className="text-[.72rem] text-[var(--faint)]">Works once, for {Math.max(1, Math.ceil(code.expiresIn / 60))} more minute{code.expiresIn > 60 ? "s" : ""}.</span>
        </> : <button className="btn" onClick={() => void newCode()}>{connected ? "Pair another browser" : "Show a pairing code"}</button>}
      </div>
      {(code || !connected) && <p className={`mt-2 text-[.72rem] text-[var(--faint)] ${connected ? "" : "pl-5"}`}>
        Pairing lets the extension add links and ask whether a page is saved. It can't read, change or delete anything else.
      </p>}
      {problem && <p role="status" className="mt-2 text-[.74rem] text-[var(--amber)]">{problem}</p>}
      <p className="mt-2.5 text-[.72rem] text-[var(--faint)]">The extension only talks to the app on this computer ({window.location.host}).</p>
    </div>
  );
}
