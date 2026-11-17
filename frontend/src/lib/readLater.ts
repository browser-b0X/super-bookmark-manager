import type { SavedPost } from "../types";
import { bookmarkPost, isoFromUnixSeconds, type BookmarkImportResult } from "./bookmarks";

/**
 * Pocket and Instapaper exports (read-later apps). Pocket gave a CSV (title, url, time_added, tags,
 * status; some exports add a cursor column) and, earlier, an HTML page of links; Instapaper gives a CSV
 * (URL, Title, Selection, Folder, Timestamp). Columns are found by their header names, so a column
 * added or moved doesn't break the import. Unread links go to Inbox, archived ones to Kept
 * ("reference"); tags and the date each link was saved are kept (owner, 2026-10-23).
 */

export type ReadLaterSource = "Pocket" | "Instapaper";
export interface ReadLaterSummary { source: ReadLaterSource; unread: number; archived: number; starred: number; tagged: number }
export type ReadLaterResult = BookmarkImportResult & { readLater?: ReadLaterSummary };

/** RFC 4180 rows: quoted fields may hold commas, doubled quotes and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  const body = text.replace(/^﻿/, "");
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && body[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(cell => cell !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(cell => cell !== "")) rows.push(row);
  return rows;
}

const header = (row: string[]) => row.map(cell => cell.trim().toLowerCase());

/** Which read-later app wrote this CSV, from its header row; null for any other file. */
export function readLaterCsvSource(text: string): ReadLaterSource | null {
  const firstLine = text.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
  if (firstLine.length > 500) return null;
  const columns = header(parseCsv(firstLine)[0] ?? []);
  if (!columns.includes("url")) return null;
  if (columns.includes("time_added") || (columns.includes("status") && columns.includes("title"))) return "Pocket";
  if (columns.includes("folder") || columns.includes("selection") || columns.includes("timestamp")) return "Instapaper";
  return null;
}

/** Pocket's older HTML export: a page titled "Pocket Export" with Unread and Read Archive lists. */
export function looksLikePocketHtml(text: string): boolean {
  const head = text.slice(0, 4000);
  return /<title>\s*Pocket Export\s*<\/title>/i.test(head) || (/<h1>\s*Unread\s*<\/h1>/i.test(head) && /time_added=/i.test(text.slice(0, 20000)));
}

const splitTags = (value: string) => [...new Set(value.split(/[|,]/).map(tag => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 20);

interface Entry { url: string; title?: string; savedAt?: string; tags: string[]; archived: boolean; starred: boolean; folder?: string }

function collect(source: ReadLaterSource, entries: Entry[]): ReadLaterResult {
  const result: ReadLaterResult = { posts: [], duplicates: 0, unsupported: 0, malformed: 0 };
  const summary: ReadLaterSummary = { source, unread: 0, archived: 0, starred: 0, tagged: 0 };
  const seen = new Set<string>();
  for (const entry of entries) {
    let parsed: URL;
    try { parsed = new URL(entry.url.trim()); } catch { result.malformed++; continue; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") { result.unsupported++; continue; }
    if (seen.has(parsed.href)) { result.duplicates++; continue; }
    seen.add(parsed.href);
    const post: SavedPost = {
      ...bookmarkPost(parsed.href, entry.title, entry.savedAt, entry.folder ? [entry.folder] : []),
      status: entry.archived ? "reference" : "inbox",
      ...(entry.tags.length ? { tags: entry.tags } : {}),
      ...(entry.starred ? { favorite: true } : {}),
    };
    if (entry.archived) summary.archived++; else summary.unread++;
    if (entry.starred) summary.starred++;
    if (entry.tags.length) summary.tagged++;
    result.posts.push(post);
  }
  if (!result.posts.length) {
    return { ...result, error: `No web links were found in this ${source} export. ${result.unsupported} non-web and ${result.malformed} unreadable entries skipped.` };
  }
  return { ...result, readLater: summary };
}

export function parseReadLaterCsv(text: string): ReadLaterResult {
  const source = readLaterCsvSource(text);
  const rows = parseCsv(text);
  if (!source || rows.length < 2) return { posts: [], duplicates: 0, unsupported: 0, malformed: 0, error: "This CSV isn't a Pocket or Instapaper export, or it has no links." };
  const columns = header(rows[0]);
  const at = (name: string) => columns.indexOf(name);
  const [url, title, time, tags, status, folder, stamp] = ["url", "title", "time_added", "tags", "status", "folder", "timestamp"].map(at);
  const entries = rows.slice(1).map((row): Entry => {
    const cell = (i: number) => (i >= 0 ? row[i] ?? "" : "").trim();
    if (source === "Pocket") {
      return { url: cell(url), title: cell(title) || undefined, savedAt: isoFromUnixSeconds(cell(time)), tags: splitTags(cell(tags)),
        archived: /^(archive|archived|read)$/i.test(cell(status)), starred: false };
    }
    const place = cell(folder);
    const named = place && !/^(unread|archive|starred)$/i.test(place) ? place : undefined;
    return { url: cell(url), title: cell(title) || undefined, savedAt: isoFromUnixSeconds(cell(stamp)), tags: splitTags(cell(tags)),
      archived: /^archive$/i.test(place), starred: /^starred$/i.test(place), folder: named };
  });
  return collect(source, entries);
}

/** Pocket's older HTML export, read without attaching it to the page (template contents are inert). */
export function parsePocketHtml(text: string): ReadLaterResult {
  const template = document.createElement("template");
  template.innerHTML = text;
  const entries: Entry[] = [];
  let archived = false;
  for (const node of template.content.querySelectorAll("h1, a")) {
    // "Unread", then "Read Archive" ("read" alone would match "Unread").
    if (node.tagName === "H1") { archived = /archive/i.test(node.textContent ?? ""); continue; }
    entries.push({ url: node.getAttribute("href") ?? "", title: node.textContent?.trim() || undefined,
      savedAt: isoFromUnixSeconds(node.getAttribute("time_added")), tags: splitTags(node.getAttribute("tags") ?? ""), archived, starred: false });
  }
  return collect("Pocket", entries);
}
