import type { SavedPost } from "../types";

/**
 * Which links are still missing a preview, and what became of a fetch.
 *
 * A page that was read and simply has no picture is not "missing" anything: its
 * title and description are its preview (the feed draws a text card), so it is
 * not counted, and not fetched again and again. Missing means: never fetched by
 * this app (waiting, or carried over from the old database without a picture),
 * failed, or a picture the app kept that isn't on this computer (`lost`, see
 * lostPictures: a backup restored without its picture files). A link whose fetch
 * failed again after the owner asked for it is set aside (metadataTriedAt) and
 * listed instead, until a fetch succeeds.
 */
export function needsPreview(post: SavedPost, lost?: ReadonlySet<string>): boolean {
  if (post.linkStatus === "gone" || post.metadataStatus === "none") return false;
  const pictureGone = pictureLost(post, lost);
  if (post.thumbnailUrl && !pictureGone) return false;
  if (post.metadataStatus === "failed") return !post.metadataTriedAt;
  // enrichedAt is set by every fetch that worked.
  return pictureGone || post.metadataStatus === "pending" || !post.enrichedAt;
}

/** Links the owner already asked for that still couldn't be fetched. */
export function couldNotFetch(post: SavedPost, lost?: ReadonlySet<string>): boolean {
  return post.metadataStatus === "failed" && !!post.metadataTriedAt && post.linkStatus !== "gone"
    && (!post.thumbnailUrl || pictureLost(post, lost));
}

/** The cache code of a picture this app keeps itself (`/thumb/<code>`), "" for any other address. */
export function pictureCode(url?: string): string {
  return /^\/thumb\/([A-Za-z0-9_-]{2,64})$/.exec(url ?? "")?.[1] ?? "";
}

/** The link's picture is one the app kept and it isn't on this computer (`lost`: codes the server lacks). */
export function pictureLost(post: SavedPost, lost?: ReadonlySet<string>): boolean {
  return !!lost?.size && lost.has(pictureCode(post.thumbnailUrl));
}

export type Outcome = "picture" | "words" | "retrying" | "failed" | "gone";

export function outcomeOf(post: SavedPost, now = Date.now(), lost?: ReadonlySet<string>): Outcome {
  if (post.linkStatus === "gone") return "gone";
  const picture = !!post.thumbnailUrl && !pictureLost(post, lost);
  if (picture && post.metadataStatus !== "failed" && post.metadataStatus !== "pending") return "picture";
  if (post.metadataStatus === "failed" || post.metadataStatus === "pending") {
    return post.metadataRetryAt && Date.parse(post.metadataRetryAt) > now ? "retrying" : "failed";
  }
  return picture ? "picture" : "words";
}

/** Why a link has no preview, in a few words. */
export function failureReason(post: SavedPost): string {
  const code = post.httpStatus;
  if (post.linkStatus === "gone") return code ? `Not found (${code})` : "Not found";
  if (code === 401 || code === 403) return `The site refused (${code})`;
  if (code === 429) return "The site is limiting requests";
  if (code && code >= 500) return `The site had an error (${code})`;
  if (code) return `The site answered ${code}`;
  if (post.metadataRetryAt) return "Busy — tries again by itself";
  if (post.metadataError?.startsWith("This link's metadata could not be read")) return "Not a readable page";
  return "Couldn't connect";
}
