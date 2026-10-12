import { useEffect, useRef, useState } from "react";
import { ExternalLink, FileCheck, X } from "lucide-react";
import type { SavedPost } from "../../types";
import { copyUrl, formatBytes, formatCopyDate } from "../../lib/savedCopies";

/**
 * Reads a saved copy beside the link panel (the whole screen on a phone).
 *
 * The copy is shown in a sandboxed frame: no scripts, an origin of its own,
 * and the server's policy lets it load nothing. `allow-popups` only lets a
 * link the reader clicks open the live site in a normal tab.
 */
export default function CopyReader({ post, onClose }: { post: SavedPost; onClose: () => void }) {
  const [plain, setPlain] = useState(false);
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    close.current?.focus({ preventScroll: true });
    // Escape closes the copy first; the link panel's own handler then sees it handled.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const details = [
    post.archivedAt ? `saved ${formatCopyDate(post.archivedAt)}` : "",
    post.domain ? `from ${post.domain}` : "",
  ].filter(Boolean).join(" ");
  const meta = [details, formatBytes(post.archiveBytes), "opens without the internet"].filter(Boolean).join(" · ");

  return (
    <section className="copy-reader" aria-label="Saved copy reader">
      <div className="copy-reader__bar">
        <FileCheck size={15} className="shrink-0 text-[var(--green)]" aria-hidden="true" />
        <h3 className="shrink-0 text-[.82rem] font-semibold">Saved copy</h3>
        <span className="copy-reader__meta" title={meta}>{meta}</span>
        <span className="flex-1" />
        <div className="flex shrink-0 gap-1" role="group" aria-label="How the copy is shown">
          <button className={`seg ${plain ? "" : "is-active"}`} aria-pressed={!plain} onClick={() => setPlain(false)}
            title="The page with its own styling, as it was saved">As saved</button>
          <button className={`seg ${plain ? "is-active" : ""}`} aria-pressed={plain} onClick={() => setPlain(true)}
            title="Text and pictures only, for pages that hide their content or sit under a banner">Text only</button>
        </div>
        <a className="btn copy-reader__newtab shrink-0" href={copyUrl(post, { plain })} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={13} /> <span>Open in new tab</span>
        </a>
        <button ref={close} className="icon-btn shrink-0" aria-label="Close saved copy" title="Close" onClick={onClose}><X size={15} /></button>
      </div>
      <iframe key={plain ? "plain" : "saved"} className="copy-reader__frame" title={`Saved copy of ${post.title || post.url}`}
        sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer"
        src={copyUrl(post, { plain, banner: false })} />
    </section>
  );
}
