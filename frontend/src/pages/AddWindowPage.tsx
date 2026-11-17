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
import { isInstagramPost, readInstagramData, type InstagramData, type InstagramFiles } from "../lib/instagram";
import { filesFor, megabytes, readMediaMessage, uploadTabFile, type TabFile } from "../lib/tabMedia";
import { postName, withoutTracking } from "../lib/platform";
import {
  firstLine, instagramDataOf, instagramTitle, postAddress, postAge, readKept, readPagePosts, savedByKey, shelfOf, SITE_NAMES,
  type KeptItem, type KeptNotice, type PagePost,
} from "../lib/pagePosts";

/**
 * The small Save window the bookmark button opens: /add?url=…&title=…&note=…
 *
 * Opening it never writes anything. The link is saved only when the owner
 * clicks Save, through the app's ordinary same-origin save. Everything in the
 * address is untrusted text: capped, checked as a URL, shown escaped (React).
 *
 * The browser extension opens it with &from=extension and hands over what it read
 * in the owner's tab (the open post, or the posts loaded on a feed, profile or
 * search page) through a small script it puts in this window: so that message
 * comes from this window itself, which no website can send.
 */

const INSTAGRAM_ORIGIN = /^https:\/\/([a-z0-9-]+\.)?instagram\.com$/;
const STATUSES: { id: SavedPost["status"]; label: string }[] = [
  { id: "inbox", label: "Inbox" }, { id: "to-review", label: "To Review" }, { id: "reference", label: "Reference" },
];

function readQuery() {
  const query = new URLSearchParams(window.location.search);
  const raw = (query.get("url") ?? "").slice(0, 4096).trim();
  let url = "";
  // Saved without tracking parameters (utm_…, fbclid, a share button's si=…): the page is the same without them.
  try { if (["http:", "https:"].includes(new URL(raw).protocol)) url = withoutTracking(raw); } catch { /* not a web address */ }
  return { url, title: (query.get("title") ?? "").slice(0, 500).trim(), note: (query.get("note") ?? "").slice(0, 500).trim(),
    fromExtension: query.get("from") === "extension", unpaired: query.get("unpaired") === "1" };
}

/** TikTok's For You and Following feeds, where no video shows its own address (2026). */
const tiktokFeed = (url: string) => {
  try {
    const u = new URL(url);
    return /^(www\.|m\.)?tiktok\.com$/i.test(u.hostname) && /^\/(foryou|following)?\/?$/i.test(u.pathname);
  } catch { return false; }
};

const tagList = (text: string) =>
  [...new Set(text.split(",").map(t => t.trim().replace(/^#/, "").toLowerCase()).filter(Boolean))].slice(0, 30);

const CHOSEN = { color: "var(--accent)", borderColor: "var(--accent)", background: "var(--accent-bg)" };
const label = (text: string) => <div className="mb-1 text-[.66rem] font-semibold tracking-[.8px] text-[var(--faint)] uppercase">{text}</div>;

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
  // A post gets the name the library gives it ("@handle on X"), whatever its tab is called or when it came with none;
  // an Instagram post's author comes with what the tab hands over.
  const suggested = useMemo(() => postName(initial.url) || (instagram ? "Instagram post" : initial.title), [initial.url, initial.title, instagram]);
  const [title, setTitle] = useState(suggested);
  const [note, setNote] = useState(initial.note);
  const [status, setStatus] = useState<SavedPost["status"]>("inbox");
  const [tags, setTags] = useState("");
  const [copy, setCopy] = useState(true);
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState("");
  const [igData, setIgData] = useState<InstagramData | null>(null);
  // Waiting for what the bookmark button or the extension read in the owner's tab.
  const [waiting, setWaiting] = useState(instagram || initial.fromExtension);
  // From the extension: the open X or TikTok post, or the posts on a feed, profile or search page.
  const [postData, setPostData] = useState<PagePost | null>(null);
  const [pagePosts, setPagePosts] = useState<PagePost[] | null>(null);
  const [view, setView] = useState<"kept" | "posts" | "page">("posts");
  // From the extension: what it kept while SuperBookmarks wasn't running.
  const [kept, setKept] = useState<{ items: KeptItem[]; notices: KeptNotice[]; rejected: string[] } | null>(null);
  // From the extension, for one Instagram post: its pictures and video as files from the tab, and the upload.
  const [tabFiles, setTabFiles] = useState<TabFile[]>([]);
  const tabFilesRef = useRef<TabFile[]>([]);
  const mediaFor = useRef("");
  // From the extension, for an Instagram video: whether the page held the video's file (null: nobody said).
  const [videoFile, setVideoFile] = useState<boolean | null>(null);
  const videoFileRef = useRef<boolean | null>(null);
  const [upload, setUpload] = useState<{ sent: number; total: number } | null>(null);
  const savedId = useRef<string>("");
  // Looked up once, when the library is loaded; shown live afterwards.
  const [existingId, setExistingId] = useState<string | null>(null);
  useEffect(() => {
    if (ready && existingId === null) setExistingId(initial.url ? findSavedByUrl(useLibrary.getState().posts, initial.url)?.id ?? "" : "");
  }, [ready, existingId, initial.url]);
  const existing = existingId ? posts.find(p => p.id === existingId) : undefined;

  useEffect(() => { document.title = "Save to SuperBookmarks"; }, []);
  useEffect(() => { setCopy(instagram ? true : autoSave); }, [autoSave, instagram]);

  // Tell the sender this window is ready, then take one message in the expected shape from exactly that sender:
  // the bookmark button (the Instagram post's tab, which opened this window) or the extension (its script in this window).
  useEffect(() => {
    const opener = window.opener as Window | null;
    if (!initial.fromExtension && !(instagram && opener)) { setWaiting(false); return; }
    const takeInstagram = (post: InstagramData | null) => {
      if (!post) return false;
      setIgData(post);
      // Instagram's tab title is just "Instagram": name the link after the author unless the owner typed one.
      const name = instagramTitle(post);
      if (name) setTitle(t => (t === suggested ? name : t));
      return true;
    };
    let done = false;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; post?: unknown } | null;
      if (done || !data || typeof data !== "object") return;
      if (initial.fromExtension) {
        if (event.source !== window || event.origin !== window.location.origin || data.type !== "sbm-posts") return;
        const read = readPagePosts(data);
        const keptRead = readKept(data);
        if (!read && !keptRead) return;
        if (keptRead && keptRead.items.length) { setKept(keptRead); setView("kept"); }
        // Kept items this window can't use: the extension lets them go rather than keeping them for ever.
        else if (keptRead) window.postMessage({ type: "sbm-queue-done", ids: keptRead.rejected }, window.location.origin);
        const here = postAddress(initial.url);
        if (read && read.single && here && read.single.key === here.key) {
          if (read.single.site === "instagram") {
            takeInstagram(instagramDataOf(read.single));
            videoFileRef.current = read.single.video ? read.single.videoFile === true : null;
            setVideoFile(videoFileRef.current);
            // Its pictures and video come over from the tab while the owner looks at the window.
            mediaFor.current = read.single.url;
            window.postMessage({ type: "sbm-want-media", posts: [read.single.url] }, window.location.origin);
          } else setPostData(read.single);
        }
        if (read && read.posts.length) setPagePosts(read.posts);
      } else {
        if (!INSTAGRAM_ORIGIN.test(event.origin) || event.source !== opener || data.type !== "sbm-instagram") return;
        if (!takeInstagram(readInstagramData(data.post))) return;
      }
      done = true;
      setWaiting(false);
    };
    window.addEventListener("message", onMessage);
    let tries = 0;
    const hello = window.setInterval(() => {
      if (done || ++tries > (initial.fromExtension ? 20 : 10)) { window.clearInterval(hello); setWaiting(false); return; }
      try {
        if (initial.fromExtension) window.postMessage({ type: "sbm-ready" }, window.location.origin);
        else opener?.postMessage({ type: "sbm-ready" }, "*");
      } catch { /* the tab went away */ }
    }, 500);
    return () => { window.removeEventListener("message", onMessage); window.clearInterval(hello); };
  }, [instagram, initial.title, initial.fromExtension, initial.url, suggested]);

  // The Instagram post's files, as the extension's helper in this window hands them over (or says why not).
  useEffect(() => {
    if (!initial.fromExtension) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const read = readMediaMessage(event.data);
      if (!read || read.post !== mediaFor.current) return;
      const next = [...tabFilesRef.current.filter(f => f.url !== read.file.url), read.file];
      tabFilesRef.current = next;
      setTabFiles(next);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [initial.fromExtension]);

  /** Upload the files the tab handed over (waiting up to 2 minutes for any still coming) and say which the copy has. */
  const filesForCopy = async (): Promise<{ files?: InstagramFiles }> => {
    if (!mediaFor.current) return {};
    const end = Date.now() + 120000;
    while (Date.now() < end && tabFilesRef.current.some(f => !f.blob && !f.error)) await new Promise(r => setTimeout(r, 200));
    const ready = tabFilesRef.current.filter(f => f.blob);
    const total = ready.reduce((sum, f) => sum + f.blob!.size, 0);
    const ids = new Map<string, string>();
    let done = 0;
    for (const file of ready) {
      setUpload({ sent: done, total });
      const id = await uploadTabFile(file.blob!, sent => setUpload({ sent: done + sent, total }));
      if (id) ids.set(file.url, id);
      done += file.blob!.size;
    }
    setUpload(null);
    return { files: filesFor(tabFilesRef.current, ids, videoFileRef.current) };
  };

  // An Instagram post already saved without its picture: the button's data fills it in at once.
  useEffect(() => {
    if (!existing || !igData || !copiesOn || phase !== "form") return;
    if (existing.thumbnailUrl?.startsWith("/thumb/") && existing.archiveStatus === "saved") return;
    savedId.current = existing.id;
    setPhase("saving");
    void filesForCopy().then(files => {
      saveInstagramCopy(existing.id, { ...igData, ...files });
      return waitForCopy(existing.id);
    }).then(() => syncLibrary()).then(() => setPhase("picture"));
  }, [existing, igData, copiesOn, phase]); // eslint-disable-line react-hooks/exhaustive-deps -- filesForCopy reads refs only

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
      ...(title && title !== post.title ? { title, fieldSources: { ...post.fieldSources,
        title: title === suggested || (igData && title === instagramTitle(igData)) ? "fetched" : "user" } } : {}),
      ...(note ? { userNotes: note } : {}),
      status,
      tags: tagList(tags),
    });
    if (copy && copiesOn) {
      if (instagram && igData) saveInstagramCopy(post.id, { ...igData, ...await filesForCopy() });
      else if (!instagram && post.archiveStatus !== "pending") saveCopy(post.id);
    }
    void enrichSavedPost(post.id);
    let stored = await syncLibrary();
    // The copy's result is part of the link: stored before "Saved", as the window closes by itself right after.
    if (instagram && igData && copy && copiesOn) { await waitForCopy(post.id); stored = await syncLibrary() && stored; }
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
  const shell = (children: React.ReactNode) => <main className="min-h-screen" style={{ background: "var(--bg)" }}>{header}{children}</main>;

  if (!initial.url) return shell(
    <p role="alert" className="flex items-start gap-2 px-5 py-6 text-[.8rem]"><TriangleAlert size={15} className="mt-0.5 text-[var(--amber)]" />
      This page's address can't be saved. Only web pages (http and https) can be added.</p>);

  const hasVideo = tabFiles.some(f => f.kind === "video" && f.blob);
  if (!ready || existingId === null || phase === "saving") return shell(
    <div className="px-5 py-6" role="status">
      <p className="flex items-center gap-2 text-[.8rem] text-[var(--dim)]">
        <LoaderCircle size={15} className="animate-spin text-[var(--accent)]" />
        {!ready ? "Opening your library…" : instagram ? (hasVideo ? "Saving the link, the post's picture and its video…" : "Saving the link and the post's pictures…") : "Saving…"}
      </p>
      {upload && upload.total > 0 && <>
        <div className="mt-3.5 h-1.5 overflow-hidden rounded" style={{ background: "var(--surface2)" }} aria-label="Uploaded">
          <div className="h-full" style={{ width: `${Math.min(100, (100 * upload.sent) / upload.total)}%`, background: "var(--accent)" }} />
        </div>
        <p className="mt-2 text-[.72rem] text-[var(--faint)]">{megabytes(upload.sent)} of {megabytes(upload.total)}</p>
      </>}
    </div>);

  // From the extension: what it kept while the app wasn't running, the posts loaded on a feed, profile or search page,
  // and the page (or post) itself.
  const views = [...(kept ? ["kept" as const] : []), ...(pagePosts ? ["posts" as const] : []), "page" as const];
  const tabs = views.length > 1 && (
    <div className="mt-3 flex flex-wrap gap-1.5 px-5" role="tablist" aria-label="What to save">
      {views.map(id => (
        <button key={id} type="button" role="tab" aria-selected={view === id} className="chip" style={view === id ? CHOSEN : undefined}
          onClick={() => setView(id)}>{id === "kept" ? `Waiting (${kept!.items.length})` : id === "posts" ? `Posts on this page (${pagePosts!.length})`
            : postAddress(initial.url) ? "This post" : "This page"}</button>))}
    </div>);
  if (kept && view === "kept" && phase === "form") return shell(
    <KeptPosts kept={kept} tabs={tabs} copiesOn={copiesOn} autoSave={autoSave} />);
  if (pagePosts && view === "posts" && phase === "form") return shell(
    <PostsOnPage posts={pagePosts} pageUrl={initial.url} tabs={tabs} copiesOn={copiesOn} autoSave={autoSave} />);

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

  if (existing) return shell(<>{tabs}
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
    </div></>);

  return shell(<>{tabs}
    <form className="px-5 pb-5" onSubmit={e => { e.preventDefault(); void save(); }}>
      <div className="mt-3">{label("Address")}
        <div className="input" style={{ opacity: 0.8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={initial.url}>{initial.url}</div>
      </div>
      <div className="mt-3">{label("Title")}<input className="input" aria-label="Title" value={title} onChange={e => setTitle(e.target.value)} /></div>
      {waiting && <p role="status" className="mt-3 flex items-center gap-2 text-[.74rem] text-[var(--dim)]"><LoaderCircle size={13} className="animate-spin" />
        {instagram || postAddress(initial.url) ? " Reading the post…" : " Reading the posts on this page…"}</p>}
      {postData && !instagram && (
        <div className="mt-3 rounded-lg border p-3" style={{ borderColor: "var(--border-hi)" }} aria-label={`The ${SITE_NAMES[postData.site]} post`}>
          <div className="text-[.78rem]"><b>{postData.author || (postData.handle ? "@" + postData.handle : SITE_NAMES[postData.site])}</b>
            {postData.author && postData.handle && <span className="text-[var(--dim)]"> @{postData.handle}</span>}</div>
          {postData.text && <p className="mt-2 line-clamp-3 text-[.76rem]">{postData.text}</p>}
          <p className="mt-2 text-[.72rem] text-[var(--dim)]">
            {postData.video ? "A video. " : postData.pictures.length ? `${postData.pictures.length} picture${postData.pictures.length === 1 ? "" : "s"}. ` : ""}
            {copy && copiesOn ? "The link and a saved copy of the post will be saved." : "The link will be saved."}
          </p>
        </div>)}
      {initial.unpaired && <p role="note" className="mt-3 text-[.74rem] text-[var(--amber)]">
        The extension isn't paired with SuperBookmarks yet, so only the post's address came over. To save its caption and pictures too,
        pair it in Settings → Sources → Save from your browser, then click the button again.</p>}
      {!initial.unpaired && tiktokFeed(initial.url) && <p role="note" className="mt-3 text-[.74rem] text-[var(--dim)]">
        TikTok's For You feed doesn't show each video's own address, so its videos can't be saved from it. Open the creator's profile, or the
        video's own page, and click the button there.</p>}
      {instagram && !waiting && !initial.unpaired && (igData ? (
          <div className="mt-3 rounded-lg border p-3" style={{ borderColor: "var(--border-hi)" }} aria-label="The Instagram post">
            <div className="text-[.78rem]"><b>{igData.author || igData.handle || "Instagram"}</b>
              {igData.handle && <span className="text-[var(--dim)]"> @{igData.handle}</span>}</div>
            {igData.caption && <p className="mt-2 line-clamp-3 text-[.76rem]">{igData.caption}</p>}
            <p className="mt-2 text-[.72rem] text-[var(--dim)]">
              {tabFiles.length ? tabFileNote(igData, tabFiles, videoFile) : <>
                {igData.pictures.length ? `${igData.pictures.length} picture${igData.pictures.length === 1 ? "" : "s"} and the caption will be saved with the link.` : "No pictures were found on the page; the caption will be saved."}
                {igData.video ? videoNote(igData, videoFile) : ""}
              </>}
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
        {instagram ? (tabFiles.some(f => f.kind === "video" && !f.error) ? "Save the pictures, caption and video (a saved copy)" : "Save the pictures and caption (a saved copy)")
          : postData ? "Save a copy of the post" : "Save a copy of the page"}
      </label>}
      {error && <p role="alert" className="mt-3 text-[.74rem] text-[var(--red)]">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="btn" onClick={() => window.close()}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={waiting}>Save</button>
      </div>
    </form></>);
}

/** A video post's video when no file came over from the tab. `videoFile`: whether the page held its file, as the extension
 *  read it (null for the bookmark button, which takes no files). */
function videoNote(post: InstagramData, videoFile: boolean | null): string {
  if (videoFile === false) return " It's a video post, but the page doesn't hold the video's file, so the video isn't kept.";
  if (videoFile) return "";
  return ` It's a video post${post.pictures.length ? ": the cover picture is kept" : ""}. To keep the video too, save it with the SuperBookmarks extension from the open post.`;
}

/** What the card says about the files coming over from the tab for an Instagram post. */
function tabFileNote(post: InstagramData, files: TabFile[], videoFile: boolean | null = null): string {
  const coming = files.filter(f => !f.blob && !f.error);
  if (coming.length) {
    const received = files.reduce((sum, f) => sum + (f.blob ? f.blob.size : f.received), 0);
    const total = files.reduce((sum, f) => sum + (f.blob ? f.blob.size : f.total), 0);
    const what = post.video ? (videoFile === false ? "picture" : "picture and video") : "pictures";
    return `Getting the post's ${what} from your tab… ${total ? `${megabytes(received)} of ${megabytes(total)}` : ""}`.trim();
  }
  const pictures = files.filter(f => f.kind === "picture" && f.blob).length;
  const video = files.find(f => f.kind === "video");
  const parts = [pictures ? (post.video ? "The cover picture" : `${pictures} picture${pictures === 1 ? "" : "s"}`) : "", "the caption",
    video?.blob ? `the video (${megabytes(video.blob.size)})` : ""].filter(Boolean);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0];
  // Pictures the tab couldn't hand over are fetched by the app, as the bookmark button's are: say so.
  const missing = Math.max(0, post.pictures.length - pictures);
  const sentence = `${list.charAt(0).toUpperCase()}${list.slice(1)} will be saved with the link. ` + (missing
    ? `They come from your tab; ${missing === 1 ? "one picture" : `${missing} pictures`} didn't, so SuperBookmarks fetches ${missing === 1 ? "it" : "them"} from Instagram's picture server, as the bookmark button does.`
    : "They come from your tab: SuperBookmarks doesn't contact Instagram.");
  if (video?.error === "too_large") return `${sentence} The video is bigger than 50 MB: its cover picture is kept.`;
  if (video && !video.blob) return `${sentence} The video didn't come through from your tab: its cover picture is kept.`;
  if (post.video && !video && videoFile === false) return `${sentence} The page doesn't hold the video's file, so the video isn't kept.`;
  return sentence;
}

/** "x.com/search?q=sourdough" */
function where(url: string) {
  try { const u = new URL(url); return (u.host.replace(/^www\./, "") + u.pathname + u.search).slice(0, 90); } catch { return url.slice(0, 90); }
}

const SMALL = { padding: "2px 9px", fontSize: ".7rem" };
const BADGE = { padding: "0 6px", fontSize: ".62rem" };

/**
 * "Save the posts on this page": the posts the extension found already loaded in the owner's tab, each with a
 * tick box, none ticked to start with. Save adds the ticked ones as links (with a saved copy each, Instagram's
 * made from what the tab showed); a post already in the library only gets this window's tags.
 */
function PostsOnPage({ posts, pageUrl, tabs, copiesOn, autoSave }:
  { posts: PagePost[]; pageUrl: string; tabs: React.ReactNode; copiesOn: boolean; autoSave: boolean }) {
  const library = useLibrary(s => s.posts);
  const known = useMemo(() => savedByKey(library), [library]);
  const hasInstagram = posts.some(p => p.site === "instagram");
  const [ticked, setTicked] = useState<Set<string>>(() => new Set());
  const [status, setStatus] = useState<SavedPost["status"]>("inbox");
  const [tags, setTags] = useState("");
  const [copy, setCopy] = useState(true);
  useEffect(() => { setCopy(autoSave || hasInstagram); }, [autoSave, hasInstagram]);
  const [phase, setPhase] = useState<"form" | "saving" | "saved">("form");
  const [result, setResult] = useState({ added: 0, updated: 0 });
  const [error, setError] = useState("");
  const count = ticked.size;

  useEffect(() => {
    if (phase !== "saved") return;
    const timer = window.setTimeout(() => window.close(), 2000);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const toggle = (key: string) => setTicked(old => {
    const next = new Set(old);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const save = async () => {
    setError("");
    const store = useLibrary.getState();
    const before = savedByKey(store.posts);
    const wantCopy = copy && copiesOn;
    const newTags = tagList(tags);
    let added = 0;
    let updated = 0;
    const instagramCopies: string[] = [];
    for (const item of posts.filter(p => ticked.has(p.key))) {
      const saved = before.get(item.key) ?? findSavedByUrl(store.posts, item.url);
      if (saved) {
        // Already saved: only this window's tags are added; its status, tags, notes and copy stay as they are.
        const merged = [...new Set([...saved.tags, ...newTags])];
        if (merged.length !== saved.tags.length) store.updatePost(saved.id, { tags: merged });
        updated++;
        continue;
      }
      const post = store.addByUrl(item.url, { copy: wantCopy });
      if (!post) continue;
      const title = item.site === "instagram" ? instagramTitle(item) : "";
      store.updatePost(post.id, { status, tags: newTags, ...(title ? { title, fieldSources: { ...post.fieldSources, title: "fetched" } } : {}) });
      if (wantCopy) {
        const data = item.site === "instagram" ? instagramDataOf(item) : null;
        if (data) { saveInstagramCopy(post.id, data); instagramCopies.push(post.id); }
        else if (item.site !== "instagram" && post.archiveStatus !== "pending") saveCopy(post.id);
      }
      void enrichSavedPost(post.id);
      added++;
    }
    setPhase("saving");
    const stored = await syncLibrary();
    // Instagram copies are made from what this window holds, so it stays open until they are made, and stores the result.
    if (stored && instagramCopies.length) { await waitForCopies(instagramCopies); await syncLibrary(); }
    if (!stored) { setPhase("form"); setError("The posts couldn't be stored. Check that the app is still running, then try again."); return; }
    setResult({ added, updated });
    setPhase("saved");
  };

  if (phase === "saving") return (
    <p role="status" className="flex items-center gap-2 px-5 py-6 text-[.8rem] text-[var(--dim)]">
      <LoaderCircle size={15} className="animate-spin text-[var(--accent)]" /> Saving {count} post{count === 1 ? "" : "s"}…
    </p>);

  if (phase === "saved") return (
    <div className="flex flex-col items-center px-6 py-16 text-center" role="status">
      <Check size={40} className="text-[var(--green)]" aria-hidden="true" />
      <p className="mt-3 text-[1rem] font-semibold">{result.added ? `Saved ${result.added} post${result.added === 1 ? "" : "s"}` : "Already in your library"}</p>
      <p className="mt-1 text-[.76rem] text-[var(--dim)]">
        {result.added ? `In ${STATUSES.find(s => s.id === status)?.label ?? "Inbox"}${copy && copiesOn ? ", with saved copies on the way" : ""}. ` : ""}
        {result.updated ? `${result.updated} ${result.updated === 1 ? "was" : "were"} already saved${tagList(tags).length ? " and got the new tags" : ""}; nothing was added twice. ` : ""}
        This window closes in 2 seconds.
      </p>
      <button className="btn mt-4" onClick={() => { window.open("/library", "_blank", "noopener"); window.close(); }}><ExternalLink size={13} /> Open in the app</button>
    </div>);

  return (<>
    {tabs}
    <form className="px-5 pb-5" onSubmit={e => { e.preventDefault(); if (count) void save(); }}>
      <p className="mt-2 text-[.7rem] text-[var(--faint)]">From {where(pageUrl)} · only the posts already loaded in your tab. Scroll there and click the button again for more.</p>
      <div className="mt-2 flex items-center justify-between text-[.72rem]">
        <span><b>{count} of {posts.length}</b> ticked</span>
        <span className="flex gap-1.5">
          <button type="button" className="btn" style={SMALL} onClick={() => setTicked(new Set(posts.filter(p => !known.has(p.key)).map(p => p.key)))}>Tick all</button>
          <button type="button" className="btn" style={SMALL} onClick={() => setTicked(new Set())}>Untick all</button>
        </span>
      </div>
      <ul className="mt-2 rounded-lg border" aria-label="Posts on this page"
        style={{ borderColor: "var(--border-hi)", background: "var(--surface)", maxHeight: "max(150px, calc(100vh - 390px))", overflowY: "auto" }}>
        {posts.map(p => {
          const saved = known.get(p.key);
          const name = p.author || (p.handle ? "@" + p.handle : SITE_NAMES[p.site]);
          const shelf = saved ? shelfOf(saved) : "";
          return (
            <li key={p.key} style={{ borderBottom: "1px solid var(--border)", opacity: saved ? 0.75 : 1 }}>
              <label className="flex cursor-pointer items-start gap-2.5 px-2.5 py-2">
                <input type="checkbox" className="mt-1" checked={ticked.has(p.key)} onChange={() => toggle(p.key)} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5 overflow-hidden text-[.74rem] whitespace-nowrap">
                    <b className="truncate">{name}</b>
                    <span className="text-[var(--faint)]">{[p.author && p.handle ? "@" + p.handle : "", postAge(p.takenAt)].filter(Boolean).join(" · ")}</span>
                  </span>
                  <span className="block truncate text-[.72rem] text-[var(--dim)]">{firstLine(p.text) || <i>No text</i>}</span>
                  {(p.pictures.length > 0 || p.video || saved) && <span className="mt-1 flex flex-wrap items-center gap-1.5">
                    {p.pictures.length > 0 && !p.video && <span className="chip" style={BADGE}>{p.pictures.length} picture{p.pictures.length === 1 ? "" : "s"}</span>}
                    {p.video && <span className="chip" style={BADGE}>Video</span>}
                    {saved && <span className="text-[.66rem] text-[var(--green)]">✓ Already saved{shelf ? ` · ${shelf}` : ""}</span>}
                  </span>}
                </span>
              </label>
            </li>);
        })}
      </ul>
      <div className="mt-3">{label("Status")}
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Status">
          {STATUSES.map(s => <button type="button" key={s.id} role="radio" aria-checked={status === s.id} className="chip"
            style={status === s.id ? CHOSEN : undefined} onClick={() => setStatus(s.id)}>{s.label}</button>)}
        </div>
      </div>
      <div className="mt-3">{label("Tags")}<input className="input" aria-label="Tags" placeholder="add tags, separated by commas" value={tags} onChange={e => setTags(e.target.value)} /></div>
      {copiesOn && <label className="mt-3 flex items-center gap-2 text-[.78rem]">
        <input type="checkbox" checked={copy} onChange={e => setCopy(e.target.checked)} /> Save a copy of each post
      </label>}
      {error && <p role="alert" className="mt-3 text-[.74rem] text-[var(--red)]">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn" onClick={() => window.close()}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={!count}>{count ? `Save ${count} post${count === 1 ? "" : "s"}` : "Save"}</button>
      </div>
    </form>
  </>);
}

/** "kept 2h ago", "kept 20 Oct" */
function keptWhen(iso: string) {
  const age = postAge(iso);
  return !age ? "kept" : /^\d/.test(age) ? `kept ${age} ago` : `kept ${age}`;
}

/**
 * "Waiting (N)": what the extension kept while SuperBookmarks wasn't running, all ticked (the owner chose each
 * one then). Save keeps the ticked ones and lets the unticked go; "Later" leaves them all waiting; "Discard all".
 * A kept Instagram post's files come from the extension's storage when Save is clicked.
 */
function KeptPosts({ kept, tabs, copiesOn, autoSave }:
  { kept: { items: KeptItem[]; notices: KeptNotice[]; rejected: string[] }; tabs: React.ReactNode; copiesOn: boolean; autoSave: boolean }) {
  const library = useLibrary(s => s.posts);
  const known = useMemo(() => savedByKey(library), [library]);
  const hasInstagram = kept.items.some(i => i.post?.site === "instagram");
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(kept.items.map(i => i.id)));
  const [status, setStatus] = useState<SavedPost["status"]>("inbox");
  const [tags, setTags] = useState("");
  const [copy, setCopy] = useState(true);
  useEffect(() => { setCopy(autoSave || hasInstagram); }, [autoSave, hasInstagram]);
  const [phase, setPhase] = useState<"form" | "saving" | "saved" | "discarded">("form");
  const [result, setResult] = useState({ added: 0, updated: 0, failed: 0 });
  const [upload, setUpload] = useState<{ sent: number; total: number } | null>(null);
  const [error, setError] = useState("");
  const files = useRef(new Map<string, TabFile[]>());
  const count = ticked.size;

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const read = readMediaMessage(event.data);
      if (!read || !kept.items.some(i => i.url === read.post)) return;
      files.current.set(read.post, [...(files.current.get(read.post) ?? []).filter(f => f.url !== read.file.url), read.file]);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [kept]);

  useEffect(() => {
    if ((phase !== "saved" && phase !== "discarded") || result.failed) return;
    const timer = window.setTimeout(() => window.close(), 2000);
    return () => window.clearTimeout(timer);
  }, [phase, result.failed]);

  /** These leave the extension (saved, let go, or unusable); anything else stays waiting there. */
  const done = (ids: string[]) => window.postMessage({ type: "sbm-queue-done", ids: [...ids, ...kept.rejected] }, window.location.origin);

  /** A kept Instagram post's files, once they have all come (at most 2 minutes), uploaded. */
  const filesForCopy = async (item: KeptItem) => {
    const expected = item.files.filter(f => !f.dropped).length;
    const end = Date.now() + 120000;
    const settled = () => (files.current.get(item.url) ?? []).filter(f => f.blob || f.error).length >= expected;
    while (Date.now() < end && !settled()) await new Promise(r => setTimeout(r, 200));
    const list = files.current.get(item.url) ?? [];
    const ready = list.filter(f => f.blob);
    const total = ready.reduce((sum, f) => sum + f.blob!.size, 0);
    const ids = new Map<string, string>();
    let sent = 0;
    for (const file of ready) {
      const id = await uploadTabFile(file.blob!, now => setUpload({ sent: sent + now, total }));
      if (id) ids.set(file.url, id);
      sent += file.blob!.size;
    }
    setUpload(null);
    return { files: filesFor(list, ids), complete: ids.size >= expected };
  };

  const save = async () => {
    setError("");
    setPhase("saving");
    const store = useLibrary.getState();
    const before = savedByKey(store.posts);
    const wantCopy = copy && copiesOn;
    const newTags = tagList(tags);
    const chosen = kept.items.filter(i => ticked.has(i.id));
    const withFiles = chosen.filter(i => i.post?.site === "instagram" && i.files.some(f => !f.dropped));
    if (wantCopy && withFiles.length) window.postMessage({ type: "sbm-want-media", posts: withFiles.map(i => i.url) }, window.location.origin);
    let added = 0;
    let updated = 0;
    const instagramCopies: string[] = [];
    const failed = new Set<string>();
    for (const item of chosen) {
      const key = item.post?.key ?? postAddress(item.url)?.key;
      const saved = (key ? before.get(key) : undefined) ?? findSavedByUrl(store.posts, item.url);
      if (saved) {
        const merged = [...new Set([...saved.tags, ...newTags])];
        if (merged.length !== saved.tags.length) store.updatePost(saved.id, { tags: merged });
        updated++;
        continue;
      }
      // A kept Instagram post's files go to the app first: one that didn't get there isn't saved (it would lose its
      // video) and stays waiting in the extension.
      const data = wantCopy && item.post?.site === "instagram" ? instagramDataOf(item.post) : null;
      const uploaded = data ? await filesForCopy(item) : null;
      if (uploaded && !uploaded.complete) { failed.add(item.id); continue; }
      const post = store.addByUrl(item.url, { copy: wantCopy });
      if (!post) continue;
      const title = item.post ? (item.post.site === "instagram" ? instagramTitle(item.post) : "") : item.title;
      store.updatePost(post.id, { status, tags: newTags, ...(title ? { title, fieldSources: { ...post.fieldSources, title: "fetched" } } : {}) });
      if (data && uploaded) { saveInstagramCopy(post.id, { ...data, files: uploaded.files }); instagramCopies.push(post.id); }
      else if (wantCopy && item.post?.site !== "instagram" && post.archiveStatus !== "pending") saveCopy(post.id);
      void enrichSavedPost(post.id);
      added++;
    }
    const stored = await syncLibrary();
    if (stored && instagramCopies.length) { await waitForCopies(instagramCopies); await syncLibrary(); }
    if (!stored) { setPhase("form"); setError("The posts couldn't be stored. Check that the app is still running, then try again."); return; }
    // Saved, and the unticked let go; one whose files didn't reach the app stays waiting.
    done(kept.items.map(i => i.id).filter(id => !failed.has(id)));
    setResult({ added, updated, failed: failed.size });
    setPhase("saved");
  };

  if (phase === "saving") return (
    <div className="px-5 py-6" role="status">
      <p className="flex items-center gap-2 text-[.8rem] text-[var(--dim)]"><LoaderCircle size={15} className="animate-spin text-[var(--accent)]" />
        Saving {count} kept {count === 1 ? "one" : "ones"}…</p>
      {upload && upload.total > 0 && <>
        <div className="mt-3.5 h-1.5 overflow-hidden rounded" style={{ background: "var(--surface2)" }} aria-label="Uploaded">
          <div className="h-full" style={{ width: `${Math.min(100, (100 * upload.sent) / upload.total)}%`, background: "var(--accent)" }} />
        </div>
        <p className="mt-2 text-[.72rem] text-[var(--faint)]">{megabytes(upload.sent)} of {megabytes(upload.total)}</p>
      </>}
    </div>);

  if (phase === "saved" || phase === "discarded") return (
    <div className="flex flex-col items-center px-6 py-16 text-center" role="status">
      <Check size={40} className="text-[var(--green)]" aria-hidden="true" />
      <p className="mt-3 text-[1rem] font-semibold">{phase === "discarded" ? "Let go" : result.added ? `Saved ${result.added} kept ${result.added === 1 ? "one" : "ones"}` : "Already in your library"}</p>
      <p className="mt-1 text-[.76rem] text-[var(--dim)]">
        {phase === "discarded" ? "Nothing waits in the extension any more. " : ""}
        {phase === "saved" && result.updated ? `${result.updated} ${result.updated === 1 ? "was" : "were"} already saved; nothing was added twice. ` : ""}
        {phase === "saved" && result.failed ? `${result.failed} couldn't be saved: ${result.failed === 1 ? "its pictures or video" : "their pictures or videos"} didn't reach the app. ${result.failed === 1 ? "It stays" : "They stay"} waiting in the extension; try again in a moment. ` : ""}
        {result.failed ? "" : "This window closes in 2 seconds."}
      </p>
    </div>);

  return (<>
    {tabs}
    <form className="px-5 pb-5" onSubmit={e => { e.preventDefault(); if (count) void save(); }}>
      <p className="mt-2 text-[.72rem] text-[var(--dim)]">Kept by the extension while SuperBookmarks wasn't running. Untick what you no longer want.</p>
      {kept.notices.length > 0 && <div className="mt-2 rounded-lg border p-2.5 text-[.7rem]" role="note"
        style={{ borderColor: "var(--amber)", color: "var(--amber)", background: "var(--surface)" }}>
        {kept.notices.map((n, i) => <p key={i}>To stay under 200 MB, the {n.kind} of {n.name} ({keptWhen(n.keptAt)}) was left out. The post, its link and the rest are kept.</p>)}
      </div>}
      <ul className="mt-2 rounded-lg border" aria-label="Kept while SuperBookmarks wasn't running"
        style={{ borderColor: "var(--border-hi)", background: "var(--surface)", maxHeight: "max(150px, calc(100vh - 400px))", overflowY: "auto" }}>
        {kept.items.map(item => {
          const post = item.post;
          const name = post ? post.author || (post.handle ? "@" + post.handle : SITE_NAMES[post.site]) : item.title || item.url;
          const where = post ? SITE_NAMES[post.site] : (() => { try { return new URL(item.url).hostname.replace(/^www\./, ""); } catch { return ""; } })();
          const video = item.files.find(f => f.kind === "video");
          const key = post?.key ?? postAddress(item.url)?.key;
          const saved = key ? known.get(key) : undefined;
          return (
            <li key={item.id} style={{ borderBottom: "1px solid var(--border)" }}>
              <label className="flex cursor-pointer items-start gap-2.5 px-2.5 py-2">
                <input type="checkbox" className="mt-1" checked={ticked.has(item.id)} onChange={() => setTicked(old => {
                  const next = new Set(old);
                  if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
                  return next;
                })} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5 overflow-hidden text-[.74rem] whitespace-nowrap">
                    <b className="truncate">{name}</b>
                    <span className="text-[var(--faint)]">{[post?.author && post.handle ? "@" + post.handle : "", where, keptWhen(item.keptAt)].filter(Boolean).join(" · ")}</span>
                  </span>
                  <span className="block truncate text-[.72rem] text-[var(--dim)]">{post ? firstLine(post.text) || <i>No text</i> : item.url}</span>
                  {(post?.pictures.length || video || saved) && <span className="mt-1 flex flex-wrap items-center gap-1.5">
                    {video && !video.dropped && <span className="chip" style={BADGE}>Video · {megabytes(video.size)}</span>}
                    {video?.dropped && <span className="chip" style={BADGE}>Cover picture only (the video was left out)</span>}
                    {!video && post && post.pictures.length > 0 && <span className="chip" style={BADGE}>{post.pictures.length} picture{post.pictures.length === 1 ? "" : "s"}</span>}
                    {saved && <span className="text-[.66rem] text-[var(--green)]">✓ Already saved{shelfOf(saved) ? ` · ${shelfOf(saved)}` : ""}</span>}
                  </span>}
                </span>
              </label>
            </li>);
        })}
      </ul>
      <div className="mt-3">{label("Status")}
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Status">
          {STATUSES.map(s => <button type="button" key={s.id} role="radio" aria-checked={status === s.id} className="chip"
            style={status === s.id ? CHOSEN : undefined} onClick={() => setStatus(s.id)}>{s.label}</button>)}
        </div>
      </div>
      <div className="mt-3">{label("Tags")}<input className="input" aria-label="Tags" placeholder="add tags, separated by commas" value={tags} onChange={e => setTags(e.target.value)} /></div>
      {copiesOn && <label className="mt-3 flex items-center gap-2 text-[.78rem]">
        <input type="checkbox" checked={copy} onChange={e => setCopy(e.target.checked)} /> Save a copy of each
      </label>}
      {error && <p role="alert" className="mt-3 text-[.74rem] text-[var(--red)]">{error}</p>}
      <div className="mt-4 flex flex-wrap justify-between gap-2">
        <button type="button" className="btn btn-ghost" onClick={() => { done(kept.items.map(i => i.id)); setPhase("discarded"); }}>Discard all {kept.items.length}</button>
        <span className="flex gap-2">
          <button type="button" className="btn" onClick={() => window.close()}>Later</button>
          <button type="submit" className="btn btn-primary" disabled={!count}>Save {count}</button>
        </span>
      </div>
    </form>
  </>);
}

/** Until none of these links' copies is still being asked for (20 s and 5 s a link, at most 2 minutes). */
async function waitForCopies(ids: string[]) {
  const end = Date.now() + Math.min(120000, 20000 + 5000 * ids.length);
  while (Date.now() < end) {
    const posts = useLibrary.getState().posts;
    if (!ids.some(id => posts.find(p => p.id === id)?.archiveStatus === "pending")) return;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
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
