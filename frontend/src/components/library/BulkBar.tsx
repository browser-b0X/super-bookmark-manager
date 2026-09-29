import { useState } from "react";
import { Archive, RefreshCw, Sparkles, Tag, Trash2, X } from "lucide-react";
import { useLibrary } from "../../store/library";
import { STATUS_META, STATUS_ORDER } from "../../lib/ui";
import { enrichSavedPost } from "../../lib/metadataEnrichment";

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

  if (!ids.length) return null;

  const retryAll = async () => {
    setWorking(true);
    for (const id of ids) {
      const p = posts.find(x => x.id === id);
      if (!p) continue;
      await enrichSavedPost(id);
    }
    setWorking(false);
    logActivity("organize", `Retried metadata for ${ids.length} items`);
  };

  const autoCategorize = async () => {
    setWorking(true);
    let applied = 0;
    let unreachable = false;
    for (const id of ids) {
      const p = posts.find(x => x.id === id);
      if (!p) continue;
      const parts: string[] = [];
      if (p.title) parts.push(`Title: ${p.title}`);
      if (p.url) parts.push(`URL: ${p.url}`);
      const body = p.excerpt || p.description || "";
      if (body) parts.push(`Text: ${body.slice(0, 1500)}`);
      if (!parts.length) continue;
      const tgMsgId = p.id.startsWith("tg-") ? p.id.slice(3) : undefined;
      try {
        const res = await fetch("/api/categorize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: parts.join("\n"), tg_msg_id: tgMsgId }),
          signal: AbortSignal.timeout(120000),
        });
        if (!res.ok) continue;
        const data = await res.json() as {
          category_name?: string;
          suggested_tags?: string[]; reasoning?: string;
        };
        const catName = (data.category_name || "").trim().toLowerCase().replace(/\s+/g, "-");
        if (!catName) continue;
        // The backend is reuse-only: catName is always an existing shelf or
        // 'other', so there is nothing to create here.
        const tags = (data.suggested_tags || []).filter(t => !p.tags.includes(t));
        updatePost(id, {
          categories: [...p.categories.filter(c => c !== "uncategorized" && c !== catName), catName],
          ...(tags.length ? { tags: [...p.tags, ...tags] } : {}),
          ...(data.reasoning ? { aiSummary: data.reasoning } : {}),
        });
        applied += 1;
      } catch {
        unreachable = true; // backend down — stop hammering it
        break;
      }
    }
    setWorking(false);
    if (unreachable && applied === 0) {
      window.alert("Auto-categorize needs the dashboard backend (LiteLLM proxy / local LLM). Is the server running?");
      return;
    }
    logActivity("organize", `Auto-categorized ${applied} of ${ids.length} items`);
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
      <button className="btn" onClick={autoCategorize} disabled={working} title="Classify with the LiteLLM categorizer (proxy → local LLM → keywords)">
        <Sparkles size={13} className={working ? "animate-pulse" : ""} /> Categorize
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
    </div>
  );
}
