import { useEffect, useRef, type ReactNode } from "react";

const SPEED = 28;          // px per second while hovering: slow enough to read
const DRAG_START = 6;      // px of movement before a press becomes a drag (a click stays a click)

/**
 * A shelf row on Home: no scrollbar. Hovering drifts it slowly along (back at
 * the end); pressing and holding slides it by hand. Keyboard focus, the wheel
 * and trackpads still scroll it natively. Reduced motion turns the drift off.
 */
export default function ShelfTrack({ children, label }: { children: ReactNode; label: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)");
    let hovering = false, dragging = false, moved = false, direction = 1, frame = 0, last = 0, pause = 0;
    let startX = 0, startScroll = 0, pointer = -1, position = 0;

    const edges = () => {
      const max = el.scrollWidth - el.clientWidth;
      el.classList.toggle("has-more-left", el.scrollLeft > 2);
      el.classList.toggle("has-more-right", el.scrollLeft < max - 2);
    };
    const tick = (now: number) => {
      frame = 0;
      if (!hovering || dragging || still.matches || el.contains(document.activeElement)) { last = 0; return; }
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      if (last && now > pause) {
        position = Math.min(max, Math.max(0, position + direction * SPEED * (now - last) / 1000));
        el.scrollLeft = position;
        if (position >= max || position <= 0) { direction = position >= max ? -1 : 1; pause = now + 1200; }
      }
      last = now;
      frame = requestAnimationFrame(tick);
    };
    const run = () => { if (!frame) { position = el.scrollLeft; frame = requestAnimationFrame(tick); } };
    const enter = () => { hovering = true; pause = performance.now() + 500; run(); };
    const leave = () => { hovering = false; };
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || e.pointerType === "touch") return;     // touch scrolls natively
      pointer = e.pointerId; startX = e.clientX; startScroll = el.scrollLeft; moved = false;
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      if ((e.buttons & 1) === 0) {          // released outside the row: no drag without a held button
        pointer = -1;
        if (dragging) { dragging = false; el.classList.remove("is-dragging"); run(); }
        return;
      }
      const dx = e.clientX - startX;
      if (!dragging && Math.abs(dx) < DRAG_START) return;
      if (!dragging) { dragging = true; moved = true; el.classList.add("is-dragging"); el.setPointerCapture(pointer); }
      el.scrollLeft = startScroll - dx;
      position = el.scrollLeft;
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      pointer = -1;
      if (dragging) { dragging = false; el.classList.remove("is-dragging"); if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId); run(); }
    };
    // A drag must not also open the card it started on.
    const click = (e: MouseEvent) => { if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; } };
    const scrolled = () => { edges(); if (!frame) position = el.scrollLeft; };

    edges();
    const resize = new ResizeObserver(edges);
    resize.observe(el);
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("click", click, true);
    el.addEventListener("scroll", scrolled, { passive: true });
    el.addEventListener("dragstart", e => e.preventDefault());
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("click", click, true);
      el.removeEventListener("scroll", scrolled);
    };
  }, []);

  return <div ref={ref} className="shelf-row__track" role="list" aria-label={label}>{children}</div>;
}
