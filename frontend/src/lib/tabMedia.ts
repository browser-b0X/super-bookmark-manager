/**
 * Pictures and the video of an Instagram post, handed over from the owner's tab by the browser extension
 * (v0.4.0 phase 4): the Save window receives them as files, uploads them to the app on this computer and
 * asks for the copy with their ids, so the app doesn't fetch them from Instagram. Each message is checked:
 * only Instagram's own picture hosts, a known kind, a file within the limits.
 */
import type { InstagramFiles } from "./instagram";
import { appProved, runtimeToken } from "./publicRuntime";

export type MediaKind = "picture" | "video";
export const MEDIA_LIMITS: Record<MediaKind, number> = { picture: 4 * 1024 * 1024, video: 50 * 1024 * 1024 };

export interface TabFile {
  url: string;
  kind: MediaKind;
  /** Bytes so far and in all (the extension says), while the file comes over from the tab. */
  received: number;
  total: number;
  blob?: Blob;
  error?: "too_large" | "unavailable";
}

const MEDIA_HOST = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;

function mediaUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096) return "";
  try { const u = new URL(value); return u.protocol === "https:" && MEDIA_HOST.test(u.hostname) ? value : ""; } catch { return ""; }
}

/** A `sbm-media` or `sbm-media-progress` message from the extension's helper in this window (for the post with
 *  this address), or null. */
export function readMediaMessage(value: unknown): { post: string; file: TabFile } | null {
  const v = value as Record<string, unknown>;
  if (!v || typeof v !== "object" || (v.type !== "sbm-media" && v.type !== "sbm-media-progress")) return null;
  const url = mediaUrl(v.url);
  const kind = v.kind === "picture" || v.kind === "video" ? v.kind : null;
  if (typeof v.post !== "string" || v.post.length > 4096 || !url || !kind) return null;
  const total = typeof v.total === "number" && Number.isFinite(v.total) && v.total >= 0 ? v.total : 0;
  const received = typeof v.received === "number" && Number.isFinite(v.received) && v.received >= 0 ? v.received : 0;
  if (v.type === "sbm-media-progress") return { post: v.post, file: { url, kind, received, total } };
  if (v.error === "too_large" || v.error === "unavailable") return { post: v.post, file: { url, kind, received: 0, total, error: v.error } };
  if (!(v.blob instanceof Blob) || !v.blob.size) return { post: v.post, file: { url, kind, received: 0, total, error: "unavailable" } };
  if (v.blob.size > MEDIA_LIMITS[kind]) return { post: v.post, file: { url, kind, received: 0, total: v.blob.size, error: "too_large" } };
  return { post: v.post, file: { url, kind, received: v.blob.size, total: v.blob.size, blob: v.blob } };
}

/** Put a file the tab handed over into the app (same-origin, raw bytes); its id, or null. Reports progress. */
export async function uploadTabFile(blob: Blob, onProgress: (sent: number) => void): Promise<string | null> {
  if (!await appProved(true)) return null;
  return new Promise(resolve => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/archive/media");
    request.setRequestHeader("Content-Type", blob.type && /^(image|video)\//.test(blob.type) ? blob.type : "application/octet-stream");
    // The packaged app wants this run's token on every write, and only fetch has it added for it.
    if (runtimeToken) request.setRequestHeader("X-SBM-Instance", runtimeToken);
    request.upload.onprogress = event => onProgress(event.loaded);
    request.onload = () => {
      try {
        const answer = JSON.parse(request.responseText) as { ok?: boolean; id?: unknown };
        resolve(request.status === 200 && answer.ok && typeof answer.id === "string" && /^[0-9a-f]{64}$/.test(answer.id) ? answer.id : null);
      } catch { resolve(null); }
    };
    request.onerror = () => resolve(null);
    request.send(blob);
  });
}

/** What the copy is told about the files: each uploaded picture by address, and the video's id or why it's missing. */
export function filesFor(files: TabFile[], ids: Map<string, string>, videoFile: boolean | null = null): InstagramFiles {
  const pictures: Record<string, string> = {};
  for (const file of files) if (file.kind === "picture" && ids.has(file.url)) pictures[file.url] = ids.get(file.url)!;
  const video = files.find(file => file.kind === "video");
  // `videoFile` false: the extension read a video post whose page didn't hold the video's file.
  if (!video) return { pictures, video: videoFile === false ? "not_on_page" : "" };
  return { pictures, video: ids.get(video.url) ?? (video.error === "too_large" ? "too_large" : "unavailable") };
}

export const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
