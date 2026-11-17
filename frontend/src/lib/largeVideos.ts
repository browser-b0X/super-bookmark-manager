import { useEffect } from "react";
import { create } from "zustand";

/**
 * "Keep large videos and audio" (archive.py) and Telegram's large files downloading after a refresh
 * (telegram_refresh.py), both from /api/archive/large-videos. Settings → Saved copies has the switch; the
 * Telegram Saved Messages panel shows the download and can stop it.
 */

/** The background download of Telegram's large videos and audio, as the server reports it. */
export interface TelegramDownload {
  running: boolean;
  /** Large files in this download, and how many have ended (kept or not). */
  total: number; done: number; kept: number; failed: number;
  /** Bytes of the file downloading now, and its size (0 between files). */
  received: number; size: number;
  /** Why the last file that wasn't kept wasn't: no_space, slow, stopped, too_large, gone, busy, unavailable; "" when none failed. */
  reason: string;
}

export interface LargeVideos { on: boolean; cap: number; limit: number; telegram: TelegramDownload | null }

const count = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);

/** The server's answer, checked: it comes over the network. */
function parse(data: unknown): LargeVideos | null {
  const d = data as Record<string, unknown> | null;
  if (!d || typeof d.on !== "boolean") return null;
  const t = d.telegram as Record<string, unknown> | null | undefined;
  const telegram = t && typeof t === "object" && typeof t.running === "boolean"
    ? { running: t.running, total: count(t.total), done: count(t.done), kept: count(t.kept), failed: count(t.failed),
        received: count(t.received), size: count(t.size), reason: typeof t.reason === "string" ? t.reason : "" }
    : null;
  return { on: d.on, cap: count(d.cap) || 50 * 1024 * 1024, limit: count(d.limit) || 2 * 1024 * 1024 * 1024, telegram };
}

interface Store {
  state: LargeVideos | null;
  load(): Promise<void>;
  set(on: boolean): Promise<void>;
  /** Stop Telegram's background download. */
  stop(): Promise<void>;
}

let timer: ReturnType<typeof setTimeout> | undefined;
let watchers = 0;

/** While a download runs and a panel shows it, ask again every 1.5 s. */
function watch(state: LargeVideos | null) {
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (watchers > 0 && state?.telegram?.running) timer = setTimeout(() => void useLargeVideos.getState().load(), 1500);
}

async function ask(init?: RequestInit): Promise<LargeVideos | null> {
  try {
    const response = await fetch("/api/archive/large-videos", { cache: "no-store", ...init });
    return response.ok ? parse(await response.json()) : null;
  } catch {
    return null;
  }
}

const post = (body: object): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const useLargeVideos = create<Store>(set => {
  const take = (next: LargeVideos | null) => {
    if (next) set({ state: next });
    // A failed request keeps following what was last known, so a running download is asked about again.
    watch(next ?? useLargeVideos.getState().state);
  };
  return {
    state: null,
    async load() { take(await ask()); },
    async set(on) { take(await ask(post({ on }))); },
    async stop() { take(await ask(post({ stop: true }))); },
  };
});

/** Read the setting (and any download) when a panel opens, and follow a download while it is shown. */
export function useWatchLargeVideos() {
  useEffect(() => {
    watchers++;
    void useLargeVideos.getState().load();
    return () => {
      watchers--;
      if (!watchers && timer) { clearTimeout(timer); timer = undefined; }
    };
  }, []);
}
