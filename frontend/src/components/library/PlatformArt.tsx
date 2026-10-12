import type { CSSProperties, ReactNode } from "react";
import type { SavedPost } from "../../types";
import { effectivePlatform } from "../../lib/platform";

/**
 * Artwork for a link from a social or messaging site that gave no picture: the
 * site's colours, an abstract motif in the spirit of how it looks (a photo grid,
 * a feed, chat bubbles, a video timeline…) and its name as plain text. Generic
 * shapes only — no logos, mascots or brand lettering are drawn.
 */
export type Brand = "facebook" | "instagram" | "youtube" | "whatsapp" | "tiktok" | "wechat" | "telegram" | "linkedin"
  | "snapchat" | "reddit" | "x" | "pinterest" | "threads" | "bluesky";

export const BRAND_LABEL: Record<Brand, string> = {
  facebook: "Facebook", instagram: "Instagram", youtube: "YouTube", whatsapp: "WhatsApp", tiktok: "TikTok", wechat: "WeChat",
  telegram: "Telegram", linkedin: "LinkedIn", snapchat: "Snapchat", reddit: "Reddit", x: "X", pinterest: "Pinterest",
  threads: "Threads", bluesky: "Bluesky",
};

const FROM_PLATFORM = new Set<string>(["facebook", "instagram", "youtube", "tiktok", "linkedin", "reddit", "x", "pinterest", "threads", "bluesky"]);
// Sites the app files under "web": recognised for their artwork only (nothing stored changes).
const FROM_HOST: [RegExp, Brand][] = [
  [/(^|\.)(t\.me|telegram\.me|telegram\.org|telegra\.ph)$/, "telegram"],
  [/(^|\.)(wa\.me|whatsapp\.com)$/, "whatsapp"],
  [/(^|\.)(weixin\.qq\.com|wechat\.com)$/, "wechat"],
  [/(^|\.)snapchat\.com$/, "snapchat"],
];

export function brandOf(post: SavedPost): Brand | null {
  const platform = effectivePlatform(post);
  if (FROM_PLATFORM.has(platform)) return platform as Brand;
  const host = (post.domain || "").toLowerCase();
  return FROM_HOST.find(([pattern]) => pattern.test(host))?.[1] ?? null;
}

/** "Reel", "Video", "Group invite"… from the link's shape. */
export function kindOf(post: SavedPost, brand: Brand): string {
  let path = "";
  try { path = new URL(post.url).pathname; } catch { /* keep empty */ }
  if (/\/(reel|reels)\//.test(path)) return "Reel";
  if (/\/(shorts)\//.test(path)) return "Short";
  if (/\/(video|watch)\b/.test(path) || (brand === "youtube" && (/\/(embed|live)\//.test(path) || /youtu\.be/.test(post.url)))) return "Video";
  if (/\/stories\//.test(path)) return "Story";
  if (/\/spotlight\//.test(path)) return "Spotlight";
  if (/\/pin\//.test(path)) return "Pin";
  if (/\/comments\//.test(path)) return "Thread";
  if (/\/(groups)\//.test(path) && brand === "facebook") return "Group post";
  if (brand === "whatsapp") return /chat\.whatsapp\.com/.test(post.url) ? "Group invite" : "Chat link";
  if (brand === "telegram") return /^\/[^/]+\/\d+/.test(path) ? "Channel post" : "Channel";
  if (brand === "wechat") return "Article";
  return "Post";
}

const W = "#fff";
// Drawn in a 160 x 100 box, kept clear of the bottom-left corner where the name sits.
const MOTIF: Record<Brand, ReactNode> = {
  // A grid of photos.
  instagram: <g>{Array.from({ length: 9 }, (_, i) => <rect key={i} x={90 + (i % 3) * 22} y={4 + Math.floor(i / 3) * 22} width={18} height={18} rx={4}
    fill={W} opacity={[.42, .2, .3, .18, .5, .24, .3, .16, .36][i]} />)}</g>,
  // A feed of posts, fading down.
  facebook: <g>{[0, 1, 2].map(i => <g key={i} opacity={[.95, .55, .28][i]}>
    <circle cx={86} cy={16 + i * 22} r={6} fill={W} />
    <rect x={98} y={10 + i * 22} width={54} height={6} rx={3} fill={W} />
    <rect x={98} y={19 + i * 22} width={34} height={4} rx={2} fill={W} opacity={.6} />
  </g>)}</g>,
  // A video frame and its timeline (no play button).
  youtube: <g>
    <rect x={60} y={6} width={92} height={46} rx={8} fill={W} opacity={.07} stroke={W} strokeOpacity={.28} strokeWidth={1.5} />
    <rect x={68} y={14} width={30} height={4} rx={2} fill={W} opacity={.45} />
    <rect x={60} y={59} width={92} height={3.5} rx={1.75} fill={W} opacity={.25} />
    <rect x={60} y={59} width={58} height={3.5} rx={1.75} fill="#ff4242" />
    <circle cx={118} cy={60.75} r={4.5} fill="#ff4242" stroke="#141414" strokeWidth={1.5} />
  </g>,
  // A chat.
  whatsapp: <g>
    <rect x={70} y={6} width={64} height={15} rx={7.5} fill={W} opacity={.92} />
    <rect x={90} y={27} width={62} height={15} rx={7.5} fill="#d6f8cd" />
    <rect x={70} y={48} width={46} height={15} rx={7.5} fill={W} opacity={.7} />
    <rect x={78} y={12} width={38} height={3.5} rx={1.75} fill="#0b3b2c" opacity={.35} />
    <rect x={98} y={33} width={40} height={3.5} rx={1.75} fill="#0b3b2c" opacity={.35} />
  </g>,
  // Clips you swipe through, the front one split in two colours.
  tiktok: <g>
    <rect x={74} y={8} width={38} height={72} rx={8} fill={W} opacity={.08} />
    <rect x={82} y={11} width={38} height={70} rx={8} fill={W} opacity={.12} />
    <rect x={87} y={13} width={38} height={68} rx={8} fill="none" stroke="#25f4ee" strokeWidth={2} />
    <rect x={93} y={17} width={38} height={68} rx={8} fill="none" stroke="#fe2c55" strokeWidth={2} />
    <rect x={90} y={15} width={38} height={68} rx={8} fill="#0d0d10" stroke={W} strokeOpacity={.9} strokeWidth={1.5} />
    <rect x={96} y={62} width={22} height={3} rx={1.5} fill={W} opacity={.85} />
    <rect x={96} y={69} width={14} height={3} rx={1.5} fill={W} opacity={.5} />
    {[36, 46, 56].map(y => <circle key={y} cx={140} cy={y} r={3} fill={W} opacity={.75} />)}
  </g>,
  // An article card.
  wechat: <g>
    <rect x={66} y={6} width={86} height={56} rx={7} fill={W} opacity={.94} />
    <path d="M66 13 a7 7 0 0 1 7 -7 h72 a7 7 0 0 1 7 7 v14 h-86 z" fill="#07c160" opacity={.35} />
    <rect x={74} y={34} width={50} height={5} rx={2.5} fill="#123322" opacity={.75} />
    <rect x={74} y={43} width={36} height={4} rx={2} fill="#123322" opacity={.4} />
    <rect x={74} y={51} width={42} height={4} rx={2} fill="#123322" opacity={.3} />
    <rect x={130} y={34} width={14} height={14} rx={3} fill="#07c160" opacity={.6} />
  </g>,
  // A dashed route across the sky and two messages.
  telegram: <g>
    <path d="M62 58 C 80 50, 96 22, 132 10" fill="none" stroke={W} strokeOpacity={.6} strokeWidth={2} strokeDasharray="4 5" strokeLinecap="round" />
    <circle cx={132} cy={10} r={3} fill={W} />
    <rect x={98} y={28} width={54} height={14} rx={7} fill={W} opacity={.94} />
    <rect x={110} y={47} width={42} height={14} rx={7} fill={W} opacity={.68} />
  </g>,
  // A network of people.
  linkedin: <g stroke={W} strokeOpacity={.35} strokeWidth={1.2}>
    {[[70, 26, 96, 14], [96, 14, 122, 28], [70, 26, 90, 54], [90, 54, 116, 62], [122, 28, 116, 62], [122, 28, 148, 18], [116, 62, 146, 52], [96, 14, 116, 62]]
      .map(([a, b, c, d], i) => <line key={i} x1={a} y1={b} x2={c} y2={d} />)}
    {[[70, 26, 5], [96, 14, 4], [148, 18, 3.5], [90, 54, 4.5], [146, 52, 4]].map(([x, y, r], i) => <circle key={i} cx={x} cy={y} r={r} fill={W} stroke="none" opacity={.85} />)}
    <circle cx={122} cy={28} r={8.5} fill={W} stroke="none" />
    <circle cx={122} cy={28} r={12.5} fill="none" strokeOpacity={.6} strokeWidth={1.5} />
    <circle cx={116} cy={62} r={5.5} fill={W} stroke="none" opacity={.85} />
  </g>,
  // Story rings.
  snapchat: <g fill="none" stroke="#111" strokeLinecap="round">
    <circle cx={120} cy={36} r={25} strokeWidth={3} strokeDasharray="18 6" strokeOpacity={.85} />
    <circle cx={120} cy={36} r={18} fill="#111" fillOpacity={.08} stroke="none" />
    <circle cx={76} cy={20} r={11} strokeWidth={2.5} strokeDasharray="10 4" strokeOpacity={.6} />
    <circle cx={84} cy={52} r={8} strokeWidth={2} strokeDasharray="7 4" strokeOpacity={.45} />
    {[[152, 12], [154, 62], [100, 70]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r={2.2} fill="#111" stroke="none" opacity={.55} />)}
  </g>,
  // Votes and a nested comment thread.
  reddit: <g>
    <polyline points="66,20 72,14 78,20" fill="none" stroke={W} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
    <rect x={67} y={26} width={10} height={4} rx={2} fill={W} opacity={.8} />
    <polyline points="66,36 72,42 78,36" fill="none" stroke={W} strokeOpacity={.4} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
    <line x1={90} y1={10} x2={90} y2={64} stroke={W} strokeOpacity={.35} strokeWidth={1.5} />
    <rect x={98} y={10} width={54} height={6} rx={3} fill={W} opacity={.95} />
    <rect x={98} y={20} width={38} height={4} rx={2} fill={W} opacity={.55} />
    <line x1={104} y1={32} x2={104} y2={64} stroke={W} strokeOpacity={.3} strokeWidth={1.5} />
    <rect x={112} y={33} width={40} height={6} rx={3} fill={W} opacity={.8} />
    <rect x={112} y={43} width={26} height={4} rx={2} fill={W} opacity={.45} />
    <rect x={120} y={55} width={32} height={6} rx={3} fill={W} opacity={.65} />
  </g>,
  // A timeline.
  x: <g>
    {[0, 1].map(i => <g key={i} opacity={i ? .45 : 1}>
      <circle cx={74} cy={16 + i * 34} r={7} fill={W} opacity={.9} />
      <rect x={88} y={10 + i * 34} width={42} height={4.5} rx={2.25} fill={W} opacity={.95} />
      <rect x={88} y={19 + i * 34} width={62} height={3.5} rx={1.75} fill={W} opacity={.5} />
      <rect x={88} y={26 + i * 34} width={48} height={3.5} rx={1.75} fill={W} opacity={.5} />
    </g>)}
    <line x1={64} y1={39} x2={160} y2={39} stroke={W} strokeOpacity={.14} />
  </g>,
  // A board of pins.
  pinterest: <g>
    {[[98, 4, 28, .38], [98, 37, 30, .22], [132, 4, 44, .26], [132, 53, 26, .4], [166, 4, 20, .2], [166, 29, 34, .34]].map(([x, y, h, o], i) =>
      <rect key={i} x={x - 4} y={y} width={30} height={h} rx={6} fill={W} opacity={o} />)}
  </g>,
  // A thread of replies.
  threads: <g>
    <circle cx={76} cy={18} r={7} fill={W} opacity={.9} />
    <line x1={76} y1={28} x2={76} y2={48} stroke={W} strokeOpacity={.4} strokeWidth={1.5} />
    <circle cx={76} cy={55} r={5} fill={W} opacity={.6} />
    <rect x={90} y={12} width={44} height={4.5} rx={2.25} fill={W} opacity={.95} />
    <rect x={90} y={21} width={60} height={3.5} rx={1.75} fill={W} opacity={.5} />
    <rect x={90} y={52} width={48} height={3.5} rx={1.75} fill={W} opacity={.4} />
  </g>,
  // Soft clouds.
  bluesky: <g fill={W}>
    <ellipse cx={112} cy={24} rx={28} ry={10} opacity={.5} /><ellipse cx={125} cy={18} rx={15} ry={9} opacity={.5} />
    <ellipse cx={108} cy={54} rx={22} ry={7} opacity={.35} /><ellipse cx={117} cy={50} rx={11} ry={7} opacity={.35} />
    <ellipse cx={148} cy={64} rx={14} ry={5} opacity={.28} />
  </g>,
};

export default function PlatformArt({ post, brand, compact = false, style }: { post: SavedPost; brand: Brand; compact?: boolean; style?: CSSProperties }) {
  const kind = kindOf(post, brand);
  return (
    <div className="category-preview platform-art" data-brand={brand} style={style}
      aria-label="No content preview available" title={`${BRAND_LABEL[brand]} ${kind.toLowerCase()} — no picture was shared`}>
      <svg className="platform-art__motif" viewBox="0 0 160 100" preserveAspectRatio="xMaxYMid slice" aria-hidden="true">{MOTIF[brand]}</svg>
      {!compact && <span className="platform-art__label" aria-hidden="true">
        <span className="platform-art__name">{BRAND_LABEL[brand]}</span>
        <span className="platform-art__kind">{kind}</span>
      </span>}
      {compact && <span className="platform-art__label platform-art__label--compact" aria-hidden="true">
        <span className="platform-art__name">{BRAND_LABEL[brand]}</span>
      </span>}
    </div>
  );
}
