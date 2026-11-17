import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { cacheKey, cacheKeyIsNew } from "./publicRuntime";

/**
 * The library cache as the installed app keeps it in the browser: sealed with a key only the app's own pages get.
 *
 * Browser storage belongs to an address, not to a program. While the app is off anyone on this PC can listen on its
 * port, and a page of theirs at that address can read what is stored there. Without the key it reads nothing, and it
 * can't change the cache: a sealed copy that was tampered with doesn't open, and a plain one doesn't count, or what it
 * plants would be sent to the app as this browser's unsaved edits. What can't be opened is dropped, and SQLite refills
 * the library. The one plain copy that counts is the old cache, read when a page first loads in the run that made the
 * key. A source run gets no key and keeps the cache as plain text.
 *
 * Synchronous on purpose: the last change must reach the cache while a tab is closing, which WebCrypto can't promise.
 */
const NONCE = 24;
const PREFIX = "sbm-sealed-1:";
const encoder = new TextEncoder();
const key = cacheKey ? Uint8Array.from(cacheKey.match(/../g) ?? [], byte => parseInt(byte, 16)) : undefined;

export const sealing = key !== undefined;

/** The nonce, then the sealed text. The cache's name is sealed in, so a copy can't be passed off as another one. */
export function seal(name: string, value: string): Uint8Array {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE));
  const sealed = xchacha20poly1305(key!, nonce, encoder.encode(name)).encrypt(encoder.encode(value));
  const stored = new Uint8Array(NONCE + sealed.length);
  stored.set(nonce);
  stored.set(sealed, NONCE);
  return stored;
}

/** The text, or null when it can't be opened: another key, or changed since it was sealed. */
function open(name: string, stored: Uint8Array): string | null {
  if (!key || stored.length < NONCE) return null;
  try {
    const nonce = stored.subarray(0, NONCE);
    return new TextDecoder().decode(xchacha20poly1305(key, nonce, encoder.encode(name)).decrypt(stored.subarray(NONCE)));
  } catch {
    return null;
  }
}

/** The same as text, for localStorage, which holds nothing else. */
export function sealText(name: string, value: string): string {
  const stored = seal(name, value);
  let binary = "";
  for (let i = 0; i < stored.length; i += 0x8000) binary += String.fromCharCode(...stored.subarray(i, i + 0x8000));
  return PREFIX + btoa(binary);
}

function openText(name: string, raw: string): string | null {
  try {
    const binary = atob(raw.slice(PREFIX.length));
    const stored = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) stored[i] = binary.charCodeAt(i);
    return open(name, stored);
  } catch {
    return null;
  }
}

const read = new Set<string>();

/** Is this the page's first read of a store? Only that one can be the old cache: a tab left open can outlive its run. */
export function firstRead(name: string): boolean {
  const first = !read.has(name);
  read.add(name);
  return first;
}

/** What a stored copy holds, or null when it doesn't count. `first`: from `firstRead`. */
export function opened(name: string, stored: unknown, first: boolean): string | null {
  if (stored instanceof Uint8Array) return open(name, stored);
  if (typeof stored !== "string") return null;
  if (stored.startsWith(PREFIX)) return openText(name, stored);
  return !sealing || (cacheKeyIsNew && first) ? stored : null;
}

/** localStorage, sealed: for settings that start things by themselves. A plain copy that counts is sealed at once. */
export const sealedStorage = {
  getItem(name: string): string | null {
    const first = firstRead(name);
    const raw = localStorage.getItem(name);
    const text = raw === null ? null : opened(name, raw, first);
    try {
      if (sealing && text !== null && text === raw) localStorage.setItem(name, sealText(name, text));
    } catch { /* full: it is sealed with the next change */ }
    return text;
  },
  setItem(name: string, value: string) { localStorage.setItem(name, sealing ? sealText(name, value) : value); },
  removeItem(name: string) { localStorage.removeItem(name); },
};
