import { useEffect, useRef, useState } from "react";

/**
 * Render a long list in steps: the first `step` items at once, more as the
 * end of the list scrolls into view. Thousands of cards (each with an image)
 * no longer mount in one go, and the first paint stays fast.
 */
export function useIncremental<T>(items: T[], resetKey: string, step = 120): { shown: T[]; sentinel: JSX.Element | null } {
  const [count, setCount] = useState(step);
  const ref = useRef<HTMLDivElement>(null);
  // A different list (filter, search, sort) starts from the top again; edits
  // to items already on screen (favourite, status) never collapse the list.
  useEffect(() => { setCount(step); }, [resetKey, step]);
  useEffect(() => {
    const el = ref.current;
    if (!el || count >= items.length || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) setCount(c => Math.min(items.length, c + step));
    }, { rootMargin: "800px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [count, items.length, step]);
  const more = items.length - count;
  return {
    shown: more > 0 ? items.slice(0, count) : items,
    sentinel: more > 0 ? (
      <div ref={ref} className="py-4 text-center text-[.72rem] text-[var(--faint)]" role="status">
        <button className="btn" onClick={() => setCount(c => Math.min(items.length, c + step * 4))}>Show more ({more} left)</button>
      </div>
    ) : null,
  };
}
