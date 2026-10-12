import type { SavedPost } from "../types";
import { fileName, renderSharePage, shrinkPicture, type ShareItem, type ShareOptions } from "./sharePage";

/** A preview picture as a Blob: the app's own kept pictures directly, other sites' through the app. */
async function pictureBlob(url: string, signal: AbortSignal): Promise<Blob | null> {
  try {
    if (/^\/thumb\/[A-Za-z0-9_-]{1,128}$/.test(url)) {
      const response = await fetch(url, { signal });
      return response.ok ? await response.blob() : null;
    }
    if (!/^https?:\/\//i.test(url)) return null;
    const response = await fetch("/api/share/picture", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }), signal,
    });
    return response.ok ? await response.blob() : null;
  } catch {
    return null;
  }
}

/** Build the page and hand it to the browser as a download. Four pictures at a time. */
export async function downloadSharePage(posts: SavedPost[], options: ShareOptions & { pictures: boolean },
  onProgress: (done: number, total: number) => void, signal: AbortSignal): Promise<{ name: string; bytes: number }> {
  const items: ShareItem[] = posts.map(post => ({ post, picture: "" }));
  const wanted = options.pictures ? items.filter(item => item.post.thumbnailUrl) : [];
  let done = 0;
  onProgress(0, wanted.length);
  let next = 0;
  const worker = async () => {
    while (next < wanted.length && !signal.aborted) {
      const item = wanted[next++];
      const blob = await pictureBlob(item.post.thumbnailUrl!, signal);
      if (blob) item.picture = await shrinkPicture(blob);
      onProgress(++done, wanted.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, wanted.length) }, worker));
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  const html = await renderSharePage(items, options);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const name = fileName(options.title, options.date);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  return { name, bytes: blob.size };
}
