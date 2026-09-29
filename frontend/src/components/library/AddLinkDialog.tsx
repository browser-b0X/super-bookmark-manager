import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Link2, X } from "lucide-react";
import { useLibrary } from "../../store/library";
import { enrichSavedPost } from "../../lib/metadataEnrichment";

export default function AddLinkDialog({ onClose }: { onClose: () => void }) {
  const addByUrl = useLibrary(s => s.addByUrl);
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError("");
    const post = addByUrl(url.trim());
    if (!post) {
      setError("That doesn't look like a valid URL.");
      return;
    }
    onClose();
    setBusy(true);
    void enrichSavedPost(post.id).finally(() => setBusy(false));
    navigate(`/library/item/${post.id}`);
  };

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal mt-[16vh] w-[min(480px,92vw)] p-5" role="dialog" aria-label="Add link">
        <div className="mb-3 flex items-center">
          <h3 className="text-[.95rem] font-semibold"><Link2 size={15} className="mr-2 inline text-[var(--accent)]" />Add a link</h3>
          <button className="icon-btn ml-auto" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>
        <input
          className="input"
          placeholder="https://…"
          value={url}
          autoFocus
          onChange={e => setUrl(e.target.value)}
          onKeyDown={e => e.key === "Enter" && submit()}
        />
        {error && <p className="mt-2 text-[.74rem] text-[var(--red)]">{error}</p>}
        <p className="mt-2 text-[.7rem] text-[var(--faint)]">
          Saved to Inbox. Metadata enrichment runs in the background and never blocks.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? "Saving…" : "Save link"}</button>
        </div>
      </div>
    </div>
  );
}
