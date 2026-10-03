import { runtimeToken } from "../../lib/publicRuntime";
import { useEffect, useRef, useState } from "react";

type ConfigStatus = {
  api_id_configured: boolean;
  api_hash_configured: boolean;
  config_readable: boolean;
};
type ConfigAction = { action: "save"; api_id: string; api_hash: string } | { action: "clear"; confirm: true };

export default function TelegramConfig({ onConfigurationChanged }: { onConfigurationChanged?: () => void }) {
  const [config, setConfig] = useState<ConfigStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [apiId, setApiId] = useState("");
  const [apiHash, setApiHash] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const request = useRef<AbortController | null>(null);
  const configureButton = useRef<HTMLButtonElement>(null);

  const clearInputs = () => { setApiId(""); setApiHash(""); };
  const readOrUpdate = async (action?: ConfigAction) => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 10000);
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/telegram/config", {
        method: action ? "POST" : "GET",
        headers: action ? { "Content-Type": "application/json" } : undefined,
        body: action ? JSON.stringify(action) : undefined,
        cache: "no-store", signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok || !data || data.ok === false
        || typeof data.api_id_configured !== "boolean"
        || typeof data.api_hash_configured !== "boolean"
        || typeof data.config_readable !== "boolean") throw new Error("Configuration unavailable");
      if (request.current !== controller) return;
      // Keep only status booleans, never saved values or arbitrary response text.
      setConfig({ api_id_configured: data.api_id_configured,
        api_hash_configured: data.api_hash_configured, config_readable: data.config_readable });
      if (action) {
        clearInputs(); setEditing(false);
        if (data.config_readable) onConfigurationChanged?.();
        if (data.config_readable) setMessage(action.action === "save"
          ? "Developer credential settings saved. Saving is not login and does not start refresh."
          : runtimeToken ? "Saved developer credentials cleared. Your Telegram session is unchanged."
          : "Saved developer credentials cleared. Clearing does not clear environment variables or your Telegram session.");
      }
    } catch {
      if (request.current !== controller) return;
      setConfig(null);
      setError(action?.action === "save"
        ? "Save was not confirmed. Configuration status is unavailable. Check the local server and retry status before saving again."
        : action?.action === "clear"
          ? "Clear was not confirmed. Configuration status is unavailable. Check the local server and retry status."
          : "Telegram configuration status is unavailable. Check the local server, then retry.");
    } finally {
      window.clearTimeout(timer);
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  };

  useEffect(() => {
    void readOrUpdate();
    return () => { request.current?.abort(); request.current = null; };
  }, []);

  const cancel = (skip: boolean) => {
    clearInputs(); setEditing(false); setError("");
    setMessage(skip ? "Setup skipped. Inputs discarded." : "Edits canceled. Inputs discarded.");
    configureButton.current?.focus();
  };
  const save = () => {
    if (busy || !config?.config_readable) return;
    const id = apiId.trim(), hash = apiHash.trim();
    setMessage("");
    if ((!id && !config.api_id_configured) || (id && (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0))) {
      setError("Enter a positive whole-number Telegram API ID, or leave it blank to keep an already configured ID.");
      return;
    }
    if (!hash && !config.api_hash_configured) {
      setError("Enter your Telegram API hash. A blank field only keeps an already configured hash.");
      return;
    }
    void readOrUpdate({ action: "save", api_id: id, api_hash: hash });
  };
  const clear = () => {
    if (busy || !config?.config_readable) return;
    if (window.confirm("Clear saved developer credentials? This removes only the saved Telegram API ID and API hash. It does not clear environment variables or your Telegram login/session.")) {
      void readOrUpdate({ action: "clear", confirm: true });
    }
  };
  const yesNo = (value: boolean | undefined) => value === undefined ? "Unknown" : value ? "Yes" : "No";
  const configured = config?.api_id_configured || config?.api_hash_configured;

  return <section className="panel mt-5 min-w-0 w-full break-words p-5" aria-labelledby="telegram-config-heading" aria-busy={busy}>
    <h2 id="telegram-config-heading" className="text-[.9rem] font-semibold">Telegram Integration</h2>
    <p className="mt-2 text-[.76rem] text-[var(--dim)]">
      Use your Telegram developer API credentials. These are separate from your Telegram login/session.
    </p>
    <p className="mt-2 text-[.76rem] text-[var(--dim)]">
      <a href="https://my.telegram.org/auth" target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] underline">
        Get your Telegram API ID and hash
      </a>{" "}
      (opens a new tab). Sign in, choose API development tools, and create your application.
      Then return here to save its API ID and API hash.
    </p>
    <div className="mt-3 space-y-1 text-[.76rem]" aria-live="polite">
      <p>API ID configured: <b>{yesNo(config?.api_id_configured)}</b></p>
      <p>API hash configured: <b>{yesNo(config?.api_hash_configured)}</b></p>
      <p>Saved config readable: <b>{yesNo(config?.config_readable)}</b></p>
    </div>
    <p className="mt-2 text-[.72rem] text-[var(--dim)]">
      {runtimeToken ? "Keys saved here belong only to this Super Bookmark Manager profile. Inherited developer credentials are ignored."
        : "Environment variables override saved keys. Clearing does not clear environment variables."}
      These indicators describe credential configuration only; they do not check Telegram login or session authorization.
      Saving is not login and does not start refresh.
    </p>
    {config && !config.config_readable && <p role="alert" className="mt-3 text-[.76rem] text-[var(--red)]">
      {runtimeToken ? "Saved configuration is unreadable. Saved keys cannot be verified."
        : "Saved configuration is unreadable. Saved keys cannot be verified; environment credentials may still be configured."}
      Check the local server and retry before changing saved credentials.
    </p>}
    {error && <p role="alert" className="mt-3 text-[.76rem] text-[var(--red)]">{error}</p>}
    {!config && !busy && !error && <p role="alert" className="mt-3 text-[.76rem]">Telegram configuration status is unavailable. Retry to check it.</p>}
    {(!config || !config.config_readable) && <button type="button" className="btn mt-3 max-w-full whitespace-normal" disabled={busy} onClick={() => void readOrUpdate()}>Retry</button>}
    <p className="mt-3 text-[.76rem]">{config?.config_readable && config.api_id_configured && config.api_hash_configured
      ? "Developer credentials are configured. Use the Telegram Account section below to connect or check your account."
      : "Configure Telegram Saved Messages refresh now?"}</p>
    {editing && <form className="mt-3 min-w-0 space-y-3" autoComplete="off" onSubmit={e => { e.preventDefault(); save(); }}>
      <p id="telegram-credentials-hint" className="text-[.72rem] text-[var(--dim)]">
        Saved values are never shown. Leave a field blank to preserve its configured value. Use Clear to remove saved developer credentials.
      </p>
      <div className="min-w-0">
        <label htmlFor="telegram-api-id" className="mb-1 block text-[.76rem]">Telegram API ID</label>
        <input id="telegram-api-id" className="input min-w-0 w-full" type="password" inputMode="numeric" autoComplete="new-password"
          aria-describedby="telegram-credentials-hint" value={apiId} disabled={busy} autoFocus onChange={e => setApiId(e.target.value)} />
      </div>
      <div className="min-w-0">
        <label htmlFor="telegram-api-hash" className="mb-1 block text-[.76rem]">Telegram API hash</label>
        <input id="telegram-api-hash" className="input min-w-0 w-full" type="password" autoComplete="new-password"
          aria-describedby="telegram-credentials-hint" value={apiHash} disabled={busy} onChange={e => setApiHash(e.target.value)} />
      </div>
      <div className="flex min-w-0 flex-wrap gap-2">
        <button type="submit" className="btn btn-primary max-w-full whitespace-normal" disabled={busy || !config?.config_readable}>Save</button>
        <button type="button" className="btn max-w-full whitespace-normal" disabled={busy} onClick={() => cancel(false)}>Cancel</button>
      </div>
    </form>}
    <div className="mt-3 flex min-w-0 flex-wrap gap-2">
      {!editing && <button ref={configureButton} type="button" className="btn max-w-full whitespace-normal" disabled={busy || !config?.config_readable}
        onClick={() => { clearInputs(); setEditing(true); setError(""); setMessage(""); }}>{configured ? "Update credentials" : "Configure"}</button>}
      <button type="button" className="btn max-w-full whitespace-normal" disabled={busy} onClick={() => cancel(true)}>Skip</button>
      <button type="button" className="btn btn-danger max-w-full whitespace-normal" disabled={busy || !config?.config_readable} onClick={clear}>Clear</button>
    </div>
    {busy && <p role="status" className="mt-3 text-[.76rem]">Checking Telegram configuration…</p>}
    {message && <p role="status" aria-label="Telegram configuration result" className="mt-3 text-[.76rem]">{message}</p>}
  </section>;
}
