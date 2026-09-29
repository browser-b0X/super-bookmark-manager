import { useCallback, useEffect, useRef, useState } from "react";

type Status = {
  credentials_configured: boolean;
  session_exists: boolean;
  authorized: boolean | null;
  login_step: string | null;
  expires_in: number | null;
};
type Phase = "idle" | "phone" | "code" | "password";

/** Client-side wording per backend code; server text is never reflected verbatim. */
const MESSAGES: Record<string, string> = {
  configuration: "Configure the Telegram API ID and API hash first, then connect your account.",
  invalid_phone: "Telegram rejected that phone number. Enter it in full international form, like +15551234567.",
  code_invalid: "That verification code is incorrect. Check the code Telegram sent and try again.",
  code_expired: "That verification code expired. Start again to receive a new code.",
  password_required: "This account uses two-step verification. Enter your Telegram password.",
  password_invalid: "That two-step verification password is incorrect. Try again.",
  flood: "Telegram is rate-limiting login attempts. Wait a while, then try again.",
  network: "Could not reach Telegram. Check your connection, then try again.",
  session_locked: "The local Telegram session file is locked. Close other copies of the app, then try again.",
  session_acl: "Windows could not protect the local session file, so the login was aborted. Nothing was stored.",
  dependency: "Live Telegram login needs the packaged runtime. Use the installed app to connect.",
  revoked: "Telegram reports this session is revoked or invalid. Connect again to create a new session.",
  cancelled: "Login cancelled. No session was changed.",
  login_active: "A login is already in progress. Cancel or restart it first.",
  login_step: "That step does not match the current login state. Check the status and try again.",
  cross_origin: "Cross-origin Telegram requests are blocked. Reload the app and try again.",
  content_type: "Unexpected request format. Reload the app and try again.",
  too_large: "That request was too large. Reload the app and try again.",
  invalid: "Invalid Telegram account request.",
  unavailable: "Telegram account service is unavailable. Nothing was confirmed.",
  unauthorized: "This session file is not authorized with Telegram. Connect your account to authorize it.",
  unknown: "Telegram login failed. No session was authorized. Try again.",
};
const message = (code: unknown) =>
  (typeof code === "string" && MESSAGES[code]) || "Telegram account action failed. Nothing was confirmed. Try again.";

function toStatus(data: unknown): Status | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.credentials_configured !== "boolean" || typeof d.session_exists !== "boolean") return null;
  if (!(d.authorized === true || d.authorized === false || d.authorized === null)) return null;
  if (!(d.login_step === null || typeof d.login_step === "string")) return null;
  if (!(d.expires_in === null || typeof d.expires_in === "number")) return null;
  return {
    credentials_configured: d.credentials_configured,
    session_exists: d.session_exists,
    authorized: d.authorized,
    login_step: d.login_step,
    expires_in: d.expires_in,
  };
}

export default function TelegramAccount() {
  const [status, setStatus] = useState<Status | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const inflight = useRef<AbortController | null>(null);
  const connectButton = useRef<HTMLButtonElement>(null);

  const clearSecrets = useCallback(() => { setPhone(""); setCode(""); setPassword(""); }, []);

  /** One guarded request. Resolves to parsed JSON, or null on transport failure. */
  const call = useCallback(async (body: Record<string, unknown> | null, timeout: number):
    Promise<{ data: Record<string, unknown> | null; transport: boolean }> => {
    if (inflight.current) return { data: null, transport: false };
    const controller = new AbortController();
    inflight.current = controller;
    const timer = window.setTimeout(() => controller.abort(), timeout);
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/telegram/auth", {
        method: body ? "POST" : "GET",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store", signal: controller.signal,
      });
      const data = await response.json().catch(() => null) as Record<string, unknown> | null;
      return { data, transport: response.ok && data?.ok === true };
    } catch {
      return { data: null, transport: false };
    } finally {
      window.clearTimeout(timer);
      if (inflight.current === controller) { inflight.current = null; setBusy(false); }
    }
  }, []);

  const loadStatus = useCallback(async () => {
    const { data, transport } = await call(null, 10000);
    if (!transport) { setStatus(null); return; }
    const next = toStatus(data);
    setStatus(next);
    // Resolve real authorization for an existing session without sending a code.
    if (next?.session_exists && next.authorized === null) {
      const probe = await call({ action: "check" }, 25000);
      if (probe.transport) setStatus(toStatus(probe.data));
    }
  }, [call]);

  useEffect(() => {
    void loadStatus();
    return () => { inflight.current?.abort(); inflight.current = null; };
  }, [loadStatus]);

  const startConnect = () => {
    setNotice(""); setError("");
    if (!status?.credentials_configured) {
      setError(MESSAGES.configuration);
      return;
    }
    clearSecrets();
    setPhase("phone");
  };

  const submitPhone = async () => {
    const value = phone.trim();
    const digits = value.replace(/[\s\-.()]/g, "");
    if (!/^\+?[0-9]{7,15}$/.test(digits)) {
      setError(MESSAGES.invalid_phone);
      return;
    }
    const { data, transport } = await call({ action: "start", phone: value }, 25000);
    setPhone("");
    if (!transport) {
      const code_ = data?.code;
      setError(code_ === undefined ? MESSAGES.network : message(code_));
      if (code_ === "login_active" || code_ === "configuration") setStatus(toStatus(data) ?? status);
      return;
    }
    const next = toStatus(data);
    if (next) setStatus(next);
    if (next?.login_step === "awaiting_password") setPhase("password");
    else setPhase("code");
    setNotice("Telegram sent a verification code to your account.");
  };

  const submitCode = async () => {
    const value = code.trim();
    if (!/^[0-9]{4,8}$/.test(value)) { setError(MESSAGES.code_invalid); return; }
    const { data, transport } = await call({ action: "code", code: value }, 25000);
    setCode("");
    if (!transport) { setError(message(data?.code)); return; }
    const next = toStatus(data);
    if (next) setStatus(next);
    if (data?.result === "password_required") { setPhase("password"); setNotice(MESSAGES.password_required); return; }
    if (data?.result === "connected") { setPhase("idle"); setNotice("Connected. You can now refresh Telegram Saved Messages."); return; }
    setError(message(data?.code));
  };

  const submitPassword = async () => {
    const value = password;
    if (!value) { setError(MESSAGES.password_invalid); return; }
    const { data, transport } = await call({ action: "password", password: value }, 25000);
    setPassword("");
    if (!transport) { setError(message(data?.code)); return; }
    const next = toStatus(data);
    if (next) setStatus(next);
    if (data?.result === "connected") { setPhase("idle"); setNotice("Connected. You can now refresh Telegram Saved Messages."); return; }
    setError(message(data?.code));
  };

  const cancelLogin = async () => {
    clearSecrets();
    const { data, transport } = await call({ action: "cancel" }, 10000);
    setPhase("idle");
    if (transport) { const next = toStatus(data); if (next) setStatus(next); }
    setNotice(data?.result === "cancelled" ? MESSAGES.cancelled : "");
    connectButton.current?.focus();
  };

  const testConnection = async () => {
    setNotice("");
    const { data, transport } = await call({ action: "check" }, 25000);
    if (!transport) { setError(message(data?.code)); return; }
    const next = toStatus(data);
    if (next) setStatus(next);
    setNotice(data?.result === "connected"
      ? "Connection confirmed. This session is authorized with Telegram."
      : data?.result === "not_authorized" ? MESSAGES.unauthorized
      : message(data?.code));
  };

  const disconnect = async (mode: "logout" | "remove_local") => {
    const prompt = mode === "logout"
      ? "Log out this Telegram session? This asks Telegram to end the authorization, then removes the local session file. You will need to connect again to refresh Saved Messages."
      : "Remove the local session file only? This does NOT log out on Telegram; the authorization may remain valid there until it expires or you log out in the Telegram app.";
    if (!window.confirm(prompt)) return;
    setNotice("");
    const { data, transport } = await call({ action: "disconnect", mode }, 25000);
    if (!transport) {
      const code_ = data?.code;
      setError(message(code_));
      if (code_ === "network") setNotice("Remote log-out could not be confirmed. The local session file is still present. Use 'Remove local session only' to delete it here.");
      return;
    }
    const next = toStatus(data);
    if (next) setStatus(next);
    setPhase("idle");
    setNotice(data?.result === "logged_out" ? "Disconnected and logged out of Telegram."
      : data?.result === "removed_local" ? "Local session file removed. Telegram was not contacted."
      : "Disconnected.");
  };

  const connected = status?.authorized === true;
  const dotColor = status === null ? "var(--amber)" : connected ? "var(--green)" : "var(--red)";
  const statusLabel = status === null ? "Unknown" : connected ? "Connected" : "Not connected";
  const busyOrIdle = busy;

  return (
    <section className="panel mt-5 min-w-0 w-full break-words p-5" aria-labelledby="telegram-account-heading" aria-busy={busy}>
      <h2 id="telegram-account-heading" className="text-[.9rem] font-semibold">Telegram Account</h2>
      <p className="mt-2 text-[.76rem] text-[var(--dim)]">
        Connect your Telegram account so the app can create its own local session for Saved Messages refresh.
        This is separate from the developer API credentials above.
      </p>

      <p className="mt-3 flex items-center gap-2 text-[.8rem]">
        <span className="dot" style={{ background: dotColor }} />
        Status: <b>{statusLabel}</b>
      </p>
      <div className="mt-1 space-y-0.5 text-[.72rem] text-[var(--dim)]" aria-live="polite">
        <p>Developer credentials configured: <b>{status === null ? "Unknown" : status.credentials_configured ? "Yes" : "No"}</b></p>
        <p>Local session present: <b>{status === null ? "Unknown" : status.session_exists ? "Yes" : "No"}</b></p>
      </div>

      {!connected && status && !busyOrIdle && phase === "idle" && (
        <ol className="mt-3 list-decimal space-y-0.5 pl-5 text-[.72rem] text-[var(--faint)]">
          <li>Add your Telegram developer credentials above.</li>
          <li>Connect your Telegram account here and enter the verification code.</li>
          <li>Use Refresh Telegram Saved Messages below to pull your links.</li>
        </ol>
      )}

      {status === null && !busy && !error && (
        <p role="alert" className="mt-3 text-[.76rem] text-[var(--red)]">
          Telegram account status is unavailable. Check the local server, then retry.
        </p>
      )}
      {error && <p role="alert" className="mt-3 text-[.76rem] text-[var(--red)]">{error}</p>}

      {phase === "idle" && (
        <div className="mt-3 flex min-w-0 flex-wrap gap-2">
          {status === null && <button type="button" className="btn max-w-full whitespace-normal" disabled={busy} onClick={() => void loadStatus()}>Retry</button>}
          {!connected && status && (
            <button ref={connectButton} type="button" className="btn btn-primary max-w-full whitespace-normal"
              disabled={busy || !status.credentials_configured} onClick={startConnect}>Connect Telegram</button>
          )}
          {connected && (
            <>
              <button type="button" className="btn max-w-full whitespace-normal" disabled={busy} onClick={() => void testConnection()}>Test connection</button>
              <button type="button" className="btn btn-danger max-w-full whitespace-normal" disabled={busy} onClick={() => void disconnect("logout")}>Disconnect Telegram</button>
              <button type="button" className="btn btn-ghost max-w-full whitespace-normal" disabled={busy} onClick={() => void disconnect("remove_local")}>Remove local session only</button>
            </>
          )}
        </div>
      )}

      {!status?.credentials_configured && status && phase === "idle" && !connected && (
        <p className="mt-2 text-[.72rem] text-[var(--dim)]">
          Add your Telegram API ID and API hash in Telegram Integration above to enable Connect.
        </p>
      )}

      {phase === "phone" && (
        <form className="mt-3 min-w-0 space-y-3" autoComplete="off" onSubmit={e => { e.preventDefault(); void submitPhone(); }}>
          <div className="min-w-0">
            <label htmlFor="telegram-phone" className="mb-1 block text-[.76rem]">Telegram phone number</label>
            <input id="telegram-phone" className="input min-w-0 w-full" type="tel" inputMode="tel" autoComplete="off"
              placeholder="+15551234567" value={phone} disabled={busy} autoFocus
              aria-describedby="telegram-phone-hint" onChange={e => setPhone(e.target.value)} />
            <p id="telegram-phone-hint" className="mt-1 text-[.72rem] text-[var(--dim)]">
              Full international format. The number is used once to start login and is never stored or shown again.
            </p>
          </div>
          <div className="flex min-w-0 flex-wrap gap-2">
            <button type="submit" className="btn btn-primary max-w-full whitespace-normal" disabled={busy}>Continue</button>
            <button type="button" className="btn max-w-full whitespace-normal" disabled={busy} onClick={() => void cancelLogin()}>Cancel</button>
          </div>
        </form>
      )}

      {phase === "code" && (
        <form className="mt-3 min-w-0 space-y-3" autoComplete="off" onSubmit={e => { e.preventDefault(); void submitCode(); }}>
          <div className="min-w-0">
            <label htmlFor="telegram-code" className="mb-1 block text-[.76rem]">Verification code</label>
            <input id="telegram-code" className="input min-w-0 w-full" type="password" inputMode="numeric" autoComplete="one-time-code"
              value={code} disabled={busy} autoFocus onChange={e => setCode(e.target.value)} />
            <p className="mt-1 text-[.72rem] text-[var(--dim)]">
              Enter the code Telegram sent. It is used once and never stored, logged, or shown again.
            </p>
          </div>
          <div className="flex min-w-0 flex-wrap gap-2">
            <button type="submit" className="btn btn-primary max-w-full whitespace-normal" disabled={busy}>Sign in</button>
            <button type="button" className="btn max-w-full whitespace-normal" disabled={busy} onClick={() => void cancelLogin()}>Cancel</button>
          </div>
        </form>
      )}

      {phase === "password" && (
        <form className="mt-3 min-w-0 space-y-3" autoComplete="off" onSubmit={e => { e.preventDefault(); void submitPassword(); }}>
          <div className="min-w-0">
            <label htmlFor="telegram-2fa" className="mb-1 block text-[.76rem]">Two-step verification password</label>
            <input id="telegram-2fa" className="input min-w-0 w-full" type="password" autoComplete="current-password"
              value={password} disabled={busy} autoFocus onChange={e => setPassword(e.target.value)} />
            <p className="mt-1 text-[.72rem] text-[var(--dim)]">
              Your Telegram password is used once to sign in and is never stored, logged, or shown again.
            </p>
          </div>
          <div className="flex min-w-0 flex-wrap gap-2">
            <button type="submit" className="btn btn-primary max-w-full whitespace-normal" disabled={busy}>Sign in</button>
            <button type="button" className="btn max-w-full whitespace-normal" disabled={busy} onClick={() => void cancelLogin()}>Cancel</button>
          </div>
        </form>
      )}

      {busy && <p role="status" className="mt-3 text-[.76rem]">Working…</p>}
      {notice && <p role="status" aria-label="Telegram account result" className="mt-3 text-[.76rem]">{notice}</p>}
      <p className="mt-3 text-[.66rem] text-[var(--faint)]">
        Telegram session protected by Windows user-local filesystem permissions; not an encrypted credential vault.
      </p>
    </section>
  );
}
