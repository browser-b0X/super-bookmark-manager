import { useId } from "react";

/**
 * The SuperBookmarks mark: a jar that keeps the web's best bits on your own shelf, drawn as
 * one even line (owner's choice, 2026-10-09). Inside the app its gradient follows the theme
 * (--logo-a → --logo-b); the icon files use the default colours on a dark tile.
 */
export default function BrandMark({ size = 32, title }: { size?: number; title?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role={title ? "img" : undefined} aria-hidden={title ? undefined : true}
      aria-label={title} className="brand-mark">
      <defs>
        <linearGradient id={`bm${id}`} x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--logo-a, #9c8cf2)" />
          <stop offset="1" stopColor="var(--logo-b, #4cc9f0)" />
        </linearGradient>
      </defs>
      <g fill="none" stroke={`url(#bm${id})`} strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
        <rect x="20" y="6" width="24" height="7" rx="2" />
        <path d="M22 13 v4 c-6 3 -9 8 -9 15 v18 a8 8 0 0 0 8 8 h22 a8 8 0 0 0 8 -8 v-18 c0 -7 -3 -12 -9 -15 v-4" />
        <circle cx="32" cy="38" r="10" />
        <path d="M22 38 h20" />
        <path d="M32 28 c-4 3 -4 17 0 20 c4 -3 4 -17 0 -20" />
        <path d="M45 22 v9 l-2.5 -2 l-2.5 2 v-9" strokeWidth="2.6" />
      </g>
    </svg>
  );
}
