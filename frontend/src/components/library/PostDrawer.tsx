import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Copy, ExternalLink, Pin, RefreshCw, Star, Trash2, X } from "lucide-react";
import type { SavedPost } from "../../types";
import { useLibrary } from "../../store/library";
import { PLATFORM_META, STATUS_META, STATUS_ORDER, relTime } from "../../lib/ui";
import { enrichSavedPost } from "../../lib/metadataEnrichment";
import { relatedItems } from "../../lib/relatedItems";

export default function PostDrawer({ post, onClose }: { post: SavedPost; onClose: () => void }) {
  const navigate = useNavigate();
  const updatePost = useLibrary(s => s.updatePost);
  const deletePosts = useLibrary(s => s.deletePosts);
  const importPosts = useLibrary(s => s.importPosts);
  const categories = useLibrary(s => s.categories);
  const posts = useLibrary(s => s.posts);
  const logActivity = useLibrary(s => s.logActivity);
  const [tagInput, setTagInput] = useState("");
  const [enriching, setEnriching] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const related = useMemo(() => relatedItems(post, posts), [posts, post]);

  const meta = PLATFORM_META[post.platform];
  const MetaIcon = meta.icon;

  const duplicate = () => {
    importPosts([{
      ...post,
      id: post.id + "-copy-" + Date.now().toString(36),
      title: (post.title || "Untitled") + " (copy)",
      pinned: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }]);
  };

  const retryMetadata = async () => {
    setEnriching(true);
    await enrichSavedPost(post.id);
    setEnriching(false);
  };

  return (
    <>
      <div className="fixed inset-0 z-[90] bg-black/40" onClick={onClose} aria-hidden />
      <aside
        className="fixed top-0 right-0 bottom-0 z-[95] flex w-[min(460px,94vw)] flex-col overflow-y-auto border-l p-5"
        style={{ background: "var(--surface)", borderColor: "var(--border-hi)", boxShadow: "var(--shadow)" }}
        role="dialog" aria-label="Saved post detail"
      >
        {/* header actions */}
        <div className="mb-3 flex items-center gap-1.5">
          <span className="chip inline-flex items-center gap-1.5" style={{ color: meta.color }}>
            <MetaIcon size={11} /> {meta.label}
          </span>
          <span className="chip">{post.source}</span>
          <div className="flex-1" />
          <button className="icon-btn" title={post.favorite ? "Unfavorite" : "Favorite"} onClick={() => updatePost(post.id, { favorite: !post.favorite })}>
            <Star size={15} className={post.favorite ? "text-[var(--amber)]" : ""} fill={post.favorite ? "currentColor" : "none"} />
          </button>
          <button className="icon-btn" title={post.pinned ? "Unpin" : "Pin"} onClick={() => updatePost(post.id, { pinned: !post.pinned })}>
            <Pin size={15} className={post.pinned ? "text-[var(--accent)]" : ""} />
          </button>
          <button className="icon-btn" title="Duplicate" onClick={duplicate}><Copy size={15} /></button>
          <button className="icon-btn" title="Close" onClick={onClose}><X size={15} /></button>
        </div>

        <h2 className="text-[1rem] leading-snug font-semibold">{post.title || post.url}</h2>
        <div className="mt-1 text-[.72rem] text-[var(--faint)]">
          {post.domain} · saved {relTime(post.createdAt)}
          {post.lastOpenedAt ? ` · opened ${relTime(post.lastOpenedAt)}` : ""}
        </div>

        {/* source + actions */}
        <div className="mt-3 flex flex-wrap gap-2">
          <a className="btn btn-primary" href={post.url} target="_blank" rel="noopener noreferrer" onClick={() => updatePost(post.id, { lastOpenedAt: new Date().toISOString() })}>
            <ExternalLink size={13} /> Open source
          </a>
          <button className="btn" onClick={retryMetadata} disabled={enriching}>
            <RefreshCw size={13} className={enriching ? "animate-spin" : ""} /> {enriching ? "Enriching…" : "Refresh metadata"}
          </button>
        </div>
        <div className="mt-1.5 text-[.66rem] text-[var(--faint)]">
          metadata: <span style={{ color: post.metadataStatus === "failed" ? "var(--red)" : post.metadataStatus === "enriched" ? "var(--green)" : "var(--amber)" }}>{post.metadataStatus}</span>
          {post.metadataError ? ` — ${post.metadataError}` : ""}
          {post.sourceMessageId ? ` · telegram msg ${post.sourceMessageId}` : ""}
        </div>

        {/* description / excerpt */}
        {(post.description || post.excerpt) && (
          <div className="panel mt-4 p-3">
            {post.description && <p className="text-[.8rem] leading-relaxed">{post.description}</p>}
            {post.excerpt && post.excerpt !== post.description && (
              <p className="mt-2 line-clamp-4 text-[.74rem] text-[var(--dim)] italic">“{post.excerpt}”</p>
            )}
          </div>
        )}

        {/* status */}
        <div className="mt-4">
          <div className="mb-1.5 text-[.66rem] font-semibold tracking-[.8px] text-[var(--faint)] uppercase">Status</div>
          <div className="flex flex-wrap gap-1.5">
            {STATUS_ORDER.map(s => (
              <button
                key={s}
                onClick={() => { updatePost(post.id, { status: s }); logActivity("organize", `Moved to ${STATUS_META[s].label}`, post.title); }}
                className="chip transition-colors"
                style={post.status === s
                  ? { color: STATUS_META[s].color, borderColor: STATUS_META[s].color, background: "var(--accent-bg)" }
                  : undefined}
              >
                {STATUS_META[s].label}
              </button>
            ))}
          </div>
        </div>

        {/* categories */}
        <div className="mt-4">
          <div className="mb-1.5 text-[.66rem] font-semibold tracking-[.8px] text-[var(--faint)] uppercase">Categories</div>
          <div className="flex flex-wrap gap-1.5">
            {categories.filter(c => !c.archived).map(c => {
              const on = post.categories.includes(c.name);
              return (
                <button
                  key={c.id}
                  className="chip inline-flex items-center gap-1.5"
                  style={on ? { color: c.color, borderColor: c.color } : undefined}
                  onClick={() => updatePost(post.id, {
                    categories: on ? post.categories.filter(x => x !== c.name) : [...post.categories.filter(x => x !== "uncategorized"), c.name],
                  })}
                >
                  <span className="dot" style={{ background: c.color, width: 6, height: 6 }} />
                  {c.name}
                </button>
              );
            })}
          </div>
        </div>

        {/* tags */}
        <div className="mt-4">
          <div className="mb-1.5 text-[.66rem] font-semibold tracking-[.8px] text-[var(--faint)] uppercase">Tags</div>
          <div className="flex flex-wrap items-center gap-1.5">
            {post.tags.map(t => (
              <button key={t} className="chip" style={{ color: "var(--violet)" }} onClick={() => updatePost(post.id, { tags: post.tags.filter(x => x !== t) })} title="Remove tag">
                #{t} ×
              </button>
            ))}
            <input
              className="input"
              style={{ width: 120, padding: "3px 8px", fontSize: ".72rem" }}
              placeholder="add tag ⏎"
              value={tagInput}
              onChange={e => setTagInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && tagInput.trim()) {
                  const t = tagInput.trim().toLowerCase().replace(/\s+/g, "-");
                  if (!post.tags.includes(t)) updatePost(post.id, { tags: [...post.tags, t] });
                  setTagInput("");
                }
              }}
            />
          </div>
        </div>

        {/* notes */}
        <div className="mt-4">
          <div className="mb-1.5 text-[.66rem] font-semibold tracking-[.8px] text-[var(--faint)] uppercase">Notes</div>
          <textarea
            className="input"
            rows={3}
            placeholder="Your notes…"
            value={post.userNotes ?? ""}
            onChange={e => updatePost(post.id, { userNotes: e.target.value })}
          />
        </div>

        {/* related */}
        {related.length > 0 && (
          <div className="mt-4">
            <div className="mb-1.5 text-[.66rem] font-semibold tracking-[.8px] text-[var(--faint)] uppercase">Related</div>
            {related.map(r => (
              <button key={r.id} className="block w-full truncate rounded px-1 py-1 text-left text-[.74rem] text-[var(--dim)] hover:bg-[var(--surface2)] hover:text-[var(--text)]" onClick={() => navigate(`/library/item/${r.id}`)}>
                {r.title || r.url}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1" />

        {/* timestamps + danger zone */}
        <div className="mt-5 border-t pt-3 text-[.66rem] text-[var(--faint)]" style={{ borderColor: "var(--border)" }}>
          created {new Date(post.createdAt).toLocaleString()} · updated {new Date(post.updatedAt).toLocaleString()}
        </div>
        <div className="mt-3 flex gap-2">
          <button className="btn" onClick={() => updatePost(post.id, { status: post.status === "archived" ? "reference" : "archived" })}>
            {post.status === "archived" ? "Unarchive" : "Archive"}
          </button>
          {confirmDelete ? (
            <>
              <button className="btn btn-danger" onClick={() => { deletePosts([post.id]); onClose(); }}>Confirm delete</button>
              <button className="btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
            </>
          ) : (
            <button className="btn btn-danger" onClick={() => setConfirmDelete(true)}><Trash2 size={13} /> Delete</button>
          )}
        </div>
      </aside>
    </>
  );
}
