import { useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, KeyRound, Loader2, Sparkles, Trash2 } from "lucide-react";

export interface ProviderStatus {
  id: "gemini" | "groq" | "openrouter" | "nvidia" | "local";
  detail?: string;
  label: string;
  note: string;
  signup: string;
  configured: boolean;
  enabled: boolean;
  keySource: "" | "settings" | "environment";
  keyHint: string;
  model: string;
  defaultModel: string;
  baseUrl: string;
  state: "ready" | "off" | "rate_limited" | "key_rejected" | "unavailable" | "timeout" | "bad_response";
  retryIn: number;
  today: { requests: number; failures: number; tokens: number };
}
export interface AiStatus { providers: ProviderStatus[]; ready: string[]; available: boolean }

const STATE_LABEL: Record<ProviderStatus["state"], string> = {
  ready: "Ready", off: "Not set up", rate_limited: "Resting (rate limit)", key_rejected: "Key rejected",
  unavailable: "Unreachable", timeout: "Slow — resting", bad_response: "Odd reply — resting",
};

export async function fetchAiStatus(): Promise<AiStatus | null> {
  try {
    const r = await fetch("/api/ai/providers", { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json() as AiStatus;
  } catch {
    return null;
  }
}

async function post(path: string, body: unknown) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok && data.ok !== false, data };
}

function ProviderRow({ p, onStatus }: { p: ProviderStatus; onStatus: (s: AiStatus) => void }) {
  const [key, setKey] = useState("");
  const [model, setModel] = useState(p.model);
  const [baseUrl, setBaseUrl] = useState(p.baseUrl);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<"" | "save" | "test" | "remove">("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const local = p.id === "local";
  const dirty = !!key.trim() || model !== p.model || (local && (baseUrl !== p.baseUrl || !p.configured));
  const tone = p.state === "ready" ? "var(--green)" : p.state === "off" ? "var(--faint)" : "var(--amber)";

  useEffect(() => { setModel(p.model); setBaseUrl(p.baseUrl); }, [p.model, p.baseUrl]);

  const save = async () => {
    setBusy("save"); setNote(null);
    const body: Record<string, unknown> = {};
    if (key.trim()) body.key = key.trim();
    if (model !== p.model) body.model = model === p.defaultModel ? "" : model;
    if (local && baseUrl !== p.baseUrl) body.baseUrl = baseUrl;
    if (local && !p.configured && !Object.keys(body).length) body.baseUrl = baseUrl;
    const { ok, data } = await post(`/api/ai/providers/${p.id}`, body);
    setBusy("");
    if (!ok) { setNote({ ok: false, text: data.error || "Couldn't save." }); return; }
    setKey("");
    onStatus(data as AiStatus);
    await test();
  };
  const test = async () => {
    setBusy("test"); setNote(null);
    const { data } = await post(`/api/ai/providers/${p.id}/test`, {});
    setBusy("");
    if (Array.isArray(data.models)) setModels(data.models);
    if (data.status) onStatus(data.status as AiStatus);
    setNote(data.ok ? { ok: true, text: data.note ? `Working — ${data.note}` : "Working — the provider answered." } : { ok: false, text: data.message || data.error || "Test failed." });
  };
  const remove = async () => {
    setBusy("remove"); setNote(null);
    const { ok, data } = await post(`/api/ai/providers/${p.id}`, local ? { enabled: false } : { clearKey: true });
    setBusy("");
    if (ok) onStatus(data as AiStatus);
  };
  const toggle = async (enabled: boolean) => {
    const { ok, data } = await post(`/api/ai/providers/${p.id}`, { enabled });
    if (ok) onStatus(data as AiStatus);
  };

  return (
    <li className="ai-provider" aria-label={`${p.label} provider`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-[.84rem]">{p.label}</span>
        <span className="chip" style={{ color: tone, borderColor: tone }}>
          {STATE_LABEL[p.state] ?? p.state}{p.retryIn ? ` · ${p.retryIn}s` : ""}
        </span>
        {p.today.requests > 0 && <span className="text-[.68rem] text-[var(--faint)]">
          {p.today.requests} request{p.today.requests === 1 ? "" : "s"} today{p.today.failures ? `, ${p.today.failures} failed` : ""}
        </span>}
        <span className="flex-1" />
        {p.configured && <label className="flex items-center gap-1.5 text-[.72rem] text-[var(--dim)]">
          <input type="checkbox" checked={p.enabled} onChange={e => void toggle(e.target.checked)} /> Use
        </label>}
      </div>
      <p className="mt-0.5 text-[.72rem] text-[var(--faint)]">
        {p.note}{" "}
        {!local && <a className="inline-flex items-center gap-0.5 text-[var(--accent)] underline" href={p.signup} target="_blank" rel="noreferrer noopener">
          Get a free key <ExternalLink size={10} />
        </a>}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {local ? (
          <input className="input min-w-[220px] flex-1" value={baseUrl} onChange={e => setBaseUrl(e.target.value)}
            aria-label={`${p.label} address`} placeholder="http://127.0.0.1:11434/v1" spellCheck={false} />
        ) : p.keySource === "environment" ? (
          <span className="text-[.74rem] text-[var(--dim)]"><KeyRound size={12} className="inline" /> Key {p.keyHint} from an environment variable</span>
        ) : (
          <input className="input min-w-[220px] flex-1" type="password" autoComplete="off" spellCheck={false}
            value={key} onChange={e => setKey(e.target.value)} aria-label={`${p.label} API key`}
            placeholder={p.keyHint ? `Key saved (${p.keyHint}) — paste a new one to replace it` : "Paste API key"} />
        )}
        <button className={"btn" + (dirty ? " btn-primary" : "")} disabled={!!busy || !dirty} onClick={() => void save()}>
          {busy === "save" ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />} Save
        </button>
        <button className="btn" disabled={!!busy || !p.configured} onClick={() => void test()}>
          {busy === "test" ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} Test
        </button>
        {p.configured && p.keySource !== "environment" && <button className="btn" disabled={!!busy} onClick={() => void remove()}
          aria-label={local ? `Turn off ${p.label}` : `Remove ${p.label} key`}>
          <Trash2 size={13} /> {local ? "Turn off" : "Remove"}
        </button>}
      </div>
      <details className="mt-2 text-[.72rem] text-[var(--dim)]">
        <summary className="cursor-pointer select-none">Model: <code>{p.model || "first available"}</code></summary>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <input className="input w-[260px]" list={`${p.id}-models`} value={model} onChange={e => setModel(e.target.value)}
            aria-label={`${p.label} model`} placeholder={p.defaultModel || "first available"} spellCheck={false} />
          <datalist id={`${p.id}-models`}>{models.map(m => <option key={m} value={m} />)}</datalist>
          <span className="text-[var(--faint)]">Default {p.defaultModel ? <code>{p.defaultModel}</code> : "first model the server lists"}. Test lists what your key can use.</span>
        </div>
      </details>
      {!note && p.detail && p.state !== "ready" && <p className="mt-2 text-[.72rem] text-[var(--amber)]">Last error: {p.detail}</p>}
      {note && <p role="status" className="mt-2 text-[.74rem]" style={{ color: note.ok ? "var(--green)" : "var(--amber)" }}>{note.text}</p>}
    </li>
  );
}

/** Keys for the free AI providers; stored in the user profile, never shown again. */
export default function AiProviders({ onChange }: { onChange?: (s: AiStatus) => void }) {
  const [status, setStatus] = useState<AiStatus | null | undefined>(undefined);
  const update = (s: AiStatus) => { setStatus(s); onChange?.(s); };

  useEffect(() => {
    let live = true;
    const load = () => fetchAiStatus().then(s => { if (live && s) update(s); else if (live) setStatus(null); });
    void load();
    // Benched providers come back on their own; keep the countdown honest.
    const timer = setInterval(() => { void load(); }, 30000);
    return () => { live = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="panel p-5" aria-labelledby="ai-providers-heading">
      <h3 id="ai-providers-heading" className="flex items-center gap-2 text-[.9rem] font-semibold">
        <KeyRound size={15} className="text-[var(--accent)]" /> AI providers
      </h3>
      <p className="mt-1.5 text-[.76rem] text-[var(--dim)]">
        Add a free key from any of these. The app tries them top to bottom and moves to the next when one is busy or
        out of free requests. Gemini and Groq give the most free use; OpenRouter adds a rotating set of free models. Keys are saved in your Windows user profile — not in the app folder — and are never shown again.
        Without a key, shelves are suggested with local keywords.
      </p>
      {status === undefined && <p className="mt-3 text-[.76rem] text-[var(--faint)]">Checking…</p>}
      {status === null && <p className="mt-3 text-[.76rem] text-[var(--amber)]">The local server isn't reachable, so keys can't be managed right now.</p>}
      {status && <ol className="mt-3 flex flex-col gap-3">
        {status.providers.map(p => <ProviderRow key={p.id} p={p} onStatus={update} />)}
      </ol>}
    </section>
  );
}
