import { Pause, Play } from "lucide-react";
import { setEnrichmentPaused, useEnrichmentQueue } from "../../lib/metadataEnrichment";

/** One quiet status line while previews are being fetched in the background. */
export default function EnrichmentProgress({ compact = false }: { compact?: boolean }) {
  const { total, done, running, paused } = useEnrichmentQueue();
  if (!total) return null;
  const label = paused ? `Previews paused · ${done}/${total}` : `Fetching previews · ${done}/${total}`;
  return (
    <div role="status" aria-label="Preview progress" className={compact ? "mt-1 text-[.6rem] text-[var(--dim)]" : "mt-1.5 flex items-center gap-2 text-[.7rem] text-[var(--dim)]"}
      title={compact ? label : undefined}>
      {!compact && <div className="h-1 flex-1 overflow-hidden rounded-full" style={{ background: "var(--surface2)" }}>
        <div className="h-full rounded-full" style={{ width: `${Math.round((done / total) * 100)}%`, background: "var(--accent)", transition: "width .2s var(--ease)" }} />
      </div>}
      <span className={compact ? "sr-only" : "shrink-0"}>{label}</span>
      {compact && <span aria-hidden="true">{done}/{total}</span>}
      <button className="icon-btn shrink-0" style={{ width: 20, height: 20 }}
        aria-label={paused ? "Resume fetching previews" : "Pause fetching previews"}
        onClick={() => setEnrichmentPaused(!paused)} disabled={!paused && !running && done === total}>
        {paused ? <Play size={11} /> : <Pause size={11} />}
      </button>
    </div>
  );
}
