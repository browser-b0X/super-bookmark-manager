import { useEffect, useMemo, useState } from "react";
import { Archive, CheckCircle2, ChevronRight, ExternalLink, PlugZap, RefreshCw } from "lucide-react";
import type { SavedPost } from "../../types";
import { useLibrary } from "../../store/library";
import { backendAvailable } from "../../lib/providers";
import { enrichMany } from "../../lib/metadataEnrichment";
import { checkLostPictures, useLostPictures } from "../../lib/lostPictures";
import { couldNotFetch, failureReason, needsPreview, outcomeOf, pictureCode, type Outcome } from "../../lib/previewHealth";
import { displayTitle } from "../../lib/displayText";
import { PostPreview } from "./PostViews";
import EnrichmentProgress from "./EnrichmentProgress";

const plural = (n: number, single: string, many = single + "s") => `${n} ${n === 1 ? single : many}`;
const one = (n: number) => n === 1;

/** A compact list of links: picture, title, site and why it is listed. */
function LinkRows({ posts, reason, picked, onPick }: {
  posts: SavedPost[]; reason: (p: SavedPost) => string; picked?: Set<string>; onPick?: (id: string) => void;
}) {
  return (
    <ul className="link-rows">
      {posts.map(p => (
        <li key={p.id} className="link-rows__row">
          {picked && onPick && <input type="checkbox" checked={picked.has(p.id)} onChange={() => onPick(p.id)}
            aria-label={`Include ${displayTitle(p.title, p.url)}`} />}
          <span className="link-rows__thumb"><PostPreview post={p} fill caption={false} /></span>
          <span className="link-rows__text">
            <span className="link-rows__title">{displayTitle(p.title, p.url)}</span>
            <span className="link-rows__meta">{p.siteName || p.domain} · <span className="link-rows__why">{reason(p)}</span></span>
          </span>
          <a className="icon-btn" href={p.url} target="_blank" rel="noreferrer noopener" aria-label={`Open ${p.domain} in the browser`} title="Open the page">
            <ExternalLink size={13} />
          </a>
        </li>
      ))}
    </ul>
  );
}

interface RunResult { ids: string[]; done: boolean }

/** Previews & thumbnails: fetch what is missing (and say what came of it), and archive gone links after seeing them. */
export default function PreviewTools() {
  const posts = useLibrary(s => s.posts);
  const [backend, setBackend] = useState<boolean | null>(null);
  const [run, setRun] = useState<RunResult | null>(null);
  const [showFailed, setShowFailed] = useState(false);
  const [reviewGone, setReviewGone] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { void backendAvailable().then(setBackend); }, []);
  // Pictures the links point at that aren't on this computer (after restoring a backup). Asked
  // again when the number of kept pictures changes: the library may still be loading at first.
  const lost = useLostPictures(s => s.codes);
  const kept = useMemo(() => posts.reduce((n, p) => n + (pictureCode(p.thumbnailUrl) ? 1 : 0), 0), [posts]);
  useEffect(() => { void checkLostPictures(useLibrary.getState().posts); }, [kept]);

  const missing = useMemo(() => posts.filter(p => needsPreview(p, lost)), [posts, lost]);
  const gone = useMemo(() => posts.filter(p => p.linkStatus === "gone" && p.status !== "archived"), [posts]);
  const setAside = useMemo(() => posts.filter(p => couldNotFetch(p, lost)), [posts, lost]);

  const fetchMissing = (targets: SavedPost[]) => {
    const ids = targets.map(p => p.id);
    setRun({ ids, done: false }); setShowFailed(false); setMessage(null);
    useLibrary.getState().logActivity("organize", `Fetching previews for ${plural(ids.length, "link")}`);
    void enrichMany(ids, { force: true })
      // Ask again which pictures are missing: fetches store them under the same addresses.
      .then(() => checkLostPictures(useLibrary.getState().posts))
      .then(() => setRun(r => r && r.ids === ids ? { ...r, done: true } : r));
  };

  // What became of the links in the last run (live while it runs).
  const tally = useMemo(() => {
    if (!run) return null;
    const byId = new Map(posts.map(p => [p.id, p]));
    const counts: Record<Outcome, number> = { picture: 0, words: 0, retrying: 0, failed: 0, gone: 0 };
    const failed: SavedPost[] = [];
    for (const id of run.ids) {
      const p = byId.get(id);
      if (!p) continue;
      const o = outcomeOf(p, Date.now(), lost);
      counts[o] += 1;
      if (o === "failed" || o === "retrying") failed.push(p);
    }
    return { counts, failed };
  }, [run, posts, lost]);

  const openGone = () => { setPicked(new Set(gone.map(p => p.id))); setReviewGone(true); setMessage(null); };
  const archivePicked = () => {
    const ids = gone.filter(p => picked.has(p.id)).map(p => p.id);
    useLibrary.getState().bulkPatch(ids, { status: "archived" });
    useLibrary.getState().logActivity("organize", `Archived ${plural(ids.length, "gone link")}`);
    setReviewGone(false);
    setMessage(`Archived ${plural(ids.length, "link")} whose pages no longer exist. They stay searchable (is:gone).`);
  };
  const toggle = (id: string) => setPicked(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  return (
    <section className="panel p-5" aria-labelledby="preview-tools-heading">
      <h3 id="preview-tools-heading" className="flex items-center gap-2 text-[.9rem] font-semibold"><PlugZap size={15} className="text-[var(--accent)]" /> Previews &amp; thumbnails</h3>
      <p className="mt-1.5 flex items-center gap-2 text-[.76rem]">
        <span className="dot" style={{ background: backend === null ? "var(--amber)" : backend ? "var(--green)" : "var(--red)" }} />
        {backend === null ? "Checking…" : backend ? "Flask backend online — rich metadata enrichment available." : "Backend offline — URL-derived fallback metadata is used."}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="btn" onClick={() => fetchMissing(missing)} disabled={missing.length === 0 || (!!run && !run.done)}
          title="Links with no preview yet. Pages that were read but have no picture of their own aren't counted.">
          <RefreshCw size={13} className={run && !run.done ? "animate-spin" : ""} /> Fetch missing previews ({missing.length})
        </button>
        {gone.length > 0 && <button className={"btn" + (reviewGone ? " btn-on" : "")} onClick={() => reviewGone ? setReviewGone(false) : openGone()}
          aria-expanded={reviewGone} title="Pages that answered 404/410 no longer exist at their address">
          <Archive size={13} /> Archive {plural(gone.length, "gone link")}…
        </button>}
      </div>
      <EnrichmentProgress />

      {run && tally && <div className="preview-run" role="status" aria-label="Preview fetch result">
        <div className="preview-run__head">
          {run.done ? <CheckCircle2 size={14} className="text-[var(--green)]" /> : <RefreshCw size={14} className="animate-spin text-[var(--accent)]" />}
          <b>{run.done ? `Checked ${plural(run.ids.length, "link")}` : `Fetching ${plural(run.ids.length, "preview")}…`}</b>
        </div>
        <ul className="preview-run__counts">
          <li data-tone="good"><b>{tally.counts.picture}</b> now {one(tally.counts.picture) ? "has" : "have"} a picture</li>
          <li><b>{tally.counts.words}</b> {one(tally.counts.words) ? "has no picture of its" : "have no picture of their"} own <span>(a text card shows instead)</span></li>
          <li data-tone="warn"><b>{tally.counts.failed + tally.counts.retrying}</b> couldn't be fetched{tally.counts.retrying
            ? <span> ({tally.counts.retrying} will try again by {one(tally.counts.retrying) ? "itself" : "themselves"})</span> : null}</li>
          {tally.counts.gone > 0 && <li data-tone="warn"><b>{tally.counts.gone}</b> {one(tally.counts.gone) ? "is" : "are"} gone <span>(not found — see Archive gone links)</span></li>}
        </ul>
        {tally.failed.length > 0 && <>
          <button className="preview-run__more" aria-expanded={showFailed} onClick={() => setShowFailed(v => !v)}>
            <ChevronRight size={13} className={showFailed ? "rotate-90" : ""} /> {showFailed ? "Hide" : "Show"} the {plural(tally.failed.length, "link")} that couldn't be fetched
          </button>
          {showFailed && <LinkRows posts={tally.failed} reason={failureReason} />}
        </>}
      </div>}
      {!run && setAside.length > 0 && <p className="mt-3 text-[.72rem] text-[var(--faint)]">
        {plural(setAside.length, "link")} couldn't be fetched when you last asked (the site refused or didn't answer) and {setAside.length === 1 ? "isn't" : "aren't"} counted above.{" "}
        <button className="underline text-[var(--accent)]" onClick={() => fetchMissing(setAside)}>Try {setAside.length === 1 ? "it" : "them"} again</button>
      </p>}

      {reviewGone && <div className="gone-review" role="region" aria-label="Gone links to archive">
        <p className="text-[.76rem] text-[var(--dim)]">
          These pages answered “not found” when their preview was last fetched. Archiving moves them out of your shelves and
          feed; they stay searchable (<code>is:gone</code>) and you can restore them. Untick any you want to keep where they are.
        </p>
        <div className="mt-2 flex items-center gap-3 text-[.72rem]">
          <button className="underline text-[var(--accent)]" onClick={() => setPicked(new Set(gone.map(p => p.id)))}>Select all</button>
          <button className="underline text-[var(--accent)]" onClick={() => setPicked(new Set())}>None</button>
          <span className="text-[var(--faint)]">{picked.size} of {gone.length} selected</span>
        </div>
        <LinkRows posts={gone} reason={failureReason} picked={picked} onPick={toggle} />
        <div className="mt-3 flex gap-2">
          <button className="btn btn-primary" disabled={!picked.size} onClick={archivePicked}><Archive size={13} /> Archive {plural(picked.size, "link")}</button>
          <button className="btn" onClick={() => setReviewGone(false)}>Cancel</button>
        </div>
      </div>}
      {message && <p role="status" aria-label="Library tools result" className="mt-3 rounded-lg border p-2.5 text-[.76rem]" style={{ borderColor: "var(--border-hi)", background: "var(--surface2)" }}>{message}</p>}
      <p className="mt-3 text-[.66rem] text-[var(--faint)]">
        Previews come from each page's own metadata, fetched by the local server. Telegram's link previews supply
        Instagram images; when a site blocks previews the feed shows a styled caption card instead.
      </p>
    </section>
  );
}
