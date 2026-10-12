import { create } from "zustand";
import { useLibrary, type AiChange, type AiSuggestion } from "../store/library";
import { usePrefs } from "../store/prefs";
import { displayText } from "./displayText";
import type { SavedPost } from "../types";

/**
 * "Tidy up with AI" runs here, outside any page, so it keeps going while the owner uses the app.
 * Two kinds of run share one loop:
 *  - review: suggestions are collected for the owner to tick and apply;
 *  - background: suggestions are applied as they come, batch after batch, until no link in scope
 *    is left. Every change is recorded so it can all be undone.
 * With "Keep sorting new links" on (useAiTidyAutoStart), a background run starts by itself when
 * unsorted links arrive, and when the app opens with some waiting.
 */
export type Scope = "unsorted" | "messy" | "all" | "selected";
export type Job = "shelf" | "tags" | "title";
export type Kind = "review" | "background";
export interface Row { post: SavedPost; s: AiSuggestion; accept: boolean }

const BATCH = 8;
/** Batches in flight at once; the app server has a dozen worker threads to share. */
const PARALLEL = 3;
/** Waits for busy free tiers before settling for keyword guesses (or, in the background, for later). */
const MAX_WAITS = 4;
/** Batches that fail one after another before the run gives up (one bad batch used to end it). */
const MAX_FAILED_IN_A_ROW = 3;
/** A link a background run got no answer for waits this long before a run asks about it again. */
export const RETRY_LATER_MS = 10 * 60 * 1000;
const RETRYABLE = new Set(["rate_limited", "timeout", "unavailable", "bad_response"]);
interface SuggestReply { ok?: boolean; error?: string; engine: string; items: AiSuggestion[]; missing?: string[]; fallbackReason?: string; retryIn?: number }

/** The AI looked at this link (in a run the owner applied) and nothing about it has changed since. */
const checkedAlready = (p: SavedPost) => !!p.aiCheckedAt && (!p.enrichedAt || p.enrichedAt <= p.aiCheckedAt);
// A link the AI couldn't place stays in "other"; asking again about the same link only
// brought it back with new tags each run, so it waits until its preview changes.
export const unsorted = (p: SavedPost) => p.categoryMode !== "manual" && !checkedAlready(p)
  && (!p.categories.length || p.categories.every(c => c === "other" || c === "uncategorized"));
const messy = (p: SavedPost) => {
  const source = p.fieldSources?.title;
  if (source === "user" || source === "ai") return false;
  const title = displayText(p.title);
  return !title || title === p.url || title.length > 70 || / on (Instagram|X|TikTok)\b|^\S+ on |#\w/.test(title)
    || p.platform === "instagram" || p.platform === "x";
};
export const SCOPES: Record<Exclude<Scope, "selected">, { label: string; test: (p: SavedPost) => boolean }> = {
  unsorted: { label: "Links in other / uncategorized", test: unsorted },
  messy: { label: "Links with messy titles (captions, URLs)", test: messy },
  all: { label: "Every link that isn't archived", test: () => true },
};

/** The links a run would look at now. */
export function linksInScope(posts: SavedPost[], scope: Scope, selectedIds?: string[]): SavedPost[] {
  if (scope === "selected") { const ids = new Set(selectedIds); return posts.filter(p => ids.has(p.id)); }
  return posts.filter(p => p.status !== "archived" && SCOPES[scope].test(p));
}

function payload(p: SavedPost) {
  return {
    id: p.id, url: p.url, platform: p.platform,
    title: displayText(p.originalTitle ?? p.title),
    text: displayText([p.description, p.excerpt, p.telegramMessage?.text].filter(Boolean).join("\n")).slice(0, 1500),
    folder: p.folderPath?.join(" / "), tags: p.tags,
  };
}

/** Only what would actually change, minus anything the owner set by hand. */
export function meaningful(p: SavedPost, s: AiSuggestion, jobs: Job[]): AiSuggestion | null {
  const out: AiSuggestion = { id: s.id };
  if (jobs.includes("shelf") && s.shelf && p.categoryMode !== "manual" && !(p.categories.length === 1 && p.categories[0] === s.shelf)) out.shelf = s.shelf;
  const tags = (s.tags ?? []).filter(t => !p.tags.includes(t));
  if (jobs.includes("tags") && tags.length) out.tags = tags;
  if (jobs.includes("title") && s.title && p.fieldSources?.title !== "user" && displayText(p.title) !== s.title) out.title = s.title;
  if (jobs.includes("title") && s.summary && s.summary !== p.aiSummary) out.summary = s.summary;
  return Object.keys(out).length > 1 ? out : null;
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const ENGINE: Record<string, string> = { freellmapi: "FreeLLMAPI", local: "local model", gemini: "Gemini", groq: "Groq",
  openrouter: "OpenRouter", nvidia: "NVIDIA NIM", keywords: "keywords" };
const engineName = (id: string) => ENGINE[id] ?? id;

interface TidyState {
  kind: Kind | null;
  running: boolean;
  scope: Scope;
  jobs: Job[];
  done: number;
  total: number;
  engine: string;
  /** Seconds until busy providers are asked again. */
  waiting: number;
  /** Seconds the oldest request in flight has waited (shown from 8 s on). */
  slow: number;
  /** Review runs: suggestions for the owner to tick. */
  rows: Row[];
  message: string | null;
  /** Background runs: links filed onto a shelf, changed in any way, left in "other", without an answer yet. */
  filed: number;
  changed: number;
  leftInOther: number;
  unanswered: number;
  /** Every background change since the owner last dismissed or undid them. */
  changes: AiChange[];
  /** `auto`: started by "Keep sorting new links", not by the owner (held back after a Stop). */
  start(options: { kind: Kind; scope: Scope; jobs: Job[]; selectedIds?: string[]; aiReady: boolean; auto?: boolean }): void;
  stop(): void;
  setRows(update: (rows: Row[]) => Row[]): void;
  /** Review runs: save the ticked suggestions; returns how many links changed. */
  applyReviewed(): number;
  /** Undo every background change since the last dismiss; returns how many links were put back. */
  undoChanges(): number;
  dismiss(): void;
}

let stopped = { current: true };
let runAbort: AbortController | null = null;
/** Links the AI answered in the last review run: marked as checked when the owner applies. */
let answered = new Set<string>();
/** Links background runs got no answer for, and when: not asked again until RETRY_LATER_MS later. */
export const triedAt = new Map<string, number>();
/** The owner stopped a background run: "Keep sorting new links" waits until they start one or reopen the app. */
let autoHeld = false;

export const useAiTidy = create<TidyState>()((set, get) => ({
  kind: null, running: false, scope: "unsorted", jobs: ["shelf", "tags", "title"], done: 0, total: 0, engine: "",
  waiting: 0, slow: 0, rows: [], message: null, filed: 0, changed: 0, leftInOther: 0, unanswered: 0, changes: [],

  start(options) {
    if (get().running || (options.auto && autoHeld)) return;
    if (!options.auto) autoHeld = false;
    void run(options);
  },
  stop() {
    if (get().kind === "background") autoHeld = true;
    stopped.current = true;
    runAbort?.abort();
  },
  setRows(update) { set({ rows: update(get().rows) }); },
  applyReviewed() {
    const { rows } = get();
    const accepted = rows.filter(r => r.accept);
    // Links the AI answered count as checked, except suggestions the owner unticked: those may come back.
    const declined = new Set(rows.filter(r => !r.accept).map(r => r.post.id));
    const library = useLibrary.getState();
    const n = library.applyAiSuggestions(accepted.map(r => r.s), [...answered].filter(id => !declined.has(id))).length;
    library.logActivity("organize", `Applied ${plural(n, "AI suggestion")}`);
    answered = new Set();
    set({ rows: [], message: `Saved changes to ${plural(n, "link")}. Original titles are kept — open a link to restore one.`, done: 0, total: 0, kind: null });
    return n;
  },
  undoChanges() {
    const library = useLibrary.getState();
    const n = library.restoreAiChanges(get().changes);
    library.logActivity("organize", `Undid AI sorting for ${plural(n, "link")}`);
    // Otherwise "Keep sorting new links" would sort them straight back.
    const prefs = usePrefs.getState();
    const keptOn = prefs.aiKeepSorting;
    if (keptOn) prefs.setAiKeepSorting(false);
    set({ changes: [], kind: null, done: 0, total: 0, message: `Put ${plural(n, "link")} back as they were before the AI sorted them.`
      + (keptOn ? ` "Keep sorting new links" is now off, so they aren't sorted again by themselves.` : "") });
    return n;
  },
  dismiss() { set({ changes: [], message: null, kind: null, done: 0, total: 0 }); },
}));

async function ask(batch: SavedPost[], jobs: Job[], spread: number, signal: AbortSignal): Promise<SuggestReply> {
  const controller = new AbortController();
  // The server bounds each call to about 100 s; this is only a safety net.
  const timer = setTimeout(() => controller.abort(), 150000);
  const onStop = () => controller.abort();
  signal.addEventListener("abort", onStop, { once: true });
  const shelves = useLibrary.getState().categories.filter(c => !c.archived && c.name !== "uncategorized").map(c => c.name);
  try {
    const r = await fetch("/api/ai/suggest", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: batch.map(payload), shelves, jobs, spread }),
      signal: controller.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data.error || "The server couldn't make suggestions.");
    return data as SuggestReply;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onStop);
  }
}

const sleep = (ms: number, stop: { current: boolean }) => new Promise<void>(done => {
  const started = Date.now();
  const tick = () => (stop.current || Date.now() - started >= ms) ? done() : setTimeout(tick, 250);
  tick();
});

async function run({ kind, scope, jobs, selectedIds, aiReady }: { kind: Kind; scope: Scope; jobs: Job[]; selectedIds?: string[]; aiReady: boolean }) {
  const set = useAiTidy.setState;
  const stop = { current: false };
  stopped = stop;
  const abort = new AbortController();
  runAbort = abort;
  if (kind === "review") answered = new Set();
  set({ kind, running: true, scope, jobs, done: 0, total: 0, engine: "", waiting: 0, slow: 0, rows: [], message: null,
    filed: 0, changed: 0, leftInOther: 0, unanswered: 0 });

  const inFlight = new Map<number, number>();
  const waits = new Map<number, number>();
  const showWait = () => set({ waiting: waits.size ? Math.max(...waits.values()) : 0 });
  // Says so when an answer takes long, so a slow provider doesn't look like a frozen run.
  const ticker = setInterval(() => {
    const oldest = Math.min(Infinity, ...inFlight.values());
    const seconds = Number.isFinite(oldest) ? Math.round((Date.now() - oldest) / 1000) : 0;
    set({ slow: seconds >= 8 ? seconds : 0 });
  }, 1000);

  // Review runs look at the links in scope when they start; background runs keep looking,
  // so links that arrive meanwhile join in and ones filed by hand drop out.
  const fixed = kind === "review" ? linksInScope(useLibrary.getState().posts, scope, selectedIds) : [];
  const attempted = new Set<string>();
  const pending = (): SavedPost[] => kind === "review" ? fixed.filter(p => !attempted.has(p.id))
    : linksInScope(useLibrary.getState().posts, scope, selectedIds)
      .filter(p => !attempted.has(p.id) && Date.now() - (triedAt.get(p.id) ?? 0) > RETRY_LATER_MS);
  const updateTotal = () => set({ total: attempted.size + pending().length });
  updateTotal();

  const engines = new Set<string>();
  const found: Row[] = [];
  let failure = "", lastError = "", failedInARow = 0, skipped = 0, unanswered = 0, leftInOther = 0, done = 0, spread = 0;

  // One batch: ask, then keep asking for whatever the AI didn't answer while the free tiers are
  // busy, instead of quietly settling for keyword guesses.
  const work = async (first: SavedPost[], index: number) => {
    let batch = first;
    const replies: AiSuggestion[] = [];
    const aiAnswered = new Set<string>();
    let noAnswer: string[] = [];
    let abandoned = false;
    for (let attempt = 0; batch.length && !stop.current && !failure; attempt++) {
      let data: SuggestReply;
      inFlight.set(index, Date.now());
      try { data = await ask(batch, jobs, index, abort.signal); }
      catch (e) {
        if (stop.current) { abandoned = attempt === 0; break; }   // Stop: the request was abandoned on purpose
        if (attempt < 1) { await sleep(3000, stop); continue; }
        lastError = e instanceof Error && !["TimeoutError", "TypeError", "AbortError"].includes(e.name) ? e.message
          : "The app's server stopped answering.";
        // This batch is left for later and the others carry on; only several failures in a
        // row (the server gone, say) end the run.
        skipped += batch.length;
        noAnswer = batch.map(p => p.id);
        if (++failedInARow >= MAX_FAILED_IN_A_ROW) failure = lastError;
        break;
      } finally {
        inFlight.delete(index);
      }
      failedInARow = 0;
      if (data.engine && data.engine !== "keywords") engines.add(data.engine);
      const missing = new Set(data.missing ?? []);
      const retry = aiReady && missing.size > 0 && RETRYABLE.has(data.fallbackReason ?? "") && attempt < MAX_WAITS;
      for (const s of data.items) if (!missing.has(s.id)) aiAnswered.add(s.id);
      // AI answers now; keyword guesses only in a review run that isn't asking again.
      replies.push(...data.items.filter(s => !missing.has(s.id) || (!retry && kind === "review")));
      if (!retry) {
        unanswered += missing.size;
        noAnswer = [...missing];
        if (data.engine === "keywords") engines.add("keywords");
        break;
      }
      batch = batch.filter(p => missing.has(p.id));
      // The server knows when a provider is free again; otherwise back off a little.
      const wait = data.retryIn ? Math.min(Math.max(data.retryIn, 2), 90) : data.fallbackReason === "rate_limited" ? 10 : 4;
      for (let left = wait; left > 0 && !stop.current; left--) { waits.set(index, left); showWait(); await sleep(1000, stop); }
      waits.delete(index); showWait();
    }
    // Stopped before the first answer came back: this batch wasn't looked at.
    if (abandoned) return;
    const current = new Map(useLibrary.getState().posts.map(p => [p.id, p]));
    const isOther = (s: AiSuggestion) => jobs.includes("shelf") && s.shelf === "other" && current.get(s.id)?.categoryMode !== "manual";
    leftInOther += replies.filter(s => aiAnswered.has(s.id) && isOther(s)).length;
    if (kind === "review") {
      for (const id of aiAnswered) answered.add(id);
      for (const s of replies) {
        const post = current.get(s.id);
        const m = post && meaningful(post, s, jobs);
        if (post && m) found.push({ post, s: m, accept: true });
      }
      set({ rows: found.slice() });
    } else {
      // Apply now: only what the AI answered (never keyword guesses), and mark those links checked.
      const items = replies.filter(s => aiAnswered.has(s.id)).map(s => { const post = current.get(s.id); return post && meaningful(post, s, jobs); })
        .filter((m): m is AiSuggestion => !!m);
      const changes = useLibrary.getState().applyAiSuggestions(items, [...aiAnswered], { automatic: true });
      const now = Date.now();
      for (const id of noAnswer) triedAt.set(id, now);
      const state = useAiTidy.getState();
      set({
        changes: [...state.changes, ...changes],
        filed: state.filed + items.filter(s => s.shelf && s.shelf !== "other").length,
        changed: state.changed + changes.filter(c => Object.keys(c.after).some(f => f !== "aiCheckedAt")).length,
      });
    }
    done += first.length;
    set({ done, engine: [...engines].map(engineName).join(" + "), leftInOther, unanswered: unanswered + skipped });
    updateTotal();
  };

  const worker = async () => {
    while (!stop.current && !failure) {
      const batch = pending().slice(0, BATCH);
      if (!batch.length) break;
      for (const p of batch) attempted.add(p.id);   // so the other workers take different links
      await work(batch, spread++);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  clearInterval(ticker);

  if (kind === "review") {
    // Links the AI answered with nothing to change are checked now; ones with a suggestion
    // are checked when the owner applies it.
    const withRow = new Set(found.map(r => r.post.id));
    const nothingToChange = [...answered].filter(id => !withRow.has(id));
    if (nothingToChange.length) useLibrary.getState().applyAiSuggestions([], nothingToChange);
    answered = new Set([...answered].filter(id => withRow.has(id)));
  }
  const state = useAiTidy.getState();
  const notes = kind === "review" ? [
    failure ? `${failure} Suggestions so far are kept below.` : "",
    skipped && !failure ? `${plural(skipped, "link")} couldn't be checked (${lastError.replace(/\.$/, "")}); run it again later for ${skipped === 1 ? "it" : "them"}.` : "",
    stop.current ? "Stopped — suggestions so far are below." : "",
    unanswered ? `${plural(unanswered, "link")} got no AI answer (providers busy or unsure) — run it again later for those.` : "",
    leftInOther ? `${leftInOther} link${leftInOther === 1 ? " doesn't" : "s don't"} fit any of your shelves and stay${leftInOther === 1 ? "s" : ""} in "other"; Tidy up skips ${leftInOther === 1 ? "it" : "them"} until ${leftInOther === 1 ? "its" : "their"} preview changes. File ${leftInOther === 1 ? "it" : "them"} by hand, or add a shelf for ${leftInOther === 1 ? "it" : "them"} (All shelves → New shelf → Suggest from unfiled links).` : "",
    !found.length && !failure && !stop.current ? "Nothing to change — everything already looks right." : "",
  ] : [
    `${stop.current ? "Stopped" : failure ? "Stopped early" : "Done"}: sorted ${plural(state.done, "link")} in the background — ${state.filed} filed onto shelves`
      + `${leftInOther ? `, ${leftInOther} left in "other" (none of your shelves fits ${leftInOther === 1 ? "it" : "them"})` : ""}.`,
    stop.current && usePrefs.getState().aiKeepSorting ? `"Keep sorting new links" waits until you start a run or open the app again.` : "",
    unanswered + skipped ? `${plural(unanswered + skipped, "link")} got no answer yet${lastError ? ` (${lastError.replace(/\.$/, "")})` : ""}; ${unanswered + skipped === 1 ? "it is" : "they are"} tried again later.` : "",
    failure ? `${failure}` : "",
  ];
  set({ running: false, waiting: 0, slow: 0, total: kind === "review" ? done : state.total, message: notes.filter(Boolean).join(" ") || null });
  if (kind === "background" && state.done) {
    useLibrary.getState().logActivity("organize", `Sorted ${plural(state.done, "link")} with AI in the background`, `${state.filed} filed onto shelves`);
  }
}

/** Whether an AI provider can answer right now (asked before a run starts by itself). */
async function aiAvailable(): Promise<boolean> {
  try {
    const r = await fetch("/api/ai/providers", { cache: "no-store" });
    return r.ok && (await r.json()).available === true;
  } catch {
    return false;
  }
}

/**
 * "Keep sorting new links": a background run starts by itself a few seconds after unsorted links
 * arrive (an import, a Telegram refresh) and when the app opens with some waiting. Links that got
 * no answer wait RETRY_LATER_MS before a run asks again, so a busy provider is not asked in a loop.
 */
export function startWhenUnsortedLinksWait(keepSorting: () => boolean, jobs: () => Job[]): () => void {
  autoHeld = false;   // turned (back) on, or the app just opened
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checking = false;
  const consider = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!keepSorting() || checking || autoHeld || useAiTidy.getState().running) return;
      const waiting = linksInScope(useLibrary.getState().posts, "unsorted")
        .some(p => Date.now() - (triedAt.get(p.id) ?? 0) > RETRY_LATER_MS);
      if (!waiting) return;
      checking = true;
      const ready = await aiAvailable();
      checking = false;
      if (!ready || !keepSorting() || useAiTidy.getState().running) return;
      useAiTidy.getState().start({ kind: "background", scope: "unsorted", jobs: jobs(), aiReady: true, auto: true });
    }, 4000);
  };
  consider();
  const unsubscribe = useLibrary.subscribe((state, previous) => { if (state.posts !== previous.posts) consider(); });
  // Links set aside for later come back on their own.
  const interval = setInterval(consider, RETRY_LATER_MS);
  return () => { unsubscribe(); clearTimeout(timer); clearInterval(interval); };
}
