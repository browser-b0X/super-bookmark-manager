import { useEffect, useState } from "react";
import { CheckCircle2, ChevronRight, ExternalLink, KeyRound, Loader2, Sparkles, Trash2 } from "lucide-react";

export interface ProviderStatus {
  id: "gemini" | "groq" | "openrouter" | "nvidia" | "freellmapi" | "local";
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

/** The two with the most free use; shown as a hint on their rows. */
const MOST_FREE = new Set<ProviderStatus["id"]>(["gemini", "groq"]);

function ProviderRow({ p, open, onToggle, onStatus }: { p: ProviderStatus; open: boolean; onToggle: () => void; onStatus: (s: AiStatus) => void }) {
  const [key, setKey] = useState("");
  const [model, setModel] = useState(p.model);
  const [baseUrl, setBaseUrl] = useState(p.baseUrl);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<"" | "save" | "test" | "remove">("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const local = p.id === "local";
  // The local server and FreeLLMAPI run at an address the owner chooses.
  const addressed = local || p.id === "freellmapi";
  const dirty = !!key.trim() || model !== p.model || (addressed && baseUrl !== p.baseUrl) || (local && !p.configured);
  const tone = p.state === "ready" ? "var(--green)" : p.state === "off" ? "var(--faint)" : "var(--amber)";

  useEffect(() => { setModel(p.model); setBaseUrl(p.baseUrl); }, [p.model, p.baseUrl]);

  const save = async () => {
    setBusy("save"); setNote(null);
    const body: Record<string, unknown> = {};
    if (key.trim()) body.key = key.trim();
    if (model !== p.model) body.model = model === p.defaultModel ? "" : model;
    if (addressed && baseUrl !== p.baseUrl) body.baseUrl = baseUrl;
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
    // FreeLLMAPI can carry its token in the address (…/v1/t/<token>): removing it removes that too.
    const body = local ? { enabled: false } : p.id === "freellmapi" && p.baseUrl.includes("/t/")
      ? { clearKey: true, baseUrl: "http://127.0.0.1:3001/v1" } : { clearKey: true };
    const { ok, data } = await post(`/api/ai/providers/${p.id}`, body);
    setBusy("");
    if (ok) onStatus(data as AiStatus);
  };
  const toggle = async (enabled: boolean) => {
    const { ok, data } = await post(`/api/ai/providers/${p.id}`, { enabled });
    if (ok) onStatus(data as AiStatus);
  };

  const summary = !p.configured ? "Set up" : local ? p.baseUrl.replace(/^https?:\/\//, "")
    : p.keySource === "environment" ? `Key ${p.keyHint} (environment)` : p.keyHint ? `Key ${p.keyHint}` : p.baseUrl.replace(/^https?:\/\//, "");
  const keyField = p.keySource === "environment" ? (
    <span className="text-[.74rem] text-[var(--dim)]"><KeyRound size={12} className="inline" /> Key {p.keyHint} from an environment variable</span>
  ) : (
    <input className="input min-w-[200px] flex-1" type="password" autoComplete="off" spellCheck={false}
      value={key} onChange={e => setKey(e.target.value)} aria-label={`${p.label} API key`}
      placeholder={p.keyHint ? `Key saved (${p.keyHint}) — paste a new one to replace it` : p.id === "freellmapi" ? "Paste the freellmapi-… key" : "Paste API key"} />
  );

  return (
    <li className={"ai-provider" + (open ? " is-open" : "")} aria-label={`${p.label} provider`}>
      <div className="ai-provider__head">
        <button type="button" className="ai-provider__toggle" aria-expanded={open} aria-controls={`ai-provider-${p.id}`} onClick={onToggle}>
          <ChevronRight size={14} className="ai-provider__chevron" aria-hidden="true" />
          <span className="font-semibold text-[.84rem]">{p.label}</span>
          <span className="chip" style={{ color: tone, borderColor: tone }}>
            {STATE_LABEL[p.state] ?? p.state}{p.retryIn ? ` · ${p.retryIn}s` : ""}
          </span>
          {MOST_FREE.has(p.id) && !p.configured && <span className="ai-provider__tag">Most free use</span>}
          {p.today.requests > 0 && <span className="text-[.68rem] text-[var(--faint)]">
            {p.today.requests} request{p.today.requests === 1 ? "" : "s"} today{p.today.failures ? `, ${p.today.failures} failed` : ""}
          </span>}
          <span className="flex-1" />
          {!open && <span className="ai-provider__summary">{summary}</span>}
        </button>
        {p.configured && <label className="ai-provider__use">
          <input type="checkbox" checked={p.enabled} onChange={e => void toggle(e.target.checked)} /> Use
        </label>}
      </div>
      {open && <div id={`ai-provider-${p.id}`} className="ai-provider__body">
        <p className="text-[.72rem] text-[var(--faint)]">
          {p.note}{" "}
          {!local && <a className="inline-flex items-center gap-0.5 text-[var(--accent)] underline" href={p.signup} target="_blank" rel="noreferrer noopener">
            {p.id === "freellmapi" ? "Get FreeLLMAPI" : "Get a free key"} <ExternalLink size={10} />
          </a>}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {addressed && <input className="input min-w-[200px] flex-1" value={baseUrl} onChange={e => setBaseUrl(e.target.value)}
            aria-label={`${p.label} address`} placeholder={p.id === "freellmapi" ? "http://127.0.0.1:3001/v1" : "http://127.0.0.1:11434/v1"} spellCheck={false} />}
          {!local && keyField}
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
      </div>}
      {!note && p.detail && p.state !== "ready" && <p className="mt-2 text-[.72rem] text-[var(--amber)]">Last error: {p.detail}</p>}
      {note && <p role="status" className="mt-2 text-[.74rem]" style={{ color: note.ok ? "var(--green)" : "var(--amber)" }}>{note.text}</p>}
    </li>
  );
}

/** Keys for the free AI providers; stored in the user profile, never shown again. */
export default function AiProviders({ onChange }: { onChange?: (s: AiStatus) => void }) {
  const [status, setStatus] = useState<AiStatus | null | undefined>(undefined);
  // Each provider folds open on demand, so only the one being set up shows its fields.
  const [open, setOpen] = useState<Set<string>>(new Set());
  const update = (s: AiStatus) => { setStatus(s); onChange?.(s); };
  const toggle = (id: string) => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  useEffect(() => {
    let live = true;
    const load = () => fetchAiStatus().then(s => { if (live && s) update(s); else if (live) setStatus(null); });
    void load();
    // Benched providers come back on their own; keep the countdown honest.
    const timer = setInterval(() => { void load(); }, 30000);
    return () => { live = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setUp = status ? status.providers.filter(p => p.configured) : [];
  // FreeLLMAPI and a model on this computer cover everything; the single services fold away
  // (each is only needed without FreeLLMAPI). Closed until opened; a chip says how many are set up.
  const main = status ? status.providers.filter(p => p.id === "freellmapi" || p.id === "local") : [];
  const others = status ? status.providers.filter(p => p.id !== "freellmapi" && p.id !== "local") : [];
  const othersSetUp = others.filter(p => p.configured);
  const [showOthers, setShowOthers] = useState(false);
  return (
    <section className="panel p-5" aria-labelledby="ai-providers-heading">
      <h3 id="ai-providers-heading" className="flex items-center gap-2 text-[.9rem] font-semibold">
        <KeyRound size={15} className="text-[var(--accent)]" /> AI providers
      </h3>
      <p className="mt-1.5 text-[.76rem] text-[var(--dim)]">
        FreeLLMAPI is the easy way: one key in front of many free AI services (Gemini, Groq, OpenRouter and more), and it
        moves on by itself when one is busy. Install it, add those services' keys there, then paste its key here. A model
        running on this computer works too. Keys are saved in your Windows user profile, not in the app folder, and are
        never shown again. Without a provider, shelves are suggested with local keywords.
      </p>
      {status === undefined && <p className="mt-3 text-[.76rem] text-[var(--faint)]">Checking…</p>}
      {status === null && <p className="mt-3 text-[.76rem] text-[var(--amber)]">The local server isn't reachable, so keys can't be managed right now.</p>}
      {status && <p className="mt-3 text-[.72rem] text-[var(--faint)]" aria-live="polite">
        {setUp.length ? `${setUp.length} of ${status.providers.length} set up · in use: ${setUp.filter(p => p.enabled).map(p => p.label).join(", ") || "none"}`
          : "None set up yet: FreeLLMAPI gives the most free use with one key."}
      </p>}
      {status && <ol className="ai-providers mt-2">
        {main.map(p => <ProviderRow key={p.id} p={p} open={open.has(p.id)} onToggle={() => toggle(p.id)} onStatus={update} />)}
        {others.length > 0 && <li className={"ai-provider ai-provider--more" + (showOthers ? " is-open" : "")} aria-label="Other providers">
          <div className="ai-provider__head">
            <button type="button" className="ai-provider__toggle" aria-expanded={showOthers} aria-controls="ai-providers-others"
              onClick={() => setShowOthers(!showOthers)}>
              <ChevronRight size={14} className="ai-provider__chevron" aria-hidden="true" />
              <span className="font-semibold text-[.84rem]">Other providers</span>
              {othersSetUp.length > 0 && <span className="chip" style={{ color: "var(--green)", borderColor: "var(--green)" }}>{othersSetUp.length} set up</span>}
              <span className="flex-1" />
              <span className="ai-provider__summary">{others.map(p => p.label).join(", ")} · only needed without FreeLLMAPI</span>
            </button>
          </div>
          {showOthers && <ol id="ai-providers-others" className="ai-providers ai-providers--nested">
            {others.map(p => <ProviderRow key={p.id} p={p} open={open.has(p.id)} onToggle={() => toggle(p.id)} onStatus={update} />)}
          </ol>}
        </li>}
      </ol>}
    </section>
  );
}
