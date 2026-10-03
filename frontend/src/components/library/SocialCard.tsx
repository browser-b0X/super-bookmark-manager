import type { CSSProperties } from "react";
import { Heart, MessageCircle, Music2, Play, Repeat2, ArrowBigUp, Share } from "lucide-react";
import type { Platform, SavedPost } from "../../types";
import { PLATFORM_META } from "../../lib/ui";
import { effectivePlatform, titleFromUrl } from "../../lib/platform";
import { displayText } from "../../lib/displayText";

/** Platforms whose image-less posts are drawn as a styled text post. */
export const SOCIAL_PLATFORMS = new Set<Platform>(["instagram", "x", "tiktok", "reddit", "facebook", "threads",
  "linkedin", "pinterest", "bluesky", "youtube"]);

// "1,234 likes, 56 comments - someone on August 1, 2026: "caption"" → caption
const META_PREFIX = /^[\d.,]+[KkMm]?\s+(?:likes?|reactions?),\s*[\d.,]+[KkMm]?\s+comments?\s*-\s*.+?\s+on\s+[^:]{3,40}:\s*/;
// "Someone on Instagram: "caption"" / "Someone on X: "caption"" → caption
const ON_PLATFORM = /^.{1,80}?\son\s(?:Instagram|X|Twitter|TikTok|Threads|Facebook|LinkedIn|Bluesky)\s*:\s*/i;

function clean(raw: string | undefined | null): string {
  return displayText(raw).replace(META_PREFIX, "").replace(ON_PLATFORM, "").replace(/^["“]|["”]\.?$/g, "")
    .replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
}

/** The post's own words, when there are enough of them to stand in for an image. */
export function captionOf(post: SavedPost): string {
  for (const raw of [post.description, post.excerpt, post.telegramMessage?.text, post.aiSummary]) {
    const text = clean(raw);
    if (text.length >= 24 && text !== post.url) return text;
  }
  return "";
}

/** Platform for display: links saved before a platform was recognised are re-read from their URL. */
export function platformOf(post: SavedPost): Platform {
  return effectivePlatform(post);
}

/** Who posted it, from saved metadata or the URL's shape. */
export function handleOf(post: SavedPost, platform = platformOf(post)): string {
  let path: string[] = [];
  try { path = new URL(post.url).pathname.split("/").filter(Boolean).map(decodeURIComponent); } catch { /* keep empty */ }
  const at = (s?: string) => s ? (s.startsWith("@") ? s : `@${s}`) : "";
  switch (platform) {
    case "x": if (path[1] === "status" && !["i", "home"].includes(path[0])) return at(path[0]); break;
    case "tiktok": case "threads": if (path[0]?.startsWith("@")) return path[0]; break;
    case "bluesky": if (path[0] === "profile" && path[1]) return at(path[1]); break;
    case "reddit": if (path[0] === "r" && path[1]) return `r/${path[1]}`; if (path[0] === "user" && path[1]) return `u/${path[1]}`; break;
    case "instagram": if (path[0] && !["p", "reel", "reels", "tv", "stories"].includes(path[0]) && ["p", "reel"].includes(path[1])) return at(path[0]); break;
    case "facebook": if (path[0] && !["watch", "share", "photo", "photo.php", "story.php", "permalink.php", "groups", "reel"].includes(path[0])) return path[0];
      if (path[0] === "groups" && path[1]) return path[1]; break;
    case "linkedin": if (path[0] === "posts" && path[1]) return path[1].split("_")[0]; if (["in", "company"].includes(path[0]) && path[1]) return path[1]; break;
  }
  if (post.author) return platform === "youtube" || post.author.includes(" ") ? post.author : at(post.author);
  return post.siteName && !/^(instagram|x|tiktok|facebook|threads|reddit|linkedin|pinterest|bluesky|youtube)$/i.test(post.siteName)
    ? post.siteName : "";
}

function hue(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

/**
 * An image-less social post, drawn in the spirit of its platform so a feed of
 * mixed links still reads at a glance: X as a dark text post, TikTok as a
 * vertical clip, Facebook with its blue band, Reddit with the subreddit, and
 * so on. Generic shapes and colours only; no logos are reproduced.
 */
export default function SocialCard({ post, color }: { post: SavedPost; color: string }) {
  const platform = platformOf(post);
  const meta = PLATFORM_META[platform] ?? PLATFORM_META.web;
  const Icon = meta.icon;
  const handle = handleOf(post, platform);
  const title = displayText(post.title);
  const usefulTitle = title && title !== post.url && title !== titleFromUrl(post.canonicalUrl || post.url) ? clean(title) : "";
  const text = captionOf(post) || usefulTitle;
  const name = handle || meta.label;
  const initial = (name.replace(/^[@ru]\//, "").replace(/^@/, "")[0] || "?").toUpperCase();
  const style = { "--preview-color": color, "--platform-color": meta.color, "--avatar-hue": hue(name) } as CSSProperties;

  const avatar = <span className="social-card__avatar" aria-hidden="true">{initial}</span>;
  const header = (
    <span className="social-card__header" aria-hidden="true">
      {platform === "reddit" ? <span className="social-card__sub">{handle || "Reddit"}</span> : <>{avatar}<span className="social-card__name">{name}</span></>}
      <span className="flex-1" />
      <Icon size={13} className="social-card__glyph" />
    </span>
  );
  const actions = (icons: typeof Heart[]) => (
    <span className="social-card__actions" aria-hidden="true">{icons.map((A, i) => <A key={i} size={12} />)}</span>
  );

  return (
    <div className="category-preview social-card" data-brand={platform} style={style} aria-label="No content preview available">
      {platform === "tiktok" ? <>
        <span className="social-card__clip-glyph" aria-hidden="true"><Play size={18} fill="currentColor" /></span>
        <span className="social-card__clip-body">
          <span className="social-card__name">{name}</span>
          {text && <p className="social-card__text art-text" data-label={text} />}
          <span className="social-card__sound" aria-hidden="true"><Music2 size={11} /> original sound{handle ? ` · ${handle}` : ""}</span>
        </span>
      </> : platform === "youtube" ? <>
        <span className="social-card__play" aria-hidden="true"><Play size={20} fill="currentColor" /></span>
        {text && <p className="social-card__text art-text" data-label={text} />}
        <span className="social-card__name">{name}</span>
      </> : <>
        {header}
        {text ? <p className="social-card__text art-text" data-label={text} /> : <span className="social-card__empty" aria-hidden="true">
          <Icon size={34} strokeWidth={1.3} /><span className="social-card__kind">{kindOf(post, meta.label)}</span></span>}
        {platform === "x" || platform === "bluesky" || platform === "threads" ? actions([MessageCircle, Repeat2, Heart, Share])
          : platform === "reddit" ? actions([ArrowBigUp, MessageCircle, Share])
          : platform === "facebook" || platform === "linkedin" ? actions([Heart, MessageCircle, Share])
          : platform === "instagram" ? actions([Heart, MessageCircle, Share]) : null}
      </>}
    </div>
  );
}

/** "Reel", "Post", "Video"… from the link's shape, for posts with no words to show. */
function kindOf(post: SavedPost, label: string): string {
  const path = (() => { try { return new URL(post.url).pathname; } catch { return ""; } })();
  if (/\/(reel|reels)\//.test(path)) return `${label} reel`;
  if (/\/(video|watch|shorts)\b/.test(path)) return `${label} video`;
  if (/\/status\//.test(path)) return `Post on ${label}`;
  if (/\/stories\//.test(path)) return `${label} story`;
  return `${label} post`;
}

function usefulTitle(post: SavedPost): string {
  const title = displayText(post.title);
  return title && title !== post.url && title !== titleFromUrl(post.canonicalUrl || post.url) ? clean(title) : "";
}

/** Whether a page has enough words of its own for a preview card. */
export function hasWebCardText(post: SavedPost): boolean {
  return !!(usefulTitle(post) || captionOf(post));
}

/**
 * A page that gave no usable picture, drawn as a link preview: the site's
 * icon and name, the title, and the opening of its description. GitHub links
 * show owner / repository the way the site does.
 */
/* Card text is drawn from data-label by CSS: the card is artwork standing in
   for a picture (its label says so), and the real title link sits below it. */
export function WebCard({ post, color }: { post: SavedPost; color: string }) {
  const title = usefulTitle(post);
  const caption = captionOf(post);
  const text = caption && caption !== title ? caption : "";
  const site = post.siteName || post.domain;
  const platform = platformOf(post);
  let repo = "";
  if (platform === "github") {
    try { repo = new URL(post.url).pathname.split("/").filter(Boolean).slice(0, 2).join(" / "); } catch { /* keep empty */ }
  }
  const icon = post.faviconUrl?.startsWith("/thumb/") ? post.faviconUrl : "";
  const style = { "--preview-color": color, "--avatar-hue": hue(site) } as CSSProperties;
  return (
    <div className="category-preview web-card" data-kind={platform === "github" ? "repo" : platform === "pdf" ? "doc" : "page"}
      style={style} aria-label="No content preview available">
      <span className="web-card__site" aria-hidden="true">
        {/* Drawn as a background so the card holds no <img>: it is artwork, not a fetched preview. */}
        <span className="web-card__icon" style={icon ? { backgroundImage: `url("${icon}")` } : undefined}>{icon ? "" : site.slice(0, 1).toUpperCase()}</span>
        <span className="web-card__name">{site}</span>
      </span>
      {repo && <span className="web-card__repo" aria-hidden="true">{repo}</span>}
      {title && <p className="web-card__title art-text" data-label={title} />}
      {text && <p className="web-card__text art-text" data-label={text} />}
    </div>
  );
}
