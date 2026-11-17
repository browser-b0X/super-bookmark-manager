// Before the extension sends its token, a page address or posts anywhere, the app at the configured address
// proves it is the SuperBookmarks this browser paired with: it answers a random nonce with an HMAC, keyed by
// the token's SHA-256, of the nonce and the address it really listens on, which only the two of them can work
// out. A program that took the port while SuperBookmarks wasn't running gets nothing, and passing on the real
// app's answer from another port doesn't match this address. Asked afresh every time (nothing is remembered:
// the port could change hands in between). Shared by background.js and options.js.

const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(text) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

async function hmacHex(keyText, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(keyText), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))));
}

/** "ok", "unknown" (the app doesn't know this browser any more), "away" (nothing answers) or
 *  "impostor" (something answers, but not the app this browser paired with). */
async function checkApp(app, id, token) {
  if (!token || !id) return "unknown";
  let origin;
  try { origin = new URL(app).origin; } catch { return "away"; }
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  let response;
  try {
    response = await fetch(`${origin}/api/extension/hello?id=${encodeURIComponent(id)}&nonce=${nonce}`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
  } catch { return "away"; }
  if (response.status === 404) return "unknown";
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.proof !== "string") return "impostor";
  return await hmacHex(await sha256Hex(token), `${nonce}|${origin}`) === data.proof ? "ok" : "impostor";
}
