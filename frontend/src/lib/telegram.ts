// Offline Telegram Desktop single-chat JSON import. First occurrence of a URL
// supplies its message metadata; reimports never replace existing curation.
import type { SavedPost } from "../types";
import { postFromUrl } from "./providers";

export interface ImportResult {
  posts: SavedPost[];
  skipped: number;
  duplicates: number;
  unsupported: number;
  ignored: number;
  messages: number;
  errors: string[];
}

interface TgEntity { type: string; text?: string; href?: string }
interface TgMessage {
  id?: number | string;
  type: "message" | "service";
  date?: string;
  text?: string | (string | TgEntity)[];
  text_entities?: TgEntity[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isEntity(value: unknown): value is TgEntity {
  return isObject(value) && typeof value.type === "string"
    && (typeof value.text === "string" || (value.type === "link" && typeof value.href === "string"))
    && (value.href === undefined || typeof value.href === "string")
    && (value.type !== "text_link" || typeof value.href === "string");
}

function isMessage(value: unknown): value is TgMessage {
  if (!isObject(value) || (value.type !== "message" && value.type !== "service")) return false;
  if (value.id !== undefined && !(Number.isSafeInteger(value.id) || (typeof value.id === "string" && value.id.length > 0))) return false;
  if (value.date !== undefined && (typeof value.date !== "string" || Number.isNaN(Date.parse(value.date)))) return false;
  if (value.type === "service") return true;
  return (value.text === undefined || typeof value.text === "string"
      || (Array.isArray(value.text) && value.text.every(part => typeof part === "string" || isEntity(part))))
    && (value.text_entities === undefined || (Array.isArray(value.text_entities) && value.text_entities.every(isEntity)));
}

function extractText(msg: TgMessage): string {
  if (typeof msg.text === "string") return msg.text;
  return (msg.text ?? msg.text_entities ?? []).map(part => typeof part === "string" ? part : part.text ?? "").join("");
}

function extractUrls(msg: TgMessage): Set<string> {
  const urls = new Set<string>();
  // Desktop's text_entities describes the complete text, including labeled
  // targets. Prefer it to scanning labels or counting its mirrored text twice.
  const parts = msg.text_entities?.length ? msg.text_entities : Array.isArray(msg.text) ? msg.text : [msg.text ?? ""];
  for (const part of parts) {
    if (typeof part !== "string" && (part.type === "text_link" || part.type === "link")) {
      urls.add((part.href ?? part.text ?? "").trim());
    } else {
      for (const match of (typeof part === "string" ? part : part.text ?? "").matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
        // Plain-text fallback: discard sentence punctuation and unmatched closing
        // brackets; explicit link entities above retain their exact target.
        let url = match[0].replace(/[.,;!?]+$/, "");
        for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
          while (url.endsWith(close) && url.split(close).length > url.split(open).length) url = url.slice(0, -1);
        }
        urls.add(url);
      }
    }
  }
  return urls;
}

export function parseTelegramExport(raw: string): ImportResult {
  const result: ImportResult = { posts: [], skipped: 0, duplicates: 0, unsupported: 0, ignored: 0, messages: 0, errors: [] };
  const fail = (message: string): ImportResult => ({ ...result, posts: [], errors: [message] });
  if (!raw.trim()) return fail("The Telegram JSON file is empty. Export Saved Messages as JSON and try again.");
  let data: unknown;
  try { data = JSON.parse(raw.replace(/^\uFEFF/, "")); }
  catch { return fail("File is not valid JSON. Choose result.json from a Telegram Desktop Saved Messages chat export."); }
  if (!isObject(data) || !Array.isArray(data.messages) || (data.type !== undefined && data.type !== "saved_messages")) {
    return fail("Unsupported export: expected a Saved Messages chat with a top-level messages array. Whole-account archives are not supported; export the Saved Messages chat separately.");
  }
  if (!data.messages.length) return fail("No messages found in this export. Check the selected chat and export date range.");
  // Validate every entry first: a bad later message must not partially import.
  if (!data.messages.every(isMessage)) return fail("Malformed message or text entity in the Telegram export. No links were imported; export the chat again as JSON.");

  result.messages = data.messages.length;
  const seen = new Set<string>();
  for (const msg of data.messages) {
    if (msg.type !== "message") { result.ignored++; continue; }
    const text = extractText(msg);
    let eligible = false;
    for (const url of extractUrls(msg)) {
      let target: URL;
      try { target = new URL(url); }
      catch { result.unsupported++; continue; }
      if (target.protocol !== "http:" && target.protocol !== "https:") { result.unsupported++; continue; }
      eligible = true;
      const canonical = target.href; // same identity as the bookmark importer
      if (seen.has(canonical)) { result.duplicates++; continue; }
      seen.add(canonical);
      const messageId = msg.id === undefined ? undefined : String(msg.id);
      const post = postFromUrl(url, "telegram");
      result.posts.push({
        ...post,
        id: `tg-json-${btoa(canonical).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`,
        canonicalUrl: canonical,
        sourceMessageId: messageId,
        telegramMessage: { id: messageId, date: msg.date, text },
        excerpt: text || undefined,
        createdAt: msg.date ?? post.createdAt,
        thumbnailUrl: undefined,
      });
    }
    if (!eligible) result.skipped++;
  }
  return result;
}
