import { useEffect } from "react";
import { Check, TriangleAlert, X } from "lucide-react";
import { useNotice } from "../lib/telegramRefresh";

const SHOW_MS = 9000;

/** A short message above the save status (e.g. what the Telegram check at start found), then it fades. */
export default function NoticeToast() {
  const { text, tone, id, clear } = useNotice();
  useEffect(() => {
    if (!text) return;
    const timer = setTimeout(clear, SHOW_MS);
    return () => clearTimeout(timer);
  }, [text, id, clear]);
  return (
    <div role="status" aria-label="Notice" className={"notice-toast" + (text ? " is-visible" : "") + (tone === "warn" ? " is-warning" : "")}>
      {text && <>
        {tone === "warn" ? <TriangleAlert size={13} className="shrink-0 text-[var(--amber)]" aria-hidden="true" />
          : <Check size={13} className="shrink-0 text-[var(--green)]" aria-hidden="true" />}
        <span className="notice-toast__text">{text}</span>
        <button type="button" className="notice-toast__close" aria-label="Dismiss" onClick={clear}><X size={12} aria-hidden="true" /></button>
      </>}
    </div>
  );
}
