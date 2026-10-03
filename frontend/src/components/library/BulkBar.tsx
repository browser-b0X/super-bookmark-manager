import { useEffect, useRef, useState } from "react";
import AiReview from "./AiReview";
import { fetchAiStatus } from "./AiProviders";
import { Archive, RefreshCw, Sparkles, Tag, Trash2, X } from "lucide-react";
import { useLibrary } from "../../store/library";
import { STATUS_META, STATUS_ORDER } from "../../lib/ui";
import { enrichMany } from "../../lib/metadataEnrichment";

export default function BulkBar({ ids, onClear }: { ids: string[]; onClear: () => void }) {
  const posts = useLibrary(s => s.posts);
  const categories = useLibrary(s => s.categories);
  const bulkPatch = useLibrary(s => s.bulkPatch);
  const bulkTag = useLibrary(s => s.bulkTag);
  const deletePosts = useLibrary(s => s.deletePosts);
  const updatePost = useLibrary(s => s.updatePost);
  const logActivity = useLibrary(s => s.logActivity);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [tidying, setTidying] = useState(false);
  const [aiReady, setAiReady] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!tidying) return;
    dialog.current?.showModal();
    void fetchAiStatus().then(s => setAiReady(!!s?.available));
  }, [tidying]);

  if (!ids.length) return null;

  const retryAll = async () => {
    setWorking(true);
    // Queued together (3 at a time, with progress in the status bar).
    await enrichMany(ids.filter(id => posts.some(x => x.id === id)), { force: true });
    setWorking(false);
    logActivity("organize", `Refreshed metadata for ${ids.length} items`);
  };

  const addTag = () => {
    const t = window.prompt("Tag to add to selected items:");
    if (t?.trim()) {
      bulkTag(ids, [t.trim().toLowerCase().replace(/\s+/g, "-")], []);
      logActivity("organize", `Tagged ${ids.length} items`, t);
    }
  };

  return (
    <div
      className="fixed bottom-5 left-1/2 z-[80] flex -translate-x-1/2 flex-wrap items-center gap-2 rounded-xl border px-4 py-2.5"
      style={{ background: "var(--elev)", borderColor: "var(--border-hi)", boxShadow: "var(--shadow)" }}
      role="toolbar" aria-label="Bulk actions"
    >
      <span className="text-[.78rem] font-semibold">{ids.length} selected</span>
      <select
        className="input" style={{ width: "auto", padding: "4px 8px", fontSize: ".74rem" }}
        defaultValue=""
        onChange={e => { if (e.target.value) { bulkPatch(ids, { status: e.target.value as never }); logActivity("organize", `Status → ${STATUS_META[e.target.value as keyof typeof STATUS_META].label}`, `${ids.length} items`); e.target.value = ""; } }}
        aria-label="Change status"
      >
        <option value="" disabled>Status…</option>
        {STATUS_ORDER.map(s => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
      </select>
      <select
        className="input" style={{ width: "auto", padding: "4px 8px", fontSize: ".74rem" }}
        defaultValue=""
        onChange={e => {
          const cat = categories.find(c => c.id === e.target.value);
          if (cat) {
            ids.forEach(id => {
              const p = posts.find(x => x.id === id);
              if (p && !p.categories.includes(cat.name)) {
                updatePost(id, { categories: [...p.categories.filter(c => c !== "uncategorized"), cat.name] });
              }
            });
            logActivity("organize", `Assigned “${cat.name}”`, `${ids.length} items`);
          }
          e.target.value = "";
        }}
        aria-label="Assign category"
      >
        <option value="" disabled>Category…</option>
        {categories.filter(c => !c.archived).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <button className="btn" onClick={addTag}><Tag size={13} /> Tag</button>
      <button className="btn" onClick={() => setTidying(true)} disabled={working} title="Suggest shelves, tags and clean titles to review">
        <Sparkles size={13} /> Tidy with AI
      </button>
      <button className="btn" onClick={() => { bulkPatch(ids, { status: "archived" }); onClear(); }}><Archive size={13} /> Archive</button>
      <button className="btn" onClick={retryAll} disabled={working}><RefreshCw size={13} className={working ? "animate-spin" : ""} /> Enrich</button>
      {confirming ? (
        <>
          <button className="btn btn-danger" onClick={() => { deletePosts(ids); onClear(); }}>Confirm</button>
          <button className="btn" onClick={() => setConfirming(false)}>Cancel</button>
        </>
      ) : (
        <button className="btn btn-danger" onClick={() => setConfirming(true)}><Trash2 size={13} /> Delete</button>
      )}
      <button className="icon-btn" onClick={onClear} aria-label="Clear selection"><X size={14} /></button>
      {tidying && <dialog ref={dialog} className="ai-review-dialog" aria-label="Tidy selected links"
        onClose={() => setTidying(false)} onCancel={() => setTidying(false)}>
        <div className="flex items-center justify-end pb-2">
          <button className="icon-btn" aria-label="Close" onClick={() => dialog.current?.close()}><X size={14} /></button>
        </div>
        <AiReview aiReady={aiReady} selectedIds={ids} onDone={() => dialog.current?.close()} />
      </dialog>}
    </div>
  );
}
