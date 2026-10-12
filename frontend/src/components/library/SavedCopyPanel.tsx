import { type ReactNode, useEffect, useState } from "react";
import { BookOpen, FileCheck, ImagePlus, LoaderCircle, RefreshCw, Settings, Trash2, TriangleAlert } from "lucide-react";
import { isInstagramPost } from "../../lib/instagram";
import { useNavigate } from "react-router-dom";
import { useVideoHelper } from "../../lib/videoHelper";
import type { SavedPost } from "../../types";
import { useCopyAvailability } from "../../lib/copyAvailability";
import TelegramMedia from "./TelegramMedia";
import { copyProblem, deleteCopy, FINAL_COPY_ERRORS as FINAL, formatBytes, formatCopyDate, saveCopy } from "../../lib/savedCopies";

/**
 * The saved copy of one link, inside the link panel: what there is, and the
 * three things to do with it. All behaviour lives in lib/savedCopies; this
 * component only shows the link's `archive*` fields.
 */
export default function SavedCopyPanel({ post, onRead }: { post: SavedPost; onRead: () => void }) {
  const enabled = useCopyAvailability(s => s.enabled);
  // Photos and videos from the link's Telegram message sit inside the copy's panel, or on their own without one.
  const inCopy = enabled && post.archiveStatus === "saved" && !!post.archiveKey;
  return (
    <>
      <CopyStatus post={post} onRead={onRead} enabled={enabled} telegram={inCopy ? <TelegramMedia key={post.id} post={post} inCopy /> : null} />
      {!inCopy && <TelegramMedia key={post.id} post={post} />}
    </>
  );
}

function CopyStatus({ post, onRead, enabled, telegram }: { post: SavedPost; onRead: () => void; enabled: boolean; telegram: ReactNode }) {
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => { setConfirming(false); setNote(""); }, [post.id, post.archiveStatus]);
  if (enabled && isInstagramPost(post.url) && post.archiveStatus !== "saved" && post.archiveStatus !== "pending") {
    // Instagram posts are saved from the owner's own tab, through the bookmark button.
    const picture = post.thumbnailUrl?.startsWith("/thumb/");
    return (
      <section className="panel mt-3 p-3" aria-label="Saved copy">
        <p className="flex items-center gap-2 text-[.8rem] font-semibold">
          <ImagePlus size={15} className="text-[var(--amber)]" aria-hidden="true" /> {picture ? "No saved copy yet" : "No picture yet"}
        </p>
        <p className="mt-1.5 text-[.74rem] text-[var(--dim)]">
          Instagram shows this post only to signed-in visitors. Open it in your browser and click your Save to SuperBookmarks
          button: its {picture ? "" : "picture, "}caption and a saved copy are added here.
        </p>
        <div className="mt-2.5">
          <button className="btn" onClick={() => window.open(post.url, "_blank", "noopener")}>
            <ImagePlus size={13} /> {picture ? "Open the post on Instagram" : "Get picture from Instagram"}
          </button>
        </div>
      </section>
    );
  }
  if (!enabled || !post.archiveStatus) return null;

  const hasCopy = !!post.archiveKey;
  const details = [formatCopyDate(post.archivedAt), formatBytes(post.archiveBytes)].filter(Boolean).join(" · ");
  const gone = post.linkStatus === "gone";

  if (post.archiveStatus === "pending") {
    return (
      <section className="panel mt-3 p-3" aria-label="Saved copy" aria-busy="true">
        <p role="status" className="flex items-center gap-2 text-[.8rem] font-semibold">
          <LoaderCircle size={14} className="animate-spin text-[var(--accent)]" aria-hidden="true" />
          {hasCopy ? "Updating the copy…" : "Saving a copy…"}
        </p>
        <p className="mt-1 text-[.72rem] text-[var(--dim)]">Fetching the page and its pictures. You can close this panel.</p>
      </section>
    );
  }

  if (post.archiveStatus !== "saved" || !hasCopy) {
    const code = post.archiveStatus === "too_large" ? "too_large" : post.archiveError;
    return (
      <section className="panel mt-3 p-3" aria-label="Saved copy">
        <p className="flex items-center gap-2 text-[.8rem] font-semibold">
          <TriangleAlert size={15} className="text-[var(--amber)]" aria-hidden="true" /> No copy saved
        </p>
        <p className="mt-1.5 text-[.74rem] text-[var(--dim)]">{copyProblem(code)} The link itself is unchanged.</p>
        {!FINAL.has(code ?? "") && <div className="mt-2.5 flex flex-wrap gap-2">
          <button className="btn" onClick={() => saveCopy(post.id)}><RefreshCw size={13} /> Try again</button>
        </div>}
      </section>
    );
  }

  const remove = async () => {
    const done = await deleteCopy(post.id);
    if (!done) { setConfirming(false); setNote("The copy couldn't be deleted. Check that the app is still running, then try again."); }
  };

  return (
    <section className="panel mt-3 p-3" aria-label="Saved copy" style={gone ? { borderColor: "var(--accent)" } : undefined}>
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="inline-flex items-center gap-2 text-[.8rem] font-semibold">
          {post.archiveNoVideo
            ? <TriangleAlert size={15} className="self-center text-[var(--amber)]" aria-hidden="true" />
            : <FileCheck size={15} className="self-center" style={{ color: post.archiveLimited ? "var(--amber)" : "var(--green)" }} aria-hidden="true" />}
          {post.archiveNoVideo ? "Saved copy, without the video" : post.archiveLimited ? "Saved copy, limited" : "Saved copy"}
        </span>
        {details && <span className="text-[.72rem] text-[var(--dim)]">{details}</span>}
      </p>
      {post.archiveLimited && <p className="mt-1.5 text-[.74rem] text-[var(--dim)]">
        This page builds itself with scripts, so the copy holds little more than its title. The link and its preview are kept as before.
      </p>}
      {post.archiveNoVideo && <p className="mt-1.5 text-[.74rem] text-[var(--dim)]">
        The caption and cover picture are saved. To keep the video too, get the video helper, then choose Update.
      </p>}
      {gone && <p className="mt-1.5 text-[.74rem] text-[var(--dim)]">
        Your copy{post.archivedAt ? ` from ${formatCopyDate(post.archivedAt)}` : ""} still opens.
      </p>}
      {post.archiveError && <p role="note" className="mt-1.5 text-[.74rem] text-[var(--amber)]">
        The update didn't work. {copyProblem(post.archiveError)} Your earlier copy is kept.
      </p>}
      <div className="mt-2.5 flex flex-wrap gap-2">
        <button className={gone ? "btn btn-primary" : "btn"} onClick={onRead}><BookOpen size={13} /> Read saved copy</button>
        {post.archiveNoVideo && <GetHelperButton onOpen={() => navigate("/library/settings#social-posts")} />}
        {!gone && <button className="btn" onClick={() => saveCopy(post.id, { refresh: true })} title="Fetch the page again and replace this copy">
          <RefreshCw size={13} /> Update
        </button>}
        {confirming ? (
          <>
            <button className="btn btn-danger" onClick={() => void remove()}>Confirm delete</button>
            <button className="btn" onClick={() => setConfirming(false)}>Cancel</button>
          </>
        ) : (
          <button className="btn btn-ghost" onClick={() => setConfirming(true)} title="Delete the copy; the link stays"><Trash2 size={13} /> Delete copy</button>
        )}
      </div>
      {note && <p role="status" className="mt-2 text-[.74rem] text-[var(--amber)]">{note}</p>}
      {telegram}
    </section>
  );
}

/** Shown on a post saved without its video, until the helper is there (then Update is enough). */
function GetHelperButton({ onOpen }: { onOpen: () => void }) {
  const helper = useVideoHelper();
  if (!helper || helper.installed) return null;
  return <button className="btn" onClick={onOpen}><Settings size={13} /> Get the video helper</button>;
}
