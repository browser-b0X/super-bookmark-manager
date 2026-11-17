// Options: the app's address, pairing with a one-time code, the check-mark switch, and the Download buttons per site.
const DEFAULTS = { app: "http://127.0.0.1:5001", token: "", connId: "", checkMark: false, marks: { x: false, instagram: false, tiktok: false } };
// Each site is asked for only when its Download button is switched on (and given back when switched off).
const SITES = {
  x: { origins: ["https://x.com/*", "https://twitter.com/*"], hosts: "x.com and twitter.com" },
  instagram: { origins: ["https://www.instagram.com/*"], hosts: "instagram.com" },
  tiktok: { origins: ["https://www.tiktok.com/*"], hosts: "tiktok.com" },
};
const $ = id => document.getElementById(id);
const status = (text, tone = "") => { $("status").textContent = text; $("status").className = `status ${tone}`; };
const showSite = (site, on) => {
  $(`marks-${site}`).setAttribute("aria-checked", String(on));
  $(`marks-${site}-note`).textContent = on ? `Allowed: ${SITES[site].hosts}` : `Asks your browser for ${SITES[site].hosts} when you turn it on`;
};

/** Only the app on this computer: http://127.0.0.1, any port (the extension may only reach that address). */
function appAddress(value) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

function browserName() {
  const agent = navigator.userAgent;
  if (/Firefox\//.test(agent)) return "Firefox";
  if (/Edg\//.test(agent)) return "Edge";
  if (navigator.brave) return "Brave";
  return "Chrome";
}

async function load() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  $("app").value = s.app;
  $("checkMark").setAttribute("aria-checked", String(s.checkMark && await chrome.permissions.contains({ permissions: ["tabs"] })));
  for (const [site, { origins }] of Object.entries(SITES)) {
    showSite(site, !!(s.marks && s.marks[site]) && await chrome.permissions.contains({ origins }).catch(() => false));
  }
  const { structureMenu } = await chrome.storage.local.get("structureMenu");
  $("structureMenu").setAttribute("aria-checked", String(!!structureMenu));
  if (!s.token) { status("Not connected yet."); return; }
  const app = await checkApp(s.app, s.connId, s.token);
  if (app === "away") { status("Connected, but SuperBookmarks isn't running right now. Start it to save pages.", "warn"); return; }
  if (app === "impostor") { status("Something else is answering at this app address, so the extension sends it nothing. Check the address, or start SuperBookmarks.", "warn"); return; }
  if (app === "unknown") { status("SuperBookmarks doesn't know this browser any more (it was disconnected in Settings). Enter a new pairing code.", "warn"); return; }
  try {
    const response = await fetch(`${s.app}/api/extension/ping`, { headers: { "X-SBM-Pair": s.token }, cache: "no-store" });
    if (response.ok) status("● Connected to SuperBookmarks on this computer.", "ok");
    else status("SuperBookmarks doesn't know this browser any more (it was disconnected in Settings). Enter a new pairing code.", "warn");
  } catch {
    status("Connected, but SuperBookmarks isn't running right now. Start it to save pages.", "warn");
  }
}

$("app").addEventListener("change", async () => {
  const app = appAddress($("app").value);
  if (!app) { status("The app address is http://127.0.0.1 and a port, for example http://127.0.0.1:5001.", "warn"); return; }
  $("app").value = app;
  await chrome.storage.local.set({ app });
});

$("connect").addEventListener("click", async () => {
  const app = appAddress($("app").value);
  if (!app) { status("The app address is http://127.0.0.1 and a port, for example http://127.0.0.1:5001.", "warn"); return; }
  const code = $("code").value.trim();
  if (!code) { status("Enter the pairing code from SuperBookmarks' Settings.", "warn"); return; }
  $("connect").disabled = true;
  try {
    // Firefox asks for access to the app's address the first time (Chrome grants it at install).
    await chrome.permissions.request({ origins: ["http://127.0.0.1/*"] }).catch(() => true);
    // The code stays here. The app shows first that it knows it, so whatever else listens at this address gets nothing
    // to work the code out from, and can't get this browser paired with it.
    const typed = code.toUpperCase().replace(/[-\s]/g, "");
    const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
    const pair = async body => {
      const response = await fetch(`${app}/api/extension/pair`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      return { ok: response.ok, ...await response.json().catch(() => ({})) };
    };
    const first = await pair({ nonce });
    const notTheApp = "That code isn't right, or something other than SuperBookmarks is answering at this app address, so nothing was connected. Check both in SuperBookmarks' Settings.";
    if (first.ok && typeof first.challenge === "string" && first.proof !== await hmacHex(typed, `app|${nonce}|${first.challenge}|${app}`)) {
      status(notTheApp, "warn");
      return;
    }
    const data = first.ok && typeof first.challenge === "string"
      ? await pair({ nonce, proof: await hmacHex(typed, `browser|${nonce}|${first.challenge}|${app}`), browser: browserName() }) : first;
    if (data.ok && data.token && data.id) {
      if (data.proof !== await hmacHex(typed, `token|${nonce}|${first.challenge}|${app}|${data.id}|${data.token}`)) {
        status(notTheApp, "warn");
        return;
      }
      await chrome.storage.local.set({ app, token: data.token, connId: data.id });
      $("code").value = "";
      status("● Connected to SuperBookmarks on this computer.", "ok");
      return;
    }
    status({
      expired: "That code has expired or was already used. Show a new one in SuperBookmarks' Settings.",
      used_up: "Too many wrong tries: that code stopped working. Show a new one in SuperBookmarks' Settings.",
      too_many: "SuperBookmarks already has 10 browsers connected. Disconnect one in Settings first.",
    }[data.error] ?? "That code isn't right. Check it in SuperBookmarks' Settings and try again.", "warn");
  } catch {
    status("SuperBookmarks didn't answer. Is it running, and is the app address right?", "warn");
  } finally {
    $("connect").disabled = false;
  }
});

$("checkMark").addEventListener("click", async () => {
  const on = $("checkMark").getAttribute("aria-checked") !== "true";
  if (on) {
    const granted = await chrome.permissions.request({ permissions: ["tabs"] });
    if (!granted) return;
  } else {
    await chrome.permissions.remove({ permissions: ["tabs"] }).catch(() => false);
  }
  await chrome.storage.local.set({ checkMark: on });
  $("checkMark").setAttribute("aria-checked", String(on));
});

for (const [site, { origins }] of Object.entries(SITES)) {
  $(`marks-${site}`).addEventListener("click", async () => {
    const on = $(`marks-${site}`).getAttribute("aria-checked") !== "true";
    // The browser asks the owner (this must be the first thing the click does).
    if (on && !(await chrome.permissions.request({ origins }).catch(() => false))) return;
    if (!on) await chrome.permissions.remove({ origins }).catch(() => false);
    const { marks } = { ...DEFAULTS, ...(await chrome.storage.local.get("marks")) };
    await chrome.storage.local.set({ marks: { ...DEFAULTS.marks, ...marks, [site]: on } });
    showSite(site, on);
  });
}

$("structureMenu").addEventListener("click", async () => {
  const on = $("structureMenu").getAttribute("aria-checked") !== "true";
  await chrome.storage.local.set({ structureMenu: on });
  $("structureMenu").setAttribute("aria-checked", String(on));
});

void load();
