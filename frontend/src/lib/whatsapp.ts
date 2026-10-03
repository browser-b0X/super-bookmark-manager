import type { SavedPost } from "../types";
import type { BookmarkImportResult } from "./bookmarks";
import { postFromUrl } from "./providers";

/*
 * WhatsApp "Export chat" files. Phones export either a plain text file
 * (Android: "WhatsApp Chat with Sam.txt") or a .zip holding `_chat.txt`
 * (iPhone). Desktop and Web cannot export. The usual trick is to send links to
 * yourself ("Message yourself") and export that chat "Without media".
 *
 * Line shapes vary by phone and locale:
 *   12/31/25, 9:41 PM - Sam: text               (Android, US)
 *   31/12/2025, 21:41 - Sam: text                (Android, most locales)
 *   [31/12/2025, 21:41:05] Sam: text             (iPhone)
 *   31.12.25, 21:41 - Sam: text                  (dotted dates)
 * A line that does not start with a date continues the previous message.
 */

const HEADER = /^‎?\[?(\d{1,4})[./-](\d{1,2})[./-](\d{1,4}),?\s+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?[\s  ]*([AaPp]\.?\s?[Mm]\.?)?\]?\s*(?:[-–]\s*)?(.*)$/;
const URL_RE = /https?:\/\/[^\s"'<>]+/gi;
const OMITTED = /^‎?(?:<Media omitted>|<attached: .*>|(?:image|video|audio|sticker|GIF|document) omitted|This message was deleted|You deleted this message|null)$/i;

interface Line { a: number; b: number; c: number; h: number; m: number; s: number; ampm: string; rest: string }
interface Message { at?: string; sender: string; text: string }

function dateOrder(lines: Line[]): "dmy" | "mdy" | "ymd" {
  if (lines.some(l => l.a > 31)) return "ymd";
  if (lines.some(l => l.a > 12)) return "dmy";
  if (lines.some(l => l.b > 12)) return "mdy";
  // Every day so far is ≤ 12: follow the browser's locale, which is the phone owner's most of the time.
  return /^en-(US|PH|CA)$/i.test(navigator.language || "") ? "mdy" : "dmy";
}

function instant(l: Line, order: "dmy" | "mdy" | "ymd"): string | undefined {
  let [year, month, day] = order === "ymd" ? [l.a, l.b, l.c] : order === "dmy" ? [l.c, l.b, l.a] : [l.c, l.a, l.b];
  if (year < 100) year += 2000;
  let hour = l.h;
  const pm = /^p/i.test(l.ampm), am = /^a/i.test(l.ampm);
  if (pm && hour < 12) hour += 12;
  if (am && hour === 12) hour = 0;
  // Exports carry the phone's local wall-clock time; read it as local time here.
  const date = new Date(year, month - 1, day, hour, l.m, l.s);
  return Number.isNaN(date.getTime()) || date.getMonth() !== month - 1 ? undefined : date.toISOString();
}

export function looksLikeWhatsAppChat(text: string): boolean {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter(Boolean).slice(0, 20);
  return lines.length > 0 && lines.filter(line => HEADER.test(line)).length >= Math.max(1, Math.ceil(lines.length / 3));
}

export function splitMessages(text: string): Message[] {
  const raw: (Line | string)[] = [];
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const m = HEADER.exec(line);
    if (m) raw.push({ a: +m[1], b: +m[2], c: +m[3], h: +m[4], m: +m[5], s: +(m[6] || 0), ampm: m[7] || "", rest: m[8] });
    else raw.push(line);
  }
  const headers = raw.filter((x): x is Line => typeof x !== "string");
  const order = dateOrder(headers);
  const out: Message[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      if (out.length) out[out.length - 1].text += "\n" + item;
      continue;
    }
    const colon = item.rest.indexOf(": ");
    const sender = colon > 0 && colon < 60 ? item.rest.slice(0, colon).replace(/^‎/, "") : "";
    out.push({ at: instant(item, order), sender, text: sender ? item.rest.slice(colon + 2) : item.rest });
  }
  return out;
}

function urlsIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(URL_RE)) {
    let url = match[0].replace(/[.,;:!?…]+$/, "");
    for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
      while (url.endsWith(close) && url.split(close).length > url.split(open).length) url = url.slice(0, -1);
    }
    found.push(url);
  }
  return found;
}

/** Turn a chat export into library links (one per distinct URL, first mention wins). */
export function parseWhatsAppChat(text: string, chatName = ""): BookmarkImportResult & { messages: number } {
  const result = { posts: [] as SavedPost[], duplicates: 0, unsupported: 0, malformed: 0, messages: 0 };
  const messages = splitMessages(text);
  if (!messages.length) return { ...result, error: "This doesn't look like a WhatsApp chat export. Export the chat from your phone (Without media) and choose the .txt or .zip." };
  result.messages = messages.length;
  const seen = new Set<string>();
  const folder = ["WhatsApp", ...(chatName ? [chatName] : [])];
  for (const msg of messages) {
    if (OMITTED.test(msg.text.trim())) continue;
    for (const url of urlsIn(msg.text)) {
      let target: URL;
      try { target = new URL(url); } catch { result.malformed++; continue; }
      if (target.protocol !== "http:" && target.protocol !== "https:") { result.unsupported++; continue; }
      if (seen.has(target.href)) { result.duplicates++; continue; }
      seen.add(target.href);
      const post = postFromUrl(target.href, "whatsapp");
      const caption = msg.text.trim();
      result.posts.push({
        ...post,
        excerpt: caption && caption !== url ? caption : undefined,
        createdAt: msg.at ?? post.createdAt,
        folderPath: folder,
      });
    }
  }
  return result;
}

/** "WhatsApp Chat with Sam.txt" / "WhatsApp Chat - Sam.zip" → "Sam". */
export function chatNameFrom(fileName: string): string {
  const base = fileName.replace(/\.(txt|zip)$/i, "").replace(/^_chat$/i, "");
  const m = /^WhatsApp Chat (?:with|-|–)\s*(.+)$/i.exec(base);
  return (m ? m[1] : base).trim().slice(0, 80);
}

/* ── Minimal ZIP reader for the iPhone export (no extra dependency) ── */

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Return the text of `_chat.txt` (or the first .txt) inside a zip, or null. */
export async function chatTextFromZip(file: Blob): Promise<string | null> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // End of central directory: scan back over a possible comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const entries = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  let best: { method: number; size: number; offset: number; name: string } | null = null;
  for (let n = 0; n < entries && p + 46 <= buf.length; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) return null;
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true), extraLen = view.getUint16(p + 30, true), commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = decoder.decode(buf.subarray(p + 46, p + 46 + nameLen));
    if (/(^|\/)_chat\.txt$/i.test(name) || (!best && /\.txt$/i.test(name) && !name.startsWith("__MACOSX"))) {
      best = { method, size, offset, name };
      if (/_chat\.txt$/i.test(name)) break;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!best || view.getUint32(best.offset, true) !== 0x04034b50) return null;
  const start = best.offset + 30 + view.getUint16(best.offset + 26, true) + view.getUint16(best.offset + 28, true);
  const data = buf.subarray(start, start + best.size);
  if (best.method === 0) return decoder.decode(data);
  if (best.method === 8) return decoder.decode(await inflate(data));
  return null;
}
