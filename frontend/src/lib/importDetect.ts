import { isFirefoxJsonBackup } from "./firefoxJson";
import { chatTextFromZip, looksLikeWhatsAppChat } from "./whatsapp";

export type ImportFormat = "html" | "chromium" | "firefox-json" | "firefox-db" | "telegram" | "whatsapp" | "unknown";

export const FORMAT_LABELS: Record<ImportFormat, string> = {
  html: "Bookmarks HTML export",
  chromium: "Chrome / Edge / Brave Bookmarks file",
  "firefox-json": "Firefox bookmarks backup (JSON)",
  "firefox-db": "Firefox places.sqlite copy",
  telegram: "Telegram Saved Messages export",
  whatsapp: "WhatsApp chat export",
  unknown: "Unrecognised file",
};

/** Decide what a dropped file is from its first bytes, never its name. */
export async function detectImportFormat(file: Blob): Promise<{ format: ImportFormat; text?: string }> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const sqlite = [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00];
  if (head.length === 16 && sqlite.every((b, i) => head[i] === b)) return { format: "firefox-db" };
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    // The iPhone's WhatsApp export is a zip holding _chat.txt.
    const chat = await chatTextFromZip(file).catch(() => null);
    return chat && looksLikeWhatsAppChat(chat) ? { format: "whatsapp", text: chat } : { format: "unknown" };
  }
  const text = await file.text();
  const body = text.replace(/^﻿/, "").trimStart();
  if (/^(?:<!--[\s\S]*?-->\s*)*<!DOCTYPE\s+NETSCAPE-Bookmark-file-1/i.test(body)) return { format: "html", text };
  if (body.startsWith("{")) {
    try {
      const data = JSON.parse(body) as Record<string, unknown>;
      if (data && typeof data === "object" && data.roots && typeof data.roots === "object") return { format: "chromium", text };
      if (isFirefoxJsonBackup(data)) return { format: "firefox-json", text };
      if (Array.isArray(data.messages)) return { format: "telegram", text };
    } catch { /* fall through */ }
  }
  if (looksLikeWhatsAppChat(body)) return { format: "whatsapp", text };
  return { format: "unknown", text };
}
