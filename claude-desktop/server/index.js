#!/usr/bin/env node
// SuperBookmarks for Claude Desktop: a small MCP server on stdio. It lets Claude search the owner's library, list
// shelves and unfiled links, read one link with its saved copy's text, file links on an existing shelf and
// suggest a new shelf, by talking to the SuperBookmarks app on this computer (127.0.0.1) only. The app does every
// change, and every change can be undone there. No dependencies: Node's own fetch and crypto.
//
// Settings come from Claude Desktop (manifest user_config): SBM_TOKEN (made in SuperBookmarks' Settings, kept by
// Claude Desktop in the system's keychain) and SBM_APP (the app's address, http://127.0.0.1:5001 by default).
"use strict";
const crypto = require("node:crypto");
const readline = require("node:readline");

// The bundle's manifest.json carries the release's version (claude-desktop/build.py writes it).
const VERSION = (() => { try { return String(require("../manifest.json").version || "0"); } catch { return "0"; } })();
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const TOKEN = (process.env.SBM_TOKEN || "").trim();
const APP = appAddress(process.env.SBM_APP || "http://127.0.0.1:5001");

/** Only the app on this computer: http://127.0.0.1 and a port, written out as the app names its own address. */
function appAddress(value) {
  try {
    const url = new URL(String(value).trim());
    if (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password) {
      return `http://127.0.0.1:${url.port || "80"}`;
    }
  } catch { /* not an address */ }
  return "";
}

const TOOLS = [
  { name: "search_links", description: "Search the SuperBookmarks library (titles, addresses, sites, shelves, tags, notes and summaries). Returns at most 50 links, newest first, each with its id.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Words to look for" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, required: ["query"] } },
  { name: "list_shelves", description: "The library's shelves, with how many links each holds and its description.",
    inputSchema: { type: "object", properties: {} } },
  { name: "list_unfiled", description: "Links that are on no shelf yet, newest first, 50 a page.",
    inputSchema: { type: "object", properties: { page: { type: "integer", minimum: 1 } } } },
  { name: "get_link", description: "One link (by its id from search_links or list_unfiled) with the text of its saved copy, if it has one (first 20,000 characters).",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "file_links", description: "Put links (by id, at most 100) on an existing shelf, optionally adding tags. SuperBookmarks makes the change and the owner can undo it there.",
    inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "string" }, maxItems: 100 }, shelf: { type: "string" },
      tags: { type: "array", items: { type: "string" }, maxItems: 10 } }, required: ["ids", "shelf"] } },
  { name: "suggest_shelf", description: "Suggest a new shelf (and links to put on it). Nothing changes until the owner creates it in SuperBookmarks.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, ids: { type: "array", items: { type: "string" }, maxItems: 100 } },
      required: ["name"] } },
];
// What each tool does, for Claude Desktop's permission prompts: reads change nothing; writes only add (and can be
// undone in SuperBookmarks); none reaches past the app on this computer.
const WRITES = { file_links: { idempotentHint: true }, suggest_shelf: { idempotentHint: false } };
for (const tool of TOOLS) {
  tool.annotations = tool.name in WRITES ? { readOnlyHint: false, destructiveHint: false, ...WRITES[tool.name], openWorldHint: false }
    : { readOnlyHint: true, openWorldHint: false };
}

class Refusal extends Error {}

const hex = bytes => Buffer.from(bytes).toString("hex");

/** Before the token goes anywhere, the app at the address proves it is the SuperBookmarks that made the token: an
 *  HMAC (keyed by the token's SHA-256) of a random nonce and the address it really listens on. */
async function checkApp() {
  if (!APP) throw new Refusal("The app address in the extension's settings must be http://127.0.0.1 and a port, for example http://127.0.0.1:5001.");
  if (!TOKEN) throw new Refusal("No token yet: make one in SuperBookmarks (Settings → AI providers → Claude Desktop) and paste it into this extension's settings.");
  const nonce = hex(crypto.randomBytes(16));
  const key = crypto.createHash("sha256").update(TOKEN).digest("hex");
  // Which token this is (a fingerprint of its hash), so an old token is told apart from an impostor.
  const kid = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
  let response;
  try {
    response = await fetch(`${APP}/api/mcp/hello?nonce=${nonce}&kid=${kid}`, { signal: AbortSignal.timeout(5000), redirect: "error" });
  } catch {
    throw new Refusal("SuperBookmarks isn't running on this computer (or not at the address in the extension's settings). Start it and try again.");
  }
  if (response.status === 404) throw new Refusal("SuperBookmarks doesn't know this token any more: make a new one in its Settings and paste it into this extension's settings.");
  const data = await response.json().catch(() => ({}));
  const expected = crypto.createHmac("sha256", key).update(`${nonce}|${APP}`).digest("hex");
  if (typeof data.proof !== "string" || data.proof.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(data.proof), Buffer.from(expected))) {
    throw new Refusal("Something other than SuperBookmarks answers at the app address, so nothing was sent to it.");
  }
}

async function call(path, body) {
  await checkApp();
  let response;
  try {
    response = await fetch(`${APP}${path}`, {
      method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(20000), redirect: "error",
      headers: { "X-SBM-Claude": TOKEN, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Refusal("SuperBookmarks didn't answer. Is it still running?");
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) throw new Refusal("SuperBookmarks doesn't accept this token: make a new one in its Settings and paste it into this extension's settings.");
  if (!response.ok || data.ok === false) throw new Refusal(typeof data.error === "string" ? data.error : `SuperBookmarks answered ${response.status}.`);
  return data;
}

const query = params => new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ""))).toString();
const strings = (value, max) => (Array.isArray(value) ? value.filter(v => typeof v === "string").slice(0, max) : []);

async function runTool(name, args = {}) {
  switch (name) {
    case "search_links": return call(`/api/mcp/search?${query({ q: String(args.query ?? "").slice(0, 200), limit: Number.isInteger(args.limit) ? args.limit : undefined })}`);
    case "list_shelves": return call("/api/mcp/shelves");
    case "list_unfiled": return call(`/api/mcp/unfiled?${query({ page: Number.isInteger(args.page) ? args.page : undefined })}`);
    case "get_link": return call(`/api/mcp/link?${query({ id: String(args.id ?? "").slice(0, 2000) })}`);
    case "file_links": return call("/api/mcp/file", { ids: strings(args.ids, 100), shelf: String(args.shelf ?? "").slice(0, 80), tags: strings(args.tags, 10) });
    case "suggest_shelf": return call("/api/mcp/suggest", { name: String(args.name ?? "").slice(0, 80), description: String(args.description ?? "").slice(0, 400), ids: strings(args.ids, 100) });
    default: throw new Refusal(`No tool called ${name}.`);
  }
}

// ── JSON-RPC over stdio (one message per line) ──
const send = message => process.stdout.write(JSON.stringify(message) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(message) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    if (message && message.id !== undefined) fail(message.id, -32600, "Invalid request");
    return;
  }
  const { id, method, params = {} } = message;
  const notification = id === undefined || id === null;
  try {
    if (method === "initialize") {
      const asked = params.protocolVersion;
      return reply(id, { protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: {} },
        serverInfo: { name: "superbookmarks", version: VERSION },
        instructions: "SuperBookmarks is the owner's bookmark library on this computer. Search before filing; file links only on shelves list_shelves returns; suggest a new shelf instead of inventing one." });
    }
    if (method === "notifications/initialized" || method.startsWith("notifications/")) return undefined;
    if (method === "ping") return reply(id, {});
    if (method === "tools/list") return reply(id, { tools: TOOLS });
    if (method === "tools/call") {
      try {
        const result = await runTool(params.name, params.arguments || {});
        return reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] });
      } catch (error) {
        if (error instanceof Refusal) return reply(id, { content: [{ type: "text", text: error.message }], isError: true });
        throw error;
      }
    }
    if (!notification) return fail(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    process.stderr.write(`superbookmarks: ${error && error.stack || error}\n`);
    if (!notification) fail(id, -32603, "Internal error");
  }
  return undefined;
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", line => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
  void handle(message);
});
