import { useEffect, useRef, useState } from "react";
import { Download, LoaderCircle, Share2, X } from "lucide-react";
import type { SavedPost } from "../../types";
import { downloadSharePage } from "../../lib/shareExport";
import { fileName } from "../../lib/sharePage";
import { formatBytes } from "../../lib/savedCopies";
import { useDialog } from "../../lib/useDialog";

/** "Share … as a page": what goes in, then one HTML file downloaded. Nothing is uploaded. */
export default function ShareDialog({ name, posts, onClose }: { name: string; posts: SavedPost[]; onClose: () => void }) {
  const [title, setTitle] = useState(name);
  const [intro, setIntro] = useState("");
  const [noPictures, setNoPictures] = useState(false);
  const [include, setInclude] = useState({ notes: false, status: false, favorites: false, telegram: false });
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  // Escape waits while the page is being made, as the Close button does.
  useDialog(dialog, () => { if (!progress) onClose(); });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const date = new Date();
  const withPictures = posts.filter(p => p.thumbnailUrl).length;

  const start = async () => {
    setError(""); setResult("");
    abort.current = new AbortController();
    try {
      const done = await downloadSharePage(posts, { title: title.trim() || name, intro, date, include, pictures: !noPictures },
        (d, t) => setProgress({ done: d, total: t }), abort.current.signal);
      setResult(`Downloaded ${done.name} (${formatBytes(done.bytes) || "1 KB"}). Send it or put it online however you like.`);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError("The page couldn't be made. Try again, or leave out pictures.");
    } finally {
      setProgress(null);
    }
  };

  const box = (key: keyof typeof include, label: string) => (
    <label className="flex items-start gap-2 text-[.78rem]">
      <input type="checkbox" checked={include[key]} onChange={e => setInclude(v => ({ ...v, [key]: e.target.checked }))} style={{ marginTop: 3 }} /> {label}
    </label>
  );
  const label = (text: string) => <div className="mb-1 text-[.66rem] font-semibold tracking-[.8px] text-[var(--faint)] uppercase">{text}</div>;

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget && !progress) onClose(); }}>
      <div ref={dialog} tabIndex={-1} className="modal p-5 outline-none" style={{ marginTop: "8vh", width: "min(560px, 92vw)" }} role="dialog" aria-modal="true" aria-label="Share as a page">
        <div className="flex items-center">
          <h3 className="flex items-center gap-2 text-[.95rem] font-semibold"><Share2 size={15} className="text-[var(--accent)]" /> Share “{name}” as a page</h3>
          <button className="icon-btn ml-auto" onClick={onClose} aria-label="Close" disabled={!!progress}><X size={15} /></button>
        </div>
        <p className="mt-1.5 text-[.76rem] text-[var(--dim)]">Makes one HTML file you can send or put online yourself. It opens in any browser, works offline and sends nothing anywhere. Nothing is uploaded by the app.</p>
        <div className="mt-3">{label("Title")}<input className="input" aria-label="Page title" value={title} onChange={e => setTitle(e.target.value)} /></div>
        <div className="mt-3">{label("Intro line (optional)")}<input className="input" aria-label="Intro line" placeholder="A sentence at the top of the page" value={intro} onChange={e => setIntro(e.target.value)} /></div>
        <div className="mt-4 rounded-lg border p-3" style={{ borderColor: "var(--border-hi)" }}>
          <div className="text-[.78rem] font-semibold">What goes in: {posts.length} link{posts.length === 1 ? "" : "s"}</div>
          <p className="mt-1 text-[.74rem] text-[var(--dim)]">For each: title, site, description, tags, the link{withPictures ? ", and its picture (shrunk to 480 px)" : ""}.</p>
          {withPictures > 0 && <label className="mt-3 flex items-start gap-2 text-[.78rem]">
            <input type="checkbox" checked={noPictures} onChange={e => setNoPictures(e.target.checked)} style={{ marginTop: 3 }} />
            <span>Leave out pictures<span className="block text-[.7rem] text-[var(--dim)]">Makes the file much smaller. With pictures, the app fetches each link's preview picture once.</span></span>
          </label>}
          <div className="mt-3 text-[.72rem] font-semibold text-[var(--dim)]">Left out unless you tick them</div>
          <div className="mt-1.5 grid gap-2" style={{ gridTemplateColumns: "1fr 1fr" }}>
            {box("notes", "Your notes")}{box("status", "Reading status")}{box("favorites", "Favourites")}{box("telegram", "Telegram message text")}
          </div>
          <p className="mt-3 text-[.7rem] text-[var(--faint)]">Saved copies are never included: a shared page links to the original pages.</p>
        </div>
        {progress && <p role="status" className="mt-3 flex items-center gap-2 text-[.74rem] text-[var(--dim)]">
          <LoaderCircle size={13} className="animate-spin" /> {progress.total ? `Preparing pictures · ${progress.done} of ${progress.total}` : "Making the page…"}
        </p>}
        {result && <p role="status" className="mt-3 text-[.74rem] text-[var(--green)]">{result}</p>}
        {error && <p role="alert" className="mt-3 text-[.74rem] text-[var(--red)]">{error}</p>}
        <div className="mt-5 flex items-center justify-end gap-2">
          <span className="mr-auto truncate text-[.72rem] text-[var(--dim)]">{fileName(title.trim() || name, date)}</span>
          {progress ? <button className="btn" onClick={() => abort.current?.abort()}>Cancel</button>
            : <button className="btn" onClick={onClose}>{result ? "Close" : "Cancel"}</button>}
          <button className="btn btn-primary" onClick={() => void start()} disabled={!!progress || posts.length === 0}><Download size={13} /> Download the page</button>
        </div>
      </div>
    </div>
  );
}
