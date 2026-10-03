import { useEffect, useMemo, useRef, type CSSProperties } from "react";

type Kind = "square" | "circle" | "triangle" | "rect";
const KINDS: Kind[] = ["square", "circle", "triangle", "rect"];

/** Small seeded generator: the same layout on every visit, no flicker on re-render. */
function seeded(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A slow geometric field behind the app: squares turn, circles breathe,
 * triangles drift, bars slide, and pin-prick particles twinkle. Shapes shift a
 * little with the pointer for depth. Purely decorative, hidden from assistive
 * tech, and still for anyone who asks for reduced motion.
 */
export default function Backdrop() {
  const ref = useRef<HTMLDivElement>(null);
  const { shapes, particles } = useMemo(() => {
    const rnd = seeded(20261002);
    const shapes = Array.from({ length: 22 }, (_, i) => ({
      kind: KINDS[i % KINDS.length],
      x: rnd() * 100, y: rnd() * 100,
      size: 26 + rnd() * 70,
      depth: 0.4 + rnd() * 1.6,
      delay: -(rnd() * 10),
      duration: 10 + rnd() * 10,
    }));
    const particles = Array.from({ length: 70 }, () => ({
      x: rnd() * 100, y: rnd() * 100, delay: -(rnd() * 8), duration: 5 + rnd() * 6, size: rnd() < .2 ? 3 : 2,
    }));
    return { shapes, particles };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0, x = 0, y = 0;
    const move = (e: PointerEvent) => {
      x = e.clientX / innerWidth - .5; y = e.clientY / innerHeight - .5;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        el.style.setProperty("--mx", x.toFixed(3));
        el.style.setProperty("--my", y.toFixed(3));
      });
    };
    addEventListener("pointermove", move, { passive: true });
    return () => { removeEventListener("pointermove", move); cancelAnimationFrame(frame); };
  }, []);

  return (
    <div ref={ref} className="backdrop" aria-hidden="true">
      <div className="backdrop__glow" />
      {shapes.map((s, i) => (
        <div key={i} className="backdrop__layer" style={{ left: `${s.x}%`, top: `${s.y}%`, "--depth": s.depth } as CSSProperties}>
          <span className={`backdrop__shape is-${s.kind}`}
            style={{ "--size": `${s.size}px`, animationDelay: `${s.delay}s`, animationDuration: `${s.duration}s` } as CSSProperties} />
        </div>
      ))}
      {particles.map((p, i) => (
        <span key={`p${i}`} className="backdrop__spark"
          style={{ left: `${p.x}%`, top: `${p.y}%`, width: p.size, height: p.size, animationDelay: `${p.delay}s`, animationDuration: `${p.duration}s` }} />
      ))}
    </div>
  );
}
