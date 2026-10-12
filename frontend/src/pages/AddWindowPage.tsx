import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ExternalLink, ImagePlus, LoaderCircle, TriangleAlert } from "lucide-react";
import type { SavedPost } from "../types";
import { findSavedByUrl, useLibrary } from "../store/library";
import { usePrefs } from "../store/prefs";
import { useLegacyMigration } from "../lib/migrate";
import { syncLibrary } from "../lib/libraryPersistence";
import { enrichSavedPost } from "../lib/metadataEnrichment";
import { useCopyAvailability } from "../lib/copyAvailability";
import { formatCopyDate, saveCopy, saveInstagramCopy } from "../lib/savedCopies";
import { isInstagramPost, readInstagramData, type InstagramData } from "../lib/instagram";

/**
 * The small Save window the bookmark button opens: /add?url=…&title=…&note=…
 *
 * Opening it never writes anything. The link is saved only when the owner
 * clicks Save, through the app's ordinary same-origin save. Everything in the
 * address is untrusted text: capped, checked as a URL, shown escaped (React).
 */

const INSTAGRAM_ORIGIN = /^https:\/\/([a-z0-9-]+\.)?instagram\.com$/;
const STATUSES: { id: SavedPost["status"]; label: string }[] = [
  { id: "inbox", label: "Inbox" }, { id: "to-review", label: "To Review" }, { id: "reference", label: "Reference" },
];

function readQuery() {
  const query = new URLSearchParams(window.location.search);
  const raw = (query.get("url") ?? "").slice(0, 4096).trim();
  let url = "";
  try { if (["http:", "https:"].includes(new URL(raw).protocol)) url = raw; } catch { /* not a web address */ }
  return { url, title: (query.get("title") ?? "").slice(0, 500).trim(), note: (query.get("note") ?? "").slice(0, 500).trim() };
}

const tagList = (text: string) =>
  [...new Set(text.split(",").map(t => t.trim().replace(/^#/, "").toLowerCase()).filter(Boolean))].slice(0, 30);

type Phase = "form" | "saving" | "saved" | "picture" | "updated";

export default function AddWindowPage() {
  const boot = useLegacyMigration();
  // Latched: later saves from this window briefly report "syncing" and must not reset the view.
  const [ready, setReady] = useState(false);
  useEffect(() => { if (boot === "done") setReady(true); }, [boot]);
  const copiesOn = useCopyAvailability(s => s.enabled);
  const autoSave = usePrefs(s => s.autoSaveCopies);
  const posts = useLibrary(s => s.posts);
  const initial = useMemo(readQuery, []);
  const instagram = !!initial.url && isInstagramPost(initial.url);
  const [title, setTitle] = useState(initial.title);
  const [note, setNote] = useState(initial.note);
  const [status, setStatus] = useState<SavedPost["status"]>("inbox");
  const [tags, setTags] = useState("");
  const [copy, setCopy] = useState(true);
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState("");
  const [igData, setIgData] = useState<InstagramData | null>(null);
  const [igWaiting, setIgWaiting] = useState(instagram);
  const savedId = useRef<string>("");
  // Looked up once, when the library is loaded; shown live afterwards.
  const [existingId, setExistingId] = useState<string | null>(null);
  useEffect(() => {
    if (ready && existingId === null) setExistingId(initial.url ? findSavedByUrl(useLibrary.getState().posts, initial.url)?.id ?? "" : "");
  }, [ready, existingId, initial.url]);
  const existing = existingId ? posts.find(p => p.id === existingId) : undefined;

  useEffect(() => { document.title = "Save to SuperBookmarks"; }, []);
  useEffect(() => { setCopy(instagram ? true : autoSave); }, [autoSave, instagram]);

  // Instagram: tell the post's tab this window is ready, then take one message in the expected shape.
  useEffect(() => {
    if (!instagram || !window.opener) { setIgWaiting(false); return; }
    const opener = window.opener as Window;
    const onMessage = (event: MessageEvent) => {
      if (!INSTAGRAM_ORIGIN.test(event.origin) || event.source !== opener) return;
      const data = event.data as { type?: unknown; post?: unknown } | null;
      if (!data || data.type !== "sbm-instagram") return;
      const post = readInstagramData(data.post);
      if (post) {
        setIgData(post);
        setIgWaiting(false);
        // Instagram's tab title is just "Instagram": name the link after the author unless the owner typed one.
        if (post.author || post.handle) setTitle(t => (t === initial.title ? `${post.author || "@" + post.handle} on Instagram` : t));
      }
    };
    window.addEventListener("message", onMessage);
    let tries = 0;
    const hello = window.setInterval(() => {
      if (++tries > 10) { window.clearInterval(hello); setIgWaiting(false); return; }
      try { opener.postMessage({ type: "sbm-ready" }, "*"); } catch { /* the tab went away */ }
    }, 500);
    return () => { window.removeEventListener("message", onMessage); window.clearInterval(hello); };
  }, [instagram, initial.title]);

  // An Instagram post already saved without its picture: the button's data fills it in at once.
  useEffect(() => {
    if (!existing || !igData || !copiesOn || phase !== "form") return;
    if (existing.thumbnailUrl?.startsWith("/thumb/") && existing.archiveStatus === "saved") return;
    savedId.current = existing.id;
    setPhase("saving");
    saveInstagramCopy(existing.id, igData);
    void waitForCopy(existing.id).then(() => syncLibrary()).then(() => setPhase("picture"));
  }, [existing, igData, copiesOn, phase]);

  useEffect(() => {
    if (phase !== "saved") return;
    const timer = window.setTimeout(() => window.close(), 2000);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const openInApp = (id: string) => {
    window.open(`/library/item/${encodeURIComponent(id)}`, "_blank", "noopener");
    window.close();
  };

  const save = async () => {
    setError("");
    const store = useLibrary.getState();
    // The link may have arrived since this window opened (another tab, a sync).
    const before = findSavedByUrl(store.posts, initial.url);
    const post = store.addByUrl(initial.url, { copy: copy && copiesOn });
    if (!post) { setError("This page's address can't be saved."); return; }
    savedId.current = post.id;
    setPhase("saving");
    store.updatePost(post.id, before ? {
      // Already saved: add this window's tags and note, never replace the owner's status, tags or notes.
      tags: [...new Set([...before.tags, ...tagList(tags)])],
      ...(note ? { userNotes: before.userNotes?.trim() ? `${before.userNotes}\n\n${note}` : note } : {}),
    } : {
      ...(title && title !== post.title ? { title, fieldSources: { ...post.fieldSources, title: title === initial.title ? "fetched" : "user" } } : {}),
      ...(note ? { userNotes: note } : {}),
      status,
      tags: tagList(tags),
    });
    if (copy && copiesOn) {
      if (instagram && igData) saveInstagramCopy(post.id, igData);
      else if (!instagram && post.archiveStatus !== "pending") saveCopy(post.id);
    }
    void enrichSavedPost(post.id);
    const stored = await syncLibrary();
    if (instagram && igData && copy && copiesOn) await waitForCopy(post.id);
    if (!stored) { setPhase("form"); setError("The link couldn't be stored. Check that the app is still running, then try again."); return; }
    setPhase("saved");
  };

  const updateTags = async () => {
    if (!existing) return;
    useLibrary.getState().updatePost(existing.id, { tags: [...new Set([...existing.tags, ...tagList(tags)])] });
    setPhase("saving");
    await syncLibrary();
    setPhase("updated");
  };

  const header = (
    <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
      <img src="/brand-logo.svg" width={18} height={18} alt="" />
      <h1 className="text-[.85rem] font-semibold">Save to SuperBookmarks</h1>
    </div>
  );
  const label = (text: string) => <div className="mb-1 text-[.66rem] font-semibold tracking-[.8px] text-[var(--faint)] uppercase">{text}</div>;
  const shell = (children: React.ReactNode) => <main className="min-h-screen" style={{ background: "var(--bg)" }}>{header}{children}</main>;

  if (!initial.url) return shell(
    <p role="alert" className="flex items-start gap-2 px-5 py-6 text-[.8rem]"><TriangleAlert size={15} className="mt-0.5 text-[var(--amber)]" />
      This page's address can't be saved. Only web pages (http and https) can be added.</p>);

  if (!ready || existingId === null || phase === "saving") return shell(
    <p role="status" className="flex items-center gap-2 px-5 py-6 text-[.8rem] text-[var(--dim)]">
      <LoaderCircle size={15} className="animate-spin text-[var(--accent)]" />
      {!ready ? "Opening your library…" : instagram ? "Saving the link and the post's pictures…" : "Saving…"}
    </p>);

  if (phase === "saved") return shell(
    <div className="flex flex-col items-center px-6 py-16 text-center" role="status">
      <Check size={40} className="text-[var(--green)]" aria-hidden="true" />
      <p className="mt-3 text-[1rem] font-semibold">Saved</p>
      <p className="mt-1 text-[.76rem] text-[var(--dim)]">
        In {STATUSES.find(s => s.id === status)?.label ?? "Inbox"}{copy && copiesOn ? ", with a saved copy on the way" : ""}. This window closes in 2 seconds.
      </p>
      <button className="btn mt-4" onClick={() => openInApp(savedId.current)}><ExternalLink size={13} /> Open in the app</button>
    </div>);

  if (phase === "picture" && existing) return shell(
    <div className="px-5 py-6" role="status">
      <p className="flex items-center gap-2 text-[.9rem] font-semibold"><ImagePlus size={16} className="text-[var(--green)]" /> Picture added</p>
      <p className="mt-1 text-[.76rem] text-[var(--dim)]">This post was already in your library without a picture. Its picture, caption and a saved copy have been added to it; nothing was added twice.</p>
      <div className="mt-5 flex gap-2">
        <button className="btn btn-primary" onClick={() => openInApp(existing.id)}><ExternalLink size={13} /> Open in the app</button>
        <button className="btn btn-ghost" onClick={() => window.close()}>Close</button>
      </div>
    </div>);

  if (existing) return shell(
    <div className="px-5 py-6">
      <p className="flex items-center gap-2 text-[.9rem] font-semibold"><Check size={16} className="text-[var(--green)]" /> Already in your library</p>
      <p className="mt-1 text-[.76rem] text-[var(--dim)]">
        Saved {formatCopyDate(existing.createdAt)} as “{existing.title || existing.url}”, in {STATUSES.find(s => s.id === existing.status)?.label ?? existing.status}. Nothing was added twice.
      </p>
      <div className="mt-3">{label("Tags")}
        <div className="flex flex-wrap items-center gap-1.5">
          {existing.tags.map(t => <span key={t} className="chip">#{t}</span>)}
          <input className="input" style={{ width: 180, padding: "3px 8px", fontSize: ".74rem" }} placeholder="add tags, separated by commas"
            aria-label="Add tags" value={tags} onChange={e => setTags(e.target.value)} />
        </div>
      </div>
      {phase === "updated" && <p role="status" className="mt-2 text-[.74rem] text-[var(--green)]">Tags updated.</p>}
      <div className="mt-5 flex flex-wrap gap-2">
        <button className="btn btn-primary" onClick={() => openInApp(existing.id)}><ExternalLink size={13} /> Open in the app</button>
        <button className="btn" onClick={() => void updateTags()} disabled={!tagList(tags).length}>Update tags</button>
        <button className="btn btn-ghost" onClick={() => window.close()}>Close</button>
      </div>
    </div>);

  return shell(
    <form className="px-5 pb-5" onSubmit={e => { e.preventDefault(); void save(); }}>
      <div className="mt-3">{label("Address")}
        <div className="input" style={{ opacity: 0.8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={initial.url}>{initial.url}</div>
      </div>
      <div className="mt-3">{label("Title")}<input className="input" aria-label="Title" value={title} onChange={e => setTitle(e.target.value)} /></div>
      {instagram && (igWaiting
        ? <p role="status" className="mt-3 flex items-center gap-2 text-[.74rem] text-[var(--dim)]"><LoaderCircle size={13} className="animate-spin" /> Reading the post…</p>
        : igData ? (
          <div className="mt-3 rounded-lg border p-3" style={{ borderColor: "var(--border-hi)" }} aria-label="The Instagram post">
            <div className="text-[.78rem]"><b>{igData.author || igData.handle || "Instagram"}</b>
              {igData.handle && <span className="text-[var(--dim)]"> @{igData.handle}</span>}</div>
            {igData.caption && <p className="mt-2 line-clamp-3 text-[.76rem]">{igData.caption}</p>}
            <p className="mt-2 text-[.72rem] text-[var(--dim)]">
              {igData.pictures.length ? `${igData.pictures.length} picture${igData.pictures.length === 1 ? "" : "s"} and the caption will be saved with the link.` : "No pictures were found on the page; the caption will be saved."}
              {igData.video ? " It's a video post: the cover picture is kept; the video needs the browser extension (v0.4.0)." : ""}
            </p>
          </div>
        ) : <p role="note" className="mt-3 text-[.74rem] text-[var(--amber)]">The post's caption and pictures didn't come through. You can still save the link; click the button again on the open post to add them later.</p>)}
      {!instagram && <div className="mt-3">{label("Note (from your selection)")}
        <textarea className="input" rows={2} aria-label="Note" value={note} onChange={e => setNote(e.target.value)} /></div>}
      <div className="mt-3">{label("Status")}
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Status">
          {STATUSES.map(s => <button type="button" key={s.id} role="radio" aria-checked={status === s.id} className="chip"
            style={status === s.id ? { color: "var(--accent)", borderColor: "var(--accent)", background: "var(--accent-bg)" } : undefined}
            onClick={() => setStatus(s.id)}>{s.label}</button>)}
        </div>
      </div>
      <div className="mt-3">{label("Tags")}<input className="input" aria-label="Tags" placeholder="add tags, separated by commas" value={tags} onChange={e => setTags(e.target.value)} /></div>
      {copiesOn && (!instagram || igData) && <label className="mt-4 flex items-center gap-2 text-[.78rem]">
        <input type="checkbox" checked={copy} onChange={e => setCopy(e.target.checked)} />
        {instagram ? "Save the pictures and caption (a saved copy)" : "Save a copy of the page"}
      </label>}
      {error && <p role="alert" className="mt-3 text-[.74rem] text-[var(--red)]">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="btn" onClick={() => window.close()}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={igWaiting}>Save</button>
      </div>
    </form>);
}

/** Until the link's copy is no longer being made (at most 40 s), so this window can close. */
async function waitForCopy(id: string) {
  const end = Date.now() + 40000;
  while (Date.now() < end) {
    const post = useLibrary.getState().posts.find(p => p.id === id);
    if (!post || post.archiveStatus !== "pending") return;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}
