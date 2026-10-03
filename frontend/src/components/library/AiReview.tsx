import { useMemo, useRef, useState } from "react";
import { ArrowRight, Check, Loader2, Square, Wand2 } from "lucide-react";
import { useLibrary, type AiSuggestion } from "../../store/library";
import { displayText, displayTitle } from "../../lib/displayText";
import type { SavedPost } from "../../types";

type Scope = "unsorted" | "messy" | "all" | "selected";
type Job = "shelf" | "tags" | "title";
const BATCH = 6;
/** Waits for busy free tiers before settling for keyword guesses. */
const MAX_WAITS = 4;
/** Batches in flight at once; the app server has a few worker threads to share. */
const PARALLEL = 2;
const RETRYABLE = new Set(["rate_limited", "timeout", "unavailable", "bad_response"]);
const sleep = (ms: number, stop: { current: boolean }) => new Promise<void>(done => {
  const started = Date.now();
  const tick = () => (stop.current || Date.now() - started >= ms) ? done() : setTimeout(tick, 250);
  tick();
});
interface SuggestReply { ok?: boolean; error?: string; engine: string; items: AiSuggestion[]; missing?: string[]; fallbackReason?: string; retryIn?: number }

const unsorted = (p: SavedPost) => p.categoryMode !== "manual"
  && (!p.categories.length || p.categories.every(c => c === "other" || c === "uncategorized"));
const messy = (p: SavedPost) => {
  const source = p.fieldSources?.title;
  if (source === "user" || source === "ai") return false;
  const title = displayText(p.title);
  return !title || title === p.url || title.length > 70 || / on (Instagram|X|TikTok)\b|^\S+ on |#\w/.test(title)
    || p.platform === "instagram" || p.platform === "x";
};

const SCOPES: Record<Exclude<Scope, "selected">, { label: string; test: (p: SavedPost) => boolean }> = {
  unsorted: { label: "Links in other / uncategorized", test: unsorted },
  messy: { label: "Links with messy titles (captions, URLs)", test: messy },
  all: { label: "Every link that isn't archived", test: () => true },
};

interface Row { post: SavedPost; s: AiSuggestion; accept: boolean }

function payload(p: SavedPost) {
  return {
    id: p.id, url: p.url, platform: p.platform,
    title: displayText(p.originalTitle ?? p.title),
    text: displayText([p.description, p.excerpt, p.telegramMessage?.text].filter(Boolean).join("\n")).slice(0, 1500),
    folder: p.folderPath?.join(" / "), tags: p.tags,
  };
}

/** Only what would actually change, minus anything the owner set by hand. */
function meaningful(p: SavedPost, s: AiSuggestion, jobs: Job[]): AiSuggestion | null {
  const out: AiSuggestion = { id: s.id };
  if (jobs.includes("shelf") && s.shelf && p.categoryMode !== "manual" && !(p.categories.length === 1 && p.categories[0] === s.shelf)) out.shelf = s.shelf;
  const tags = (s.tags ?? []).filter(t => !p.tags.includes(t));
  if (jobs.includes("tags") && tags.length) out.tags = tags;
  if (jobs.includes("title") && s.title && p.fieldSources?.title !== "user" && displayText(p.title) !== s.title) out.title = s.title;
  if (jobs.includes("title") && s.summary && s.summary !== p.aiSummary) out.summary = s.summary;
  return Object.keys(out).length > 1 ? out : null;
}

export default function AiReview({ aiReady, selectedIds, onDone }: { aiReady: boolean; selectedIds?: string[]; onDone?: () => void }) {
  const posts = useLibrary(s => s.posts);
  const shelves = useLibrary(s => s.categories);
  const apply = useLibrary(s => s.applyAiSuggestions);
  const logActivity = useLibrary(s => s.logActivity);
  const [scope, setScope] = useState<Scope>(selectedIds?.length ? "selected" : "unsorted");
  const [jobs, setJobs] = useState<Job[]>(["shelf", "tags", "title"]);
  const [rows, setRows] = useState<Row[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [engine, setEngine] = useState<string>("");
  const [message, setMessage] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(0);
  const stop = useRef(false);

  const targets = useMemo(() => {
    if (scope === "selected") { const ids = new Set(selectedIds); return posts.filter(p => ids.has(p.id)); }
    return posts.filter(p => p.status !== "archived" && SCOPES[scope].test(p));
  }, [posts, scope, selectedIds]);
  const shelfNames = shelves.filter(c => !c.archived && c.name !== "uncategorized").map(c => c.name);
  const running = progress !== null && progress.done < progress.total;

  const ask = async (batch: SavedPost[], spread: number): Promise<SuggestReply> => {
    const r = await fetch("/api/ai/suggest", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: batch.map(payload), shelves: shelfNames, jobs, spread }),
      // The server bounds each call to about 100 s; this is only a safety net.
      signal: AbortSignal.timeout(150000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data.error || "The server couldn't make suggestions.");
    return data as SuggestReply;
  };

  const run = async () => {
    stop.current = false;
    setRows([]); setMessage(null); setEngine(""); setWaiting(0);
    const list = targets.slice();
    const batches: SavedPost[][] = [];
    for (let i = 0; i < list.length; i += BATCH) batches.push(list.slice(i, i + BATCH));
    setProgress({ done: 0, total: list.length });
    const found: Row[] = [];
    const engines = new Set<string>();
    let unanswered = 0, leftInOther = 0, failure = "", done = 0, next = 0;
    const waits = new Map<number, number>();
    const showWait = () => setWaiting(waits.size ? Math.max(...waits.values()) : 0);

    // One batch: ask, then keep asking for whatever the AI didn't answer while the
    // free tiers are busy, instead of quietly settling for keyword guesses.
    const work = async (index: number) => {
      let batch = batches[index];
      const replies: AiSuggestion[] = [];
      for (let attempt = 0; batch.length && !stop.current && !failure; attempt++) {
        let data: SuggestReply;
        try { data = await ask(batch, index); }
        catch (e) {
          if (attempt < 1) { await sleep(3000, stop); continue; }
          failure = e instanceof Error && e.name !== "TimeoutError" && e.name !== "TypeError" ? e.message
            : "The app's server stopped answering. Suggestions so far are kept below.";
          break;
        }
        if (data.engine && data.engine !== "keywords") engines.add(data.engine);
        const missing = new Set(data.missing ?? []);
        const retry = aiReady && missing.size > 0 && RETRYABLE.has(data.fallbackReason ?? "") && attempt < MAX_WAITS;
        // Keep AI answers now; keyword guesses only when we're not asking again.
        replies.push(...data.items.filter(s => !missing.has(s.id) || !retry));
        if (!retry) { unanswered += missing.size; if (data.engine === "keywords") engines.add("keywords"); break; }
        batch = batch.filter(p => missing.has(p.id));
        // The server knows when a provider is free again; otherwise back off a little.
        const wait = data.retryIn ? Math.min(Math.max(data.retryIn, 2), 90) : data.fallbackReason === "rate_limited" ? 10 : 4;
        for (let left = wait; left > 0 && !stop.current; left--) { waits.set(index, left); showWait(); await sleep(1000, stop); }
        waits.delete(index); showWait();
      }
      const current = new Map(useLibrary.getState().posts.map(p => [p.id, p]));
      if (jobs.includes("shelf")) leftInOther += replies.filter(s => s.shelf === "other" && current.get(s.id)?.categoryMode !== "manual").length;
      for (const s of replies) {
        const post = current.get(s.id);
        const m = post && meaningful(post, s, jobs);
        if (post && m) found.push({ post, s: m, accept: true });
      }
      done += batches[index].length;
      setRows(found.slice());
      setEngine([...engines].join(" + "));
      setProgress({ done: Math.min(done, list.length), total: list.length });
    };
    // A couple of batches in flight at once (each starts with a different
    // provider on the server), leaving the app's other requests room to run.
    const worker = async () => { while (!stop.current && !failure && next < batches.length) await work(next++); };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, batches.length) }, worker));
    setWaiting(0);
    setProgress(p => p && { ...p, total: p.done });
    const notes = [
      failure,
      stop.current ? "Stopped — suggestions so far are below." : "",
      unanswered ? `${unanswered} link${unanswered === 1 ? "" : "s"} got no AI answer (providers busy or unsure) — run it again later for those.` : "",
      leftInOther ? `${leftInOther} link${leftInOther === 1 ? " has" : "s have"} too little to go on and stay${leftInOther === 1 ? "s" : ""} in "other" — open ${leftInOther === 1 ? "it" : "them"} to file by hand, or refresh previews first.` : "",
      !found.length && !failure && !stop.current ? "Nothing to change — everything already looks right." : "",
    ].filter(Boolean);
    if (notes.length) setMessage(notes.join(" "));
  };

  const accepted = rows.filter(r => r.accept);
  const applyAccepted = () => {
    const n = apply(accepted.map(r => r.s));
    logActivity("organize", `Applied ${n} AI suggestion${n === 1 ? "" : "s"}`);
    setMessage(`Saved changes to ${n} link${n === 1 ? "" : "s"}. Original titles are kept — open a link to restore one.`);
    setRows([]); setProgress(null);
    onDone?.();
  };
  const toggleJob = (job: Job) => setJobs(j => j.includes(job) ? j.filter(x => x !== job) : [...j, job]);
  const keywordsOnly = engine === "keywords" || (!aiReady && !engine);

  return (
    <section className="panel p-5" aria-labelledby="ai-review-heading">
      <h3 id="ai-review-heading" className="flex items-center gap-2 text-[.9rem] font-semibold">
        <Wand2 size={15} className="text-[var(--accent)]" /> Tidy up with AI
      </h3>
      <p className="mt-1.5 text-[.76rem] text-[var(--dim)]">
        Suggests a shelf, a few tags and a clean title with a one-line summary. Nothing changes until you review and apply.
        Shelves you chose by hand and titles you edited are never touched.
      </p>
      {!aiReady && <p className="mt-2 text-[.74rem] text-[var(--amber)]">
        No AI provider is set up yet, so only shelves and tags can be suggested (from local keywords). Add a free key above for titles and summaries.
      </p>}

      <div className="mt-3 flex flex-wrap items-center gap-3 text-[.76rem]">
        <label className="flex items-center gap-2">Links:
          <select className="input" style={{ width: "auto", padding: "3px 8px", fontSize: ".74rem" }} value={scope}
            onChange={e => setScope(e.target.value as Scope)} disabled={running} aria-label="Which links to tidy">
            {selectedIds?.length ? <option value="selected">The {selectedIds.length} selected link{selectedIds.length === 1 ? "" : "s"}</option> : null}
            {(Object.keys(SCOPES) as (keyof typeof SCOPES)[]).map(k => <option key={k} value={k}>{SCOPES[k].label}</option>)}
          </select>
        </label>
        <span className="text-[var(--faint)]">{targets.length} link{targets.length === 1 ? "" : "s"}</span>
      </div>
      <fieldset className="mt-2 flex flex-wrap gap-4 text-[.76rem]" disabled={running}>
        <legend className="sr-only">What to suggest</legend>
        {([["shelf", "Shelf"], ["tags", "Tags"], ["title", "Clean title & summary"]] as [Job, string][]).map(([job, label]) => (
          <label key={job} className="flex items-center gap-1.5" style={{ opacity: job === "title" && !aiReady ? .5 : 1 }}>
            <input type="checkbox" checked={jobs.includes(job)} onChange={() => toggleJob(job)} disabled={job === "title" && !aiReady} /> {label}
          </label>
        ))}
      </fieldset>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!running ? <button className="btn btn-primary" onClick={() => void run()} disabled={!targets.length || !jobs.length}>
          <Wand2 size={13} /> Suggest for {targets.length} link{targets.length === 1 ? "" : "s"}
        </button> : <button className="btn" onClick={() => { stop.current = true; }}>
          <Square size={12} /> Stop
        </button>}
        {progress && <span className="flex items-center gap-2 text-[.72rem] text-[var(--dim)]" role="status" aria-label="AI suggestion progress">
          {running && <Loader2 size={12} className="animate-spin" />}
          {progress.done}/{progress.total} checked{engine ? ` · ${keywordsOnly ? "local keywords" : engine}` : ""}
          {waiting > 0 && ` · providers busy, trying again in ${waiting}s`}
        </span>}
      </div>
      {message && <p role="status" aria-label="AI review result" className="mt-3 rounded-lg border p-2.5 text-[.76rem]"
        style={{ borderColor: "var(--border-hi)", background: "var(--surface2)" }}>{message}</p>}

      {rows.length > 0 && <div className="mt-4">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[.74rem]">
          <span className="font-semibold">{rows.length} suggestion{rows.length === 1 ? "" : "s"}</span>
          <button className="btn" onClick={() => setRows(r => r.map(x => ({ ...x, accept: true })))}>Select all</button>
          <button className="btn" onClick={() => setRows(r => r.map(x => ({ ...x, accept: false })))}>Select none</button>
          <span className="flex-1" />
          <button className="btn btn-primary" disabled={!accepted.length || running} onClick={applyAccepted}>
            <Check size={13} /> Apply {accepted.length}
          </button>
        </div>
        <ul className="ai-review-list" aria-label="AI suggestions">
          {rows.map((row, index) => (
            <li key={row.post.id} className={"ai-review-row" + (row.accept ? "" : " is-off")}>
              <input type="checkbox" checked={row.accept} aria-label={`Apply suggestion for ${displayTitle(row.post.title, row.post.url)}`}
                onChange={() => setRows(r => r.map((x, i) => i === index ? { ...x, accept: !x.accept } : x))} />
              <div className="ai-review-thumb" aria-hidden="true">
                {row.post.thumbnailUrl ? <img src={row.post.thumbnailUrl} alt="" loading="lazy" /> : <span>{row.post.platform.slice(0, 2)}</span>}
              </div>
              <div className="min-w-0 flex-1">
                {row.s.title ? <p className="text-[.78rem]">
                  <span className="line-through text-[var(--faint)]">{displayTitle(row.post.title, row.post.url).slice(0, 90)}</span>
                  <ArrowRight size={11} className="mx-1 inline text-[var(--faint)]" />
                  <span className="font-semibold">{row.s.title}</span>
                </p> : <p className="truncate text-[.78rem] font-semibold">{displayTitle(row.post.title, row.post.url)}</p>}
                {row.s.summary && <p className="mt-0.5 text-[.72rem] text-[var(--dim)]">{row.s.summary}</p>}
                <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[.7rem]">
                  {row.s.shelf && <span className="chip">{row.post.categories[0] ?? "—"} → <b>{row.s.shelf}</b></span>}
                  {row.s.tags?.map(t => <span key={t} className="chip">#{t}</span>)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>}
    </section>
  );
}
