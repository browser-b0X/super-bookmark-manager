import { useEffect, useMemo, useRef, useState } from "react";
import { Bookmark, Copy, TriangleAlert } from "lucide-react";
import { bookmarkletFor, DEFAULT_ORIGIN } from "../../lib/bookmarklet";

/** Settings → Sources: the bookmark button to drag onto the bookmarks bar. */
export default function SaveFromBrowserCard() {
  const origin = window.location.origin;
  const code = useMemo(() => bookmarkletFor(origin), [origin]);
  const link = useRef<HTMLAnchorElement>(null);
  const [note, setNote] = useState("");
  // React refuses javascript: addresses in href on purpose; this one is ours and only opens the app's window.
  useEffect(() => { link.current?.setAttribute("href", code); }, [code]);
  const moved = new URL(origin).port !== new URL(DEFAULT_ORIGIN).port;

  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setNote("Copied. Make a new bookmark and paste this as its address."); }
    catch { setNote("Your browser didn't allow copying. Drag the button instead."); }
  };

  return (
    <section className="panel p-5" aria-labelledby="save-from-browser-heading">
      <h3 id="save-from-browser-heading" className="flex items-center gap-2 text-[.9rem] font-semibold">
        <Bookmark size={15} className="text-[var(--accent)]" /> Save from your browser
      </h3>
      <p className="mt-1.5 text-[.76rem] text-[var(--dim)]">
        Drag this button onto your browser's bookmarks bar. On any page, click it to open a small Save window with the page's
        address and title filled in. Nothing is saved until you click Save there. Works in Chrome, Edge, Brave and Firefox.
      </p>
      {moved && <p role="note" className="mt-3 flex items-start gap-2 rounded-lg border p-2.5 text-[.76rem]" style={{ borderColor: "var(--amber)" }}>
        <TriangleAlert size={13} className="mt-0.5 shrink-0 text-[var(--amber)]" />
        <span>The app is on a different address today ({origin.replace(/^https?:\/\//, "")}), so a button you dragged before won't connect.
          Drag the new one below and delete the old bookmark.</span>
      </p>}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <a ref={link} className="btn btn-primary" style={{ cursor: "grab" }} title="Drag me to the bookmarks bar"
          onClick={e => { e.preventDefault(); setNote("Drag the button onto the bookmarks bar; clicking it here does nothing."); }}>
          <Bookmark size={13} /> Save to SuperBookmarks
        </a>
        <button className="btn" onClick={() => void copy()}><Copy size={13} /> Copy the button's link</button>
      </div>
      {note && <p role="status" className="mt-2 text-[.74rem] text-[var(--dim)]">{note}</p>}
      <p className="mt-2 text-[.72rem] text-[var(--faint)]">
        Bookmarks bar hidden? Press Ctrl+Shift+B. If your browser won't let you drag, copy the link, make a new bookmark and paste it as the address.
      </p>
      <p className="mt-3 text-[.74rem] text-[var(--dim)]">
        <b className="text-[var(--text)]">Instagram:</b> on a post you have open, the button also brings the caption, the author and the post's
        pictures, which the app saves at once. Only that one post, only when you click. Your Instagram login is never sent to the app.
      </p>
      <p className="mt-1 text-[.72rem] text-[var(--faint)]">The app must be running for the button to work. If it isn't, the browser shows a "can't connect" page.</p>
    </section>
  );
}
