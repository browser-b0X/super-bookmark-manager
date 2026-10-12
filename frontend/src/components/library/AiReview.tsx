import { useMemo, useState } from "react";
import { ArrowRight, Check, ListChecks, Loader2, RotateCcw, Square, Wand2 } from "lucide-react";
import { useLibrary } from "../../store/library";
import { usePrefs } from "../../store/prefs";
import { displayTitle } from "../../lib/displayText";
import { linksInScope, SCOPES, useAiTidy, type Job, type Scope } from "../../lib/aiTidy";

/**
 * Tidy up with AI. The run itself lives in lib/aiTidy.ts, so it keeps going while the owner
 * moves around the app: a review run collects suggestions to tick and apply, a background run
 * applies them as it goes (and can be undone).
 */
export default function AiReview({ aiReady, selectedIds, onDone }: { aiReady: boolean; selectedIds?: string[]; onDone?: () => void }) {
  const posts = useLibrary(s => s.posts);
  const t = useAiTidy();
  const savedJobs = usePrefs(s => s.aiTidyJobs);
  const setSavedJobs = usePrefs(s => s.setAiTidyJobs);
  const keepSorting = usePrefs(s => s.aiKeepSorting);
  const setKeepSorting = usePrefs(s => s.setAiKeepSorting);
  const [scope, setScope] = useState<Scope>(selectedIds?.length ? "selected" : "unsorted");
  const [jobs, setJobs] = useState<Job[]>(savedJobs);

  const targets = useMemo(() => linksInScope(posts, scope, selectedIds), [posts, scope, selectedIds]);
  const running = t.running;
  const background = t.kind === "background";
  const start = (kind: "review" | "background") => {
    setSavedJobs(jobs);
    t.start({ kind, scope, jobs, selectedIds, aiReady });
  };
  const toggleJob = (job: Job) => setJobs(j => j.includes(job) ? j.filter(x => x !== job) : [...j, job]);
  const keywordsOnly = t.engine === "keywords" || (!aiReady && !t.engine);   // engine names come from lib/aiTidy
  const accepted = t.rows.filter(r => r.accept);
  const applyAccepted = () => { t.applyReviewed(); onDone?.(); };
  const undoable = t.changes.filter(c => Object.keys(c.after).some(f => f !== "aiCheckedAt")).length;

  return (
    <section className="panel p-5" aria-labelledby="ai-review-heading">
      <h3 id="ai-review-heading" className="flex items-center gap-2 text-[.9rem] font-semibold">
        <Wand2 size={15} className="text-[var(--accent)]" /> Tidy up with AI
      </h3>
      <p className="mt-1.5 text-[.76rem] text-[var(--dim)]">
        Suggests a shelf, a few tags and a clean title with a one-line summary. Review them before anything changes, or
        let it sort them in the background while you use the app. Shelves you chose by hand and titles you edited are never touched.
      </p>
      {!aiReady && <p className="mt-2 text-[.74rem] text-[var(--amber)]">
        No AI provider is set up yet, so only shelves and tags can be suggested (from local keywords). Set one up above for
        titles, summaries and sorting in the background.
      </p>}

      <div className="mt-3 flex flex-wrap items-center gap-3 text-[.76rem]">
        <label className="flex items-center gap-2">Links:
          <select className="input" style={{ width: "auto", padding: "3px 8px", fontSize: ".74rem" }} value={running ? t.scope : scope}
            onChange={e => setScope(e.target.value as Scope)} disabled={running} aria-label="Which links to tidy">
            {selectedIds?.length ? <option value="selected">The {selectedIds.length} selected link{selectedIds.length === 1 ? "" : "s"}</option> : null}
            {(Object.keys(SCOPES) as (keyof typeof SCOPES)[]).map(k => <option key={k} value={k}>{SCOPES[k].label}</option>)}
          </select>
        </label>
        {!running && <span className="text-[var(--faint)]">{targets.length} link{targets.length === 1 ? "" : "s"}</span>}
      </div>
      <fieldset className="mt-2 flex flex-wrap gap-4 text-[.76rem]" disabled={running}>
        <legend className="sr-only">What to suggest</legend>
        {([["shelf", "Shelf"], ["tags", "Tags"], ["title", "Clean title & summary"]] as [Job, string][]).map(([job, label]) => (
          <label key={job} className="flex items-center gap-1.5" style={{ opacity: job === "title" && !aiReady ? .5 : 1 }}>
            <input type="checkbox" checked={(running ? t.jobs : jobs).includes(job)} onChange={() => toggleJob(job)} disabled={job === "title" && !aiReady} /> {label}
          </label>
        ))}
      </fieldset>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!running ? <>
          <button className="btn btn-primary" onClick={() => start("review")} disabled={!targets.length || !jobs.length}>
            <Wand2 size={13} /> Suggest for {targets.length} link{targets.length === 1 ? "" : "s"}
          </button>
          <button className="btn" onClick={() => start("background")} disabled={!aiReady || !targets.length || !jobs.length}
            title={aiReady ? "Applies as it goes; you can undo it" : "Needs an AI provider"}>
            <ListChecks size={13} /> Sort them in the background
          </button>
        </> : <button className="btn" onClick={t.stop}>
          <Square size={12} /> Stop
        </button>}
        {t.kind && (running || t.total > 0) && <span className="flex items-center gap-2 text-[.72rem] text-[var(--dim)]" role="status" aria-label="AI suggestion progress">
          {running && <Loader2 size={12} className="animate-spin" />}
          {background && running ? "Sorting in the background · " : ""}{t.done}/{t.total} checked{t.engine ? ` · ${keywordsOnly ? "local keywords" : t.engine}` : ""}
          {t.waiting > 0 && ` · providers busy, trying again in ${t.waiting}s`}
          {!t.waiting && t.slow > 0 && ` · waiting for a slow answer (${t.slow}s)`}
        </span>}
      </div>

      {background && running && <div className="tidy-progress mt-3" aria-label="Background sorting">
        <span className="tidy-progress__bar" style={{ width: `${t.total ? Math.round((t.done / t.total) * 100) : 0}%` }} aria-hidden="true" />
        <p className="text-[.74rem] text-[var(--dim)]">
          <b className="text-[var(--text)]">{t.filed}</b> filed onto shelves · <b className="text-[var(--text)]">{t.leftInOther}</b> left in "other"
          {t.unanswered ? <> · <b className="text-[var(--text)]">{t.unanswered}</b> without an answer yet</> : null}
          <span className="text-[var(--faint)]"> — keeps going while you use the app; the note at the bottom left shows how far it is.</span>
        </p>
      </div>}

      {t.message && <div role="status" aria-label="AI review result" className="mt-3 rounded-lg border p-2.5 text-[.76rem]"
        style={{ borderColor: "var(--border-hi)", background: "var(--surface2)" }}>
        <p>{t.message}</p>
        {!running && undoable > 0 && <div className="mt-2 flex flex-wrap gap-2">
          <button className="btn" onClick={() => t.undoChanges()}><RotateCcw size={12} /> Undo the AI's changes ({undoable})</button>
          <button className="btn" onClick={() => t.dismiss()}><Check size={12} /> Keep them</button>
        </div>}
      </div>}

      <label className="mt-3 flex items-start gap-2 text-[.76rem]">
        <input type="checkbox" className="mt-0.5" checked={keepSorting} onChange={e => setKeepSorting(e.target.checked)} />
        <span>Keep sorting new links in the background
          <span className="block text-[.7rem] text-[var(--faint)]">When links arrive that aren't on a shelf (an import, a Telegram refresh), they are
            sorted the same way by themselves, with the boxes ticked above. Each one is sent to your AI provider.</span>
        </span>
      </label>

      {t.rows.length > 0 && <div className="mt-4">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[.74rem]">
          <span className="font-semibold">{t.rows.length} suggestion{t.rows.length === 1 ? "" : "s"}</span>
          <button className="btn" onClick={() => t.setRows(r => r.map(x => ({ ...x, accept: true })))}>Select all</button>
          <button className="btn" onClick={() => t.setRows(r => r.map(x => ({ ...x, accept: false })))}>Select none</button>
          <span className="flex-1" />
          <button className="btn btn-primary" disabled={!accepted.length || running} onClick={applyAccepted}>
            <Check size={13} /> Apply {accepted.length}
          </button>
        </div>
        <ul className="ai-review-list" aria-label="AI suggestions">
          {t.rows.map((row, index) => (
            <li key={row.post.id} className={"ai-review-row" + (row.accept ? "" : " is-off")}>
              <input type="checkbox" checked={row.accept} aria-label={`Apply suggestion for ${displayTitle(row.post.title, row.post.url)}`}
                onChange={() => t.setRows(r => r.map((x, i) => i === index ? { ...x, accept: !x.accept } : x))} />
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
                  {row.s.tags?.map(tag => <span key={tag} className="chip">#{tag}</span>)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>}
    </section>
  );
}
