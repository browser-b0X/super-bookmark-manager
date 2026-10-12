import { useState } from "react";
import { Check, Download, RefreshCw, Trash2 } from "lucide-react";
import { changeVideoHelper, helperProblem, useVideoHelper } from "../../lib/videoHelper";
import { formatCopyDate } from "../../lib/savedCopies";

/** Inside Settings → Saved copies: what each social site keeps, and the optional video helper (TikTok, Reddit). */
export default function SocialPostsSettings() {
  const helper = useVideoHelper();
  const [note, setNote] = useState("");
  const act = async (action: "install" | "check" | "update" | "remove") => {
    setNote("");
    if (!(await changeVideoHelper(action))) setNote("The app didn't accept that. Check that it is still running, then try again.");
  };

  return (
    <div id="social-posts" className="mt-4 border-t pt-4" style={{ borderColor: "var(--border)" }}>
      <h4 className="text-[.82rem] font-semibold">Social posts</h4>
      <p className="mt-1 text-[.74rem] text-[var(--dim)]">What a saved copy keeps from each site. No logins are used or stored.</p>
      <table className="social-kept mt-2 w-full text-[.74rem]" aria-label="What social posts keep">
        <thead><tr><th scope="col">Site</th><th scope="col">Text and pictures</th><th scope="col">Video</th></tr></thead>
        <tbody>
          <tr><th scope="row">X</th><td>Text, photos</td><td><span className="kept-yes">Saved</span> up to 50 MB</td></tr>
          <tr><th scope="row">TikTok</th><td>Caption, author, cover</td><td>{helper?.installed ? <span className="kept-yes">Saved with the helper</span> : <span className="kept-opt">With the video helper below</span>}</td></tr>
          <tr><th scope="row">Reddit</th><td>Title, text, picture, link</td><td>{helper?.installed ? <span className="kept-yes">Saved with the helper</span> : <span className="kept-opt">With the video helper below</span>}</td></tr>
          <tr><th scope="row">Instagram</th><td>Caption, author, up to 10 pictures, from the post open in your browser (bookmark button)</td>
            <td><span className="kept-no">Cover picture only</span> — the video needs the browser extension (v0.4.0)</td></tr>
        </tbody>
      </table>
      {helper?.busy ? (
        <div role="status" aria-label="Video helper download" className="mt-3 flex items-center gap-2 text-[.7rem] text-[var(--dim)]">
          <div className="h-1 flex-1 overflow-hidden rounded-full" style={{ background: "var(--surface2)" }}>
            <div className="progress-indeterminate h-full rounded-full" style={{ background: "var(--accent)" }} />
          </div>
          <span className="shrink-0">{helper.action === "update" ? "Updating the video helper…" : helper.action === "check" ? "Checking for a newer video helper…" : "Downloading the video helper…"}</span>
        </div>
      ) : helper?.installed ? (
        <>
          <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[.74rem]">
            <Check size={12} style={{ color: "var(--green)" }} aria-hidden="true" />
            Video helper yt-dlp {helper.version ?? ""}{helper.checksum ? " · checksum checked" : ""} · TikTok and Reddit posts keep their video
          </p>
          <p className="mt-2 text-[.72rem] text-[var(--dim)]">
            {helper.checkedAt ? `Last checked for updates ${formatCopyDate(helper.checkedAt)}. ` : ""}
            TikTok changes often, so once a week the app looks for a newer version and tells you here. Nothing is updated until you choose Update.
          </p>
          {helper.updateAvailable && <p role="status" aria-label="Video helper update" className="mt-2 rounded-lg border p-2.5 text-[.74rem]"
            style={{ borderColor: "var(--accent)", background: "var(--accent-bg)" }}>
            A newer video helper is available. It is downloaded, checked against its checksum and used only after you choose <b>Update the helper</b>.
          </p>}
          <div className="mt-2.5 flex flex-wrap gap-2">
            {helper.updateAvailable && <button className="btn btn-primary" onClick={() => void act("update")}><Download size={13} /> Update the helper</button>}
            <button className="btn" onClick={() => void act("check")}><RefreshCw size={13} /> Check for updates</button>
            <button className="btn btn-ghost" onClick={() => void act("remove")} title="TikTok and Reddit posts are then saved without their video">
              <Trash2 size={13} /> Remove the helper
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-2 text-[.74rem] text-[var(--dim)]">
            To keep the <b className="text-[var(--text)]">video</b> of TikTok and Reddit posts too, the app needs the free video helper <b className="text-[var(--text)]">yt-dlp</b>. It isn't part of the app because its Windows
            program carries a GPL licence. The app downloads it from yt-dlp's official GitHub release, checks it against the release's
            SHA-256 list, keeps it in the app's data folder and runs it only when a TikTok or Reddit video post is saved.
          </p>
          {helper && <div className="mt-2.5 flex flex-wrap gap-2">
            <button className="btn" onClick={() => void act("install")}><Download size={13} /> Get the video helper</button>
          </div>}
        </>
      )}
      {helper?.error && !helper.busy && <p role="note" className="mt-2 text-[.74rem] text-[var(--amber)]">
        {helper.action === "update" && helper.installed ? "The update didn't work. " : helper.action === "check" ? "The check didn't work. " : ""}{helperProblem(helper.error)}
        {(helper.action === "update" || helper.action === "check") && helper.installed ? " The helper you have keeps working." : ""}
      </p>}
      {note && <p role="status" className="mt-2 text-[.74rem] text-[var(--amber)]">{note}</p>}
    </div>
  );
}
