import { useEffect, useRef, useState, type RefObject } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Dialog behaviour for a box drawn over the page: focus moves in, Tab and Shift+Tab stay
 * inside, Escape closes (unless something inside handled it first, such as cancelling a
 * rename, by calling preventDefault), and focus goes back to whatever opened the dialog.
 *
 * The box needs tabIndex={-1} so it can hold focus itself when nothing inside is focusable.
 */
export function useDialog(box: RefObject<HTMLElement | null>, onClose: () => void): void {
  // What had focus when the dialog first rendered: an autoFocus field inside takes focus
  // before any effect runs, so the opener is read here.
  const [opener] = useState(() => (typeof document === "undefined" ? null : document.activeElement as HTMLElement | null));
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!box.current?.contains(document.activeElement)) box.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      const el = box.current;
      if (!el) return;
      if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); close.current(); return; }
      if (e.key !== "Tab") return;
      // Reachable by Tab and shown: not tabIndex -1 (the palette's results are picked with the arrow keys).
      const focusable = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(node => node.tabIndex >= 0 && node.offsetParent !== null);
      const active = document.activeElement;
      if (!focusable.length) { e.preventDefault(); el.focus({ preventScroll: true }); return; }
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (!el.contains(active)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && (active === first || active === el)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener && opener.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once per dialog; onClose is read through a ref
}
