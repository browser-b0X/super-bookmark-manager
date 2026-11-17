import { create } from "zustand";
import { useLibrary } from "../store/library";
import { syncLibrary } from "./libraryPersistence";

/** The newest change Claude Desktop made that the owner hasn't kept or undone yet, and how many more wait. */
export interface ClaudeChange { id: string; at: string; summary: string; count: number; more: number }

/** What the app last said about Claude Desktop, from this tab's reports (every 15 seconds while it is shown). */
export const useClaudeDesktop = create<{ connected: boolean; change: ClaudeChange | null; suggestions: number; version: string }>(
  () => ({ connected: false, change: null, suggestions: 0, version: "" }));

const EVERY_MS = 15000;
const TAB = Math.random().toString(36).slice(2, 12) || "tab";

export async function claudePost(path: string, body: unknown = {}): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok && data.ok !== false, data };
  } catch {
    return { ok: false, data: { error: "The app didn't answer. Try again." } };
  }
}

function readChange(value: unknown): ClaudeChange | null {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || typeof v.id !== "string" || typeof v.summary !== "string") return null;
  return { id: v.id, at: typeof v.at === "string" ? v.at : "", summary: v.summary.slice(0, 200),
    count: Number(v.count) || 0, more: Number(v.more) || 0 };
}

/**
 * Tells the app which links this tab has changed but not saved yet (Claude Desktop never writes over those), and
 * hears when Claude Desktop changed the library (or a change was undone): the tab then reads the library again,
 * and the note offers Undo.
 */
export function startClaudeDesktopWatch() {
  let reported: string | null = null;   // the unsaved links last reported (sorted, one per line)
  let version: string | null = null;    // the app's count of Claude Desktop's changes when this tab last read them
  let timer: ReturnType<typeof setTimeout> | undefined;
  let quick: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let again = false;
  let stopped = false;

  const report = async () => {
    if (stopped || useLibrary.getState().demo) return;
    if (busy) { again = true; return; }
    const urls = Object.keys(useLibrary.getState().pending).sort();
    // A hidden tab with nothing unsaved has nothing to say until it is shown again.
    if (document.visibilityState === "hidden" && !urls.length && !reported) return;
    busy = true;
    try {
      const response = await fetch("/api/library/pending", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tab: TAB, urls }) });
      if (!response.ok) return;
      reported = urls.join("\n");
      const data = await response.json().catch(() => ({}));
      const next = typeof data.version === "string" ? data.version : "";
      useClaudeDesktop.setState({ connected: data.connected === true, change: readChange(data.change),
        suggestions: Number(data.suggestions) || 0, version: next });
      // Claude Desktop wrote (or a change of its was undone) since this tab last read the library: read it again.
      if (version !== null && next !== version) void syncLibrary();
      version = next;
    } catch { /* the app isn't answering: the next report tries again */ }
    finally {
      busy = false;
      if (again) { again = false; void report(); }
    }
  };
  const schedule = (ms: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void report().finally(() => schedule(EVERY_MS)); }, ms);
  };
  const unsubscribe = useLibrary.subscribe((state, previous) => {
    if (state.pending === previous.pending || quick) return;
    // A link joins or leaves the unsaved ones: say so within a quarter of a second.
    quick = setTimeout(() => {
      quick = undefined;
      if (Object.keys(useLibrary.getState().pending).sort().join("\n") !== reported) void report();
    }, 250);
  });
  const shown = () => { if (document.visibilityState === "visible") schedule(0); };
  document.addEventListener("visibilitychange", shown);
  schedule(0);
  return () => {
    stopped = true;
    unsubscribe();
    document.removeEventListener("visibilitychange", shown);
    if (timer) clearTimeout(timer);
    if (quick) clearTimeout(quick);
  };
}

/** After the owner undid or kept Claude Desktop's changes here: ask the app again now (the note and the library). */
export async function claudeChangesSettled() {
  await syncLibrary();
  try {
    const response = await fetch("/api/library/pending", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tab: TAB, urls: Object.keys(useLibrary.getState().pending) }) });
    const data = await response.json().catch(() => ({}));
    if (response.ok) useClaudeDesktop.setState({ connected: data.connected === true, change: readChange(data.change),
      suggestions: Number(data.suggestions) || 0, version: typeof data.version === "string" ? data.version : "" });
  } catch { /* the next report says it */ }
}
