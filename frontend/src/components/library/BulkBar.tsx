import { useEffect, useRef, useState } from "react";
import AiReview from "./AiReview";
import { fetchAiStatus, notAnswering } from "./AiProviders";
import { Archive, FileDown, Pencil, RefreshCw, Share2, Sparkles, Tag, Trash2, X } from "lucide-react";
import BulkEditDialog from "./BulkEditDialog";
import ShareDialog from "./ShareDialog";
import { useLibrary } from "../../store/library";
import { STATUS_META, STATUS_ORDER } from "../../lib/ui";
import { enrichMany } from "../../lib/metadataEnrichment";
import { useCopyAvailability } from "../../lib/copyAvailability";
import { saveCopies } from "../../lib/savedCopies";
import { checkLostCopies, hasCopy, useLostCopies } from "../../lib/lostCopies";

const items = (n: number) => `${n} item${n === 1 ? "" : "s"}`;

export default function BulkBar({ ids, onClear, onUndoable }: { ids: string[]; onClear: () => void; onUndoable?: (message: string, undo: () => void) => void }) {
  const posts = useLibrary(s => s.posts);
  const categories = useLibrary(s => s.categories);
  const bulkPatch = useLibrary(s => s.bulkPatch);
  const addToShelf = useLibrary(s => s.addToShelf);
  const bulkTag = useLibrary(s => s.bulkTag);
  const deletePosts = useLibrary(s => s.deletePosts);
  const logActivity = useLibrary(s => s.logActivity);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [tidying, setTidying] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [aiReady, setAiReady] = useState(false);
  const [aiDown, setAiDown] = useState<string[]>([]);
  const copiesEnabled = useCopyAvailability(s => s.enabled);
  const lostCopies = useLostCopies(s => s.keys);
  const withoutCopy = ids.filter(id => { const post = posts.find(x => x.id === id); return !post || !hasCopy(post, lostCopies); }).length;
  const dialog = useRef<HTMLDialogElement>(null);

  // Copies a restored backup's links point at may not be on this computer (see lostCopies).
  const selecting = ids.length > 0;
  useEffect(() => { if (selecting && copiesEnabled) void checkLostCopies(useLibrary.getState().posts); }, [selecting, copiesEnabled]);

  useEffect(() => {
    if (!tidying) return;
    dialog.current?.showModal();
    void fetchAiStatus().then(s => { setAiReady(!!s?.available); setAiDown(notAnswering(s)); });
  }, [tidying]);

  if (!ids.length) return null;

  const retryAll = async () => {
    setWorking(true);
    // Queued together (3 at a time, with progress in the status bar).
    await enrichMany(ids.filter(id => posts.some(x => x.id === id)), { force: true });
    setWorking(false);
    logActivity("organize", `Refreshed metadata for ${items(ids.length)}`);
  };

  const addTag = () => {
    const t = window.prompt("Tag to add to selected items:");
    if (t?.trim()) {
      bulkTag(ids, [t.trim().toLowerCase().replace(/\s+/g, "-")], []);
      logActivity("organize", `Tagged ${items(ids.length)}`, t);
    }
  };

  return (
    <div
      className="bulk-bar z-[80] flex flex-wrap items-center gap-2 rounded-xl border px-4 py-2.5"
      style={{ background: "var(--elev)", borderColor: "var(--border-hi)", boxShadow: "var(--shadow)" }}
      role="toolbar" aria-label="Bulk actions"
    >
      <span className="text-[.78rem] font-semibold">{ids.length} selected</span>
      <select
        className="input" style={{ width: "auto", padding: "4px 8px", fontSize: ".74rem" }}
        defaultValue=""
        onChange={e => { if (e.target.value) { bulkPatch(ids, { status: e.target.value as never }); logActivity("organize", `Status → ${STATUS_META[e.target.value as keyof typeof STATUS_META].label}`, items(ids.length)); e.target.value = ""; } }}
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
            // One write for the whole selection (one per link took seconds on a big library).
            addToShelf(ids, cat.name);
            logActivity("organize", `Assigned “${cat.name}”`, items(ids.length));
          }
          e.target.value = "";
        }}
        aria-label="Assign category"
      >
        <option value="" disabled>Category…</option>
        {categories.filter(c => !c.archived).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <button className="btn" onClick={addTag}><Tag size={13} /> Tag</button>
      <button className="btn" onClick={() => setEditing(true)} title="Add, remove or replace tags and shelves, or set the status, on all of them"><Pencil size={13} /> Edit…</button>
      {editing && <BulkEditDialog ids={ids} onClose={() => setEditing(false)} onDone={records => {
        if (!records.length) return;
        const message = `Changed ${items(records.length)}`;
        logActivity("organize", message);
        onUndoable?.(message, () => { useLibrary.getState().undoEdit(records); });
      }} />}
      <button className="btn" onClick={() => setTidying(true)} disabled={working} title="Suggest shelves, tags and clean titles to review">
        <Sparkles size={13} /> Tidy with AI
      </button>
      <button className="btn" onClick={() => { bulkPatch(ids, { status: "archived" }); onClear(); }}><Archive size={13} /> Archive</button>
      <button className="btn" onClick={retryAll} disabled={working}><RefreshCw size={13} className={working ? "animate-spin" : ""} /> Enrich</button>
      {copiesEnabled && <button className="btn" disabled={!withoutCopy}
        title={withoutCopy ? `Save an offline copy of ${withoutCopy === 1 ? "the selected link that has none" : `the ${withoutCopy} selected links that have none`}` : "Every selected link already has a copy"}
        onClick={() => { const count = saveCopies(ids); if (count) logActivity("organize", `Saving copies of ${count} link${count === 1 ? "" : "s"}`); }}>
        <FileDown size={13} /> Save copies
      </button>}
      <button className="btn" onClick={() => setSharing(true)} title="Download the selected links as one page to send or put online">
        <Share2 size={13} /> Share
      </button>
      {sharing && <ShareDialog name={`${ids.length} selected link${ids.length === 1 ? "" : "s"}`}
        posts={ids.map(id => posts.find(x => x.id === id)).filter((p): p is NonNullable<typeof p> => !!p)} onClose={() => setSharing(false)} />}
      {confirming ? (
        <>
          <button className="btn btn-danger" onClick={() => {
            const entry = deletePosts(ids);
            onClear();
            if (entry) onUndoable?.(`Removed ${items(ids.length)}. They're kept in Settings → Clean up & undo → Removed links.`, () => { useLibrary.getState().undoHistory(entry); });
          }}>Confirm</button>
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
        <AiReview aiReady={aiReady} aiDown={aiDown} selectedIds={ids} onDone={() => dialog.current?.close()} />
      </dialog>}
    </div>
  );
}
