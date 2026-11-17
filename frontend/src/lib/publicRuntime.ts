import { create } from "zustand";

/** Public builds get a per-data-directory identity before any store hydrates. */
const meta = (name: string) => typeof document === "undefined" ? "" : document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content || "";
export const runtimeToken = meta("sbm-instance");
export const cacheKey = meta("sbm-cache-key");
/** The key was made in this run, so a plain cache can only be from before there was one (lib/cacheSeal). */
export const cacheKeyIsNew = meta("sbm-cache-new") === "1";
const proofKey = meta("sbm-proof-key");
const identity = meta("sbm-profile");
export const storageKey = (legacy: string) => identity ? `sbm-${identity}-${legacy}` : legacy;

/**
 * What this page knows of the app at its address. "gone": no proof came back, so the page is covered and sends nothing
 * until one does. "impostor": something answered with a wrong proof, and the page stops for good (components/AnotherProgram).
 */
export const useApp = create<{ state: "proved" | "gone" | "impostor" }>(() => ({ state: "proved" }));

// A busy app queues the question like any other request.
const PROOF_WAIT_MS = 30000;
const hex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
const nativeFetch = typeof window === "undefined" ? undefined : window.fetch?.bind(window);
let asking: Promise<boolean> | undefined;
let writing: Promise<unknown> = Promise.resolve();

async function askApp(): Promise<boolean> {
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const encoder = new TextEncoder();
  const message = `${nonce}|${window.location.origin}`;
  let answer: { proof?: unknown; run?: unknown } | null = null;
  let proved = false;
  let thisRun = true;
  try {
    const response = await nativeFetch!(`/api/runtime/hello?nonce=${nonce}`, { cache: "no-store", signal: AbortSignal.timeout(PROOF_WAIT_MS) });
    answer = await response.json();
    const key = await crypto.subtle.importKey("raw", encoder.encode(proofKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signed = async (text: string) => hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text))));
    proved = answer?.proof === await signed(message);
    thisRun = answer?.run === await signed(`${message}|${runtimeToken}`);
  } catch { /* nothing answers, or not with an answer to this */ }
  const proof = answer?.proof;
  // The app, started again since this page loaded: only a page of this run can write, and unsaved changes are in the cache.
  if (proved && !thisRun) {
    window.location.reload();
    return false;
  }
  const wrong = !proved && typeof proof === "string" && /^[0-9a-f]{64}$/.test(proof);
  if (useApp.getState().state !== "impostor") useApp.setState({ state: proved ? "proved" : wrong ? "impostor" : "gone" });
  return proved;
}

/**
 * A port is free for anyone while the app is off, so a tab left open can't take what answers there for the app. The
 * app proves itself: an HMAC of a random nonce and its address, keyed by what only it and its own pages hold (as it
 * does for the two extensions). Every request asks, because a program can take the port the moment the app stops:
 * nothing is sent, and no answer believed, without that.
 */
export function appProved(write = false): Promise<boolean> {
  if (!proofKey) return Promise.resolve(true);
  if (useApp.getState().state === "impostor") return Promise.resolve(false);
  if (write) {                    // each its own question, in turn, so writes go in the order they were made
    const proved = writing.then(askApp);
    writing = proved;
    return proved;
  }
  asking ??= askApp().finally(() => { asking = undefined; });
  return asking;
}

if (runtimeToken) {
  // Old tabs cannot submit cached data to a new public instance at the same port.
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.origin !== window.location.origin) return nativeFetch!(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (!await appProved(method !== "GET" && method !== "HEAD")) throw new TypeError("SuperBookmarks isn't answering at this address.");
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    headers.set("X-SBM-Instance", runtimeToken);
    return nativeFetch!(input, { ...init, headers });
  };
  if (proofKey) {
    // A tab left open also asks by itself: it covers itself before its pictures ask anything of whatever answers
    // now, and carries on when the app is back.
    const check = () => { if (document.visibilityState === "visible") void appProved(); };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    setInterval(check, 5000);
    useApp.subscribe(({ state }) => {
      document.getElementById("root")?.toggleAttribute("inert", state !== "proved");
      // A modal dialog stays usable inside an inert page.
      if (state !== "proved") document.querySelectorAll("dialog[open]").forEach(dialog => (dialog as HTMLDialogElement).close());
    });
    // Nothing on the page needs them any more, and a window that gets a handle on it shouldn't find them.
    for (const name of ["sbm-cache-key", "sbm-proof-key", "sbm-cache-new"]) document.querySelector(`meta[name="${name}"]`)?.remove();
  }
}
