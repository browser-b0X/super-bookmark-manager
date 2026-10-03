import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ExternalLink, Pencil, Pin, RefreshCw, Star, Trash2, X } from "lucide-react";
import type { SavedPost } from "../../types";
import { useLibrary } from "../../store/library";
import { PLATFORM_META, STATUS_META, STATUS_ORDER, relTime } from "../../lib/ui";
import { enrichSavedPost, refreshIfStale } from "../../lib/metadataEnrichment";
import SiteLine from "./SiteLine";
import { relatedItems } from "../../lib/relatedItems";
import { libraryUrl, normalizeUrl } from "../../lib/platform";

export default function PostDrawer({ post, onClose }: { post: SavedPost; onClose: () => void }) {
  const navigate = useNavigate();
  const updatePost = useLibrary(s => s.updatePost);
  const restoreTitle = useLibrary(s => s.restoreOriginalTitle);
  const deletePosts = useLibrary(s => s.deletePosts);
  const categories = useLibrary(s => s.categories);
  const posts = useLibrary(s => s.posts);
  const logActivity = useLibrary(s => s.logActivity);
  const [tagInput, setTagInput] = useState("");
  const [enriching, setEnriching] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState<null | "title" | "description">(null);
  const [draft, setDraft] = useState("");

  const panel = useRef<HTMLElement>(null);
  // Dialog behaviour: focus moves in, Tab stays inside, Escape closes, and
  // focus returns to whatever opened the panel.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); onClose(); return; }
      if (e.key !== "Tab" || !panel.current) return;
      const focusable = [...panel.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])')]
        .filter(el => el.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener && opener.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The same page saved under another spelling (http/https, www, tracking
  // parameters, a canonical or redirect target): offer to merge, never automatically.
  const duplicate = useMemo(() => {
    const keys = new Set([post.url, post.canonicalUrl, post.finalUrl].filter((u): u is string => !!u).map(normalizeUrl));
    return posts.find(p => p.id !== post.id && libraryUrl(p.url) !== libraryUrl(post.url)
      && [p.url, p.canonicalUrl, p.finalUrl].some(u => !!u && keys.has(normalizeUrl(u))));
  }, [posts, post]);

  const mergeDuplicate = () => {
    if (!duplicate) return;
    // Keep this link; carry over everything the owner added to the other one.
    const notes = [post.userNotes, duplicate.userNotes].filter(n => n?.trim()).join("\n\n");
    updatePost(post.id, {
      tags: [...new Set([...post.tags, ...duplicate.tags])],
      favorite: post.favorite || duplicate.favorite,
      pinned: post.pinned || duplicate.pinned,
      ...(notes ? { userNotes: notes } : {}),
      createdAt: post.createdAt < duplicate.createdAt ? post.createdAt : duplicate.createdAt,
      ...(post.categories.every(c => c === "uncategorized" || c === "other") && duplicate.categories.some(c => c !== "uncategorized" && c !== "other")
        ? { categories: duplicate.categories } : {}),
      folderPath: post.folderPath?.length ? post.folderPath : duplicate.folderPath,
    });
    deletePosts([duplicate.id]);
    logActivity("organize", "Merged a duplicate link", post.title);
  };

  // Opening a link is a good moment to refresh an old or missing preview.
  useEffect(() => { refreshIfStale(post); }, [post.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const startEdit = (field: "title" | "description") => { setDraft(post[field] ?? ""); setEditing(field); };
  const commitEdit = () => {
    if (!editing) return;
    const value = draft.trim();
    if (value !== (post[editing] ?? "")) {
      // The owner's wording is never replaced by a later metadata refresh.
      updatePost(post.id, { [editing]: value || undefined, fieldSources: { ...post.fieldSources, [editing]: value ? "user" : undefined } });
    }
    setEditing(null);
  };

  const related = useMemo(() => relatedItems(post, posts), [posts, post]);

  const meta = PLATFORM_META[post.platform];
  const MetaIcon = meta.icon;

  const retryMetadata = async () => {
    setEnriching(true);
    await enrichSavedPost(post.id, { force: true });
    setEnriching(false);
  };

  return (
    <>
      <div className="fixed inset-0 z-[90] bg-black/40" onClick={onClose} aria-hidden />
      <aside
        ref={panel}
        tabIndex={-1}
        aria-modal="true"
        className="fixed top-0 right-0 bottom-0 z-[95] flex w-[min(460px,94vw)] flex-col overflow-y-auto border-l p-5 outline-none"
        style={{ background: "var(--surface-solid)", borderColor: "var(--border-hi)", boxShadow: "var(--shadow)" }}
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
          <button className="icon-btn" title="Close" onClick={onClose}><X size={15} /></button>
        </div>

        {editing === "title" ? (
          <input className="input text-[1rem] font-semibold" autoFocus aria-label="Title" value={draft}
            onChange={e => setDraft(e.target.value)} onBlur={commitEdit}
            onKeyDown={e => { if (e.key === "Enter") commitEdit(); if (e.key === "Escape") { e.preventDefault(); setEditing(null); } }} />
        ) : (
          <div className="flex items-start gap-2">
            <h2 className="min-w-0 flex-1 break-words text-[1rem] leading-snug font-semibold">{post.title || post.url}</h2>
            <button className="icon-btn shrink-0 opacity-60 hover:opacity-100" title="Edit title" aria-label="Edit title" onClick={() => startEdit("title")}><Pencil size={13} /></button>
          </div>
        )}
        {post.fieldSources?.title === "ai" && post.originalTitle !== undefined && <p className="mt-1 text-[.7rem] text-[var(--faint)]">
          Title tidied by AI · <button className="underline" onClick={() => restoreTitle(post.id)}
            title={post.originalTitle || "(no title)"}>Restore original</button>
        </p>}
        {post.aiSummary && <p className="mt-1 text-[.76rem] text-[var(--dim)]">{post.aiSummary}</p>}
        <SiteLine post={post} className="mt-1" />
        <div className="mt-0.5 text-[.72rem] text-[var(--faint)]">
          saved {relTime(post.createdAt)}
          {post.lastOpenedAt ? ` · opened ${relTime(post.lastOpenedAt)}` : ""}
          {post.folderPath?.length ? ` · ${post.folderPath.join(" › ")}` : ""}
        </div>
        {post.linkStatus === "gone" && <p role="note" className="mt-2 text-[.74rem] text-[var(--amber)]">This page no longer exists at its address{post.httpStatus ? ` (HTTP ${post.httpStatus})` : ""}. Your saved copy of the details is unchanged.</p>}
        {post.finalUrl && <p className="mt-1 truncate text-[.7rem] text-[var(--faint)]" title={post.finalUrl}>Now redirects to {post.finalUrl}</p>}
        {duplicate && (
          <div role="note" className="mt-2 flex items-center gap-2 rounded-lg border p-2 text-[.74rem]" style={{ borderColor: "var(--border-hi)" }}>
            <span className="min-w-0 flex-1">Possible duplicate of <button className="underline" onClick={() => navigate(`/library/item/${duplicate.id}`)}>{duplicate.title || duplicate.url}</button></span>
            <button className="btn" style={{ padding: "2px 8px", fontSize: ".7rem" }} onClick={mergeDuplicate} title="Keep this link and move tags, notes, favourite and shelf over from the other">Merge into this</button>
          </div>
        )}

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
          preview: <span style={{ color: post.metadataStatus === "failed" ? "var(--red)" : post.metadataStatus === "enriched" ? "var(--green)" : "var(--amber)" }}>
            {post.metadataStatus === "none" ? "site offers none" : post.metadataStatus}</span>
          {post.metadataError ? ` — ${post.metadataError}` : ""}
          {post.metadataRetryAt ? ` Next automatic try in ${Math.max(1, Math.ceil((Date.parse(post.metadataRetryAt) - Date.now()) / 60000))} min.` : ""}
          {post.sourceMessageId ? ` · telegram msg ${post.sourceMessageId}` : ""}
        </div>

        {/* description / excerpt */}
        <div className="panel mt-4 p-3">
          {editing === "description" ? (
            <textarea className="input" rows={4} autoFocus aria-label="Description" value={draft}
              onChange={e => setDraft(e.target.value)} onBlur={commitEdit}
              onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); setEditing(null); } }} />
          ) : (
            <div className="flex items-start gap-2">
              <p className={`flex-1 text-[.8rem] leading-relaxed ${post.description ? "" : "text-[var(--faint)]"}`}>{post.description || "No description."}</p>
              <button className="icon-btn shrink-0 opacity-60 hover:opacity-100" title="Edit description" aria-label="Edit description" onClick={() => startEdit("description")}><Pencil size={13} /></button>
            </div>
          )}
          {post.excerpt && post.excerpt !== post.description && (
            <p className="mt-2 line-clamp-4 text-[.74rem] text-[var(--dim)] italic">“{post.excerpt}”</p>
          )}
        </div>

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
