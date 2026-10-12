import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import type { SavedPost } from "../../types";
import { mediaPhrase } from "../../lib/telegramRefresh";
import { useCopyAvailability } from "../../lib/copyAvailability";

interface MediaItem { name: string; kind: "photo" | "video"; src: string; duration?: number; bytes?: number }
interface KeptMedia { message: { text: string; date: string }; items: MediaItem[]; photos: number; videos: number }

const isItem = (value: unknown): value is MediaItem => {
  const item = value as MediaItem;
  return !!item && (item.kind === "photo" || item.kind === "video") && typeof item.src === "string"
    && item.src.startsWith("/archive/telegram/") && typeof item.name === "string";
};

/** Photos and videos kept from this link's Telegram message, or null. Validated: the answer comes over the network. */
async function loadMedia(url: string): Promise<KeptMedia | null> {
  try {
    const response = await fetch("/api/archive/telegram", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }),
      cache: "no-store", signal: AbortSignal.timeout(8000),
    });
    const media = (await response.json())?.media;
    if (!response.ok || !media || !Array.isArray(media.items)) return null;
    const items = media.items.filter(isItem);
    if (!items.length) return null;
    const message = media.message && typeof media.message.text === "string" ? media.message : { text: "", date: "" };
    return { message: { text: message.text, date: typeof message.date === "string" ? message.date : "" }, items,
      photos: items.filter((i: MediaItem) => i.kind === "photo").length, videos: items.filter((i: MediaItem) => i.kind === "video").length };
  } catch {
    return null;
  }
}

const STAMP = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const when = (iso: string) => { const d = new Date(iso); return iso && !Number.isNaN(d.getTime()) ? STAMP.format(d) : ""; };
const clock = (seconds?: number) => seconds === undefined ? "" : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

/**
 * "From your Telegram message": the text and the photos and videos sent with
 * the link. Inside the saved copy's panel when there is a copy (`inCopy`),
 * otherwise a small panel of its own. Shows nothing when nothing was kept.
 */
export default function TelegramMedia({ post, inCopy = false }: { post: SavedPost; inCopy?: boolean }) {
  const [media, setMedia] = useState<KeptMedia | null>(null);
  // Kept beside saved copies: with copies switched off for this run there is nothing to ask for.
  const enabled = useCopyAvailability(s => s.enabled);
  const telegram = enabled && (post.source === "telegram" || !!post.telegramMessage);
  useEffect(() => {
    setMedia(null);
    if (!telegram) return;
    let live = true;
    void loadMedia(post.url).then(found => { if (live) setMedia(found); });
    return () => { live = false; };
  }, [post.url, telegram]);
  if (!media) return null;

  const text = (media.message.text || post.telegramMessage?.text || "").trim();
  const date = when(media.message.date || post.telegramMessage?.date || "");
  const body = (
    <>
      <p className="text-[.74rem]">
        <span className="font-semibold">From your Telegram message</span>
        {date && <span className="text-[var(--faint)]"> · {date}</span>}
      </p>
      {text && <p className="tg-media__text mt-0.5 text-[.74rem] text-[var(--dim)]">“{text}”</p>}
      <ul className="tg-media__grid mt-2" aria-label="Photos and videos from Telegram">
        {media.items.map(item => (
          <li key={item.name}>
            <a href={item.src} target="_blank" rel="noopener noreferrer" className="tg-media__tile"
              aria-label={item.kind === "video" ? `Open video${item.duration !== undefined ? ` (${clock(item.duration)})` : ""}` : "Open photo"}>
              {item.kind === "photo"
                ? <img src={item.src} alt="" loading="lazy" />
                : <>
                    <video src={item.src} preload="metadata" muted playsInline tabIndex={-1} aria-hidden="true" />
                    <span className="tg-media__play" aria-hidden="true"><Play size={14} fill="currentColor" /></span>
                    {item.duration !== undefined && <span className="tg-media__time" aria-hidden="true">{clock(item.duration)}</span>}
                  </>}
            </a>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[.7rem] text-[var(--faint)]">
        {mediaPhrase(media.photos, media.videos)}, kept {inCopy ? "in the saved copy" : "on this computer"}. They open without Telegram.
      </p>
    </>
  );
  return inCopy
    ? <div role="group" className="tg-media mt-3 border-t border-[var(--border)] pt-3" aria-label="From your Telegram message">{body}</div>
    : <section className="tg-media panel mt-3 p-3" aria-label="From your Telegram message">{body}</section>;
}
