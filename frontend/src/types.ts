// Canonical data model — adapted to the existing SQLite schema
// (title/summary/tags/category) while extending it forward.

export type Platform =
  | "instagram" | "x" | "youtube" | "github" | "reddit"
  | "tiktok" | "facebook" | "threads" | "linkedin" | "pinterest" | "bluesky"
  | "web" | "pdf" | "other";

export type PostStatus = "inbox" | "to-review" | "in-progress" | "reference" | "archived";
/** `none`: the site answered but offers no preview data; retrying will not help. */
export type MetadataStatus = "pending" | "enriched" | "partial" | "failed" | "none";

/**
 * Where a displayed field came from. Enrichment may refresh `fetched` and
 * `derived` values but never overwrites `user` edits or titles from the
 * owner's own bookmark `file`.
 */
export type FieldSource = "file" | "fetched" | "user" | "derived" | "ai";
export type Source = "telegram" | "whatsapp" | "manual" | "browser" | "import" | "api";

export interface SavedPost {
  id: string;                 // stable: tg msg id when known, else slug
  url: string;
  canonicalUrl?: string;
  source: Source;
  sourceMessageId?: string;
  // First imported Telegram occurrence, retained even on an existing bookmark.
  telegramMessage?: { id?: string; date?: string; text: string };

  platform: Platform;
  title?: string;
  description?: string;       // maps to legacy `summary` / caption excerpt
  excerpt?: string;           // original post text
  thumbnailUrl?: string;
  domain: string;
  mediaType?: "video" | "image" | "thread" | "article" | "repository" | "document" | "post" | "other";

  categories: string[];       // category ids/names
  categoryMode?: "manual" | "automatic";
  categoryReview?: boolean;
  tags: string[];
  projectIds: string[];

  status: PostStatus;
  favorite?: boolean;
  pinned?: boolean;

  userNotes?: string;
  aiSummary?: string;
  /** When "Tidy up with AI" last looked at this link and the owner applied that run: a link the AI
   *  couldn't place isn't asked about again until its preview changes (enrichedAt is newer). */
  aiCheckedAt?: string;
  /** The title before an accepted AI clean-up, so it can be restored. */
  originalTitle?: string;
  /** Place in the owner's own order ("My order"); lower comes first. */
  position?: number;

  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
  /** How many times the link was opened from the app. */
  openCount?: number;
  /** "Follow up by": a calendar day (YYYY-MM-DD) on this computer. */
  followUpAt?: string;
  /** Kept in the quick row on Home. */
  useOften?: boolean;
  /** Reviewed by the owner: Tidy up with AI, background sorting, preview refreshes and Claude Desktop leave it alone. */
  reviewed?: boolean;
  /** Who made the post (a Creator's id, v0.4.0): names can change, this doesn't. */
  creatorId?: string;
  metadataStatus: MetadataStatus;
  metadataError?: string;

  /** Folder names from the browser export, outermost first. */
  folderPath?: string[];
  /** Import run that created this post (for history and undo). */
  importBatchId?: string;

  fieldSources?: Partial<Record<"title" | "description" | "thumbnailUrl" | "status", FieldSource>>;
  siteName?: string;
  author?: string;
  publishedAt?: string;
  lang?: string;
  faviconUrl?: string;
  /** Where the link ended up after redirects, when different. */
  finalUrl?: string;
  linkStatus?: "ok" | "redirected" | "gone" | "error";
  httpStatus?: number;
  wordCount?: number;
  readingMinutes?: number;
  enrichedAt?: string;
  metadataAttempts?: number;
  /** Earliest time a failed enrichment may be retried automatically. */
  metadataRetryAt?: string;
  /** When a preview fetch the owner asked for ("Fetch missing previews") last failed; cleared when a fetch succeeds. */
  metadataTriedAt?: string;

  /**
   * Saved copy of the page (archive.py). `pending`: wanted, not made yet (the
   * copy queue picks these up, also after a restart). The file itself lives in
   * the app's data folder; `archiveKey` is its name there.
   */
  archiveStatus?: "pending" | "saved" | "failed" | "too_large";
  archiveKey?: string;
  archivedAt?: string;
  archiveBytes?: number;
  /** Why the last attempt failed (a fixed code). Kept beside an older copy when an update fails. */
  archiveError?: string;
  /** The page builds itself with scripts, so the copy holds little. */
  archiveLimited?: boolean;
  /** A saved social post whose video wasn't kept (no video helper, or the video failed). */
  archiveNoVideo?: boolean;
}

/** A tag's own record (v0.4.0): the tags it sits under (several allowed) and its other names. Links carry tags as
 *  text; the id is the tag's name. */
export interface TagInfo {
  id: string;
  name: string;
  parents: string[];
  aliases: string[];
  /** When it last changed: the newer change wins between tabs and browsers. */
  updatedAt?: string;
}

/** A creator's account on one site (v0.4.0). Handles are kept in lower case. */
export interface CreatorHandle { platform: "x" | "instagram" | "tiktok" | "reddit" | "youtube"; handle: string }

/** Who made posts you saved (v0.4.0), built from the posts themselves; kept in SQLite beside the links. */
export interface Creator {
  id: string;
  name: string;
  /** Other names, older main names among them (promoting one keeps the old main name here). */
  aliases: string[];
  handles: CreatorHandle[];
  /** Profile pages. */
  urls: string[];
  notes?: string;
  picture?: string;
  about?: string;
  /** Reviewed: a refresh from the profile page leaves it alone. */
  reviewed?: boolean;
  /** When the owner last looked at its page ("new since you looked"). */
  seenAt?: string;
  /** Values from the profile page the owner chose not to take: a later refresh doesn't offer them again. */
  kept?: Record<string, string>;
  updatedAt?: string;
}

/** A link the owner removed, remembered (v0.4.0): what it held, so it can come back as it was and an import
 *  doesn't bring the same post back at another address. Kept in SQLite beside the links. */
export interface RemovedLink {
  /** "r-" and a hash of its address (lib/removedLinks). */
  id: string;
  url: string;
  /** The post it is, at whatever address (lib/duplicates postKey), for posts on X, Instagram, TikTok, Reddit, YouTube. */
  key?: string;
  /** Removed by the owner, or merged into another link of the same post (`into`, that link's address). */
  how: "removed" | "merged";
  into?: string;
  /** The link as it was, without what a preview fetch brings back. */
  post: SavedPost;
  removedAt: string;
  updatedAt?: string;
}

export interface Category {
  id: string;
  name: string;
  color: string;
  /** What belongs on this shelf. Shown as a hint when browsing or filing. */
  description?: string;
  icon?: string;
  archived?: boolean;
  order: number;
  /** When this tab last changed the shelf (name, colour, order, archive): the newer change wins between tabs. */
  updatedAt?: string;
}

export interface Project {
  id: string;
  name: string;
}

export interface SavedView {
  id: string;
  name: string;
  filter: LibraryFilter;
  /** When the view was last saved, renamed or changed: the newer change wins between tabs. */
  updatedAt?: string;
}

export interface LibraryFilter {
  kind?: "all" | "inbox" | "to-review" | "in-progress" | "reference" | "archived" | "favorites" | "category" | "tag" | "platform" | "project" | "uncategorized" | "followup";
  categoryId?: string;
  tag?: string;
  platform?: Platform;
  projectId?: string;
  search?: string;
  /** A smart shelf (v0.4.0): made with the rules editor and listed with the shelves; its rules are the search. */
  smart?: boolean;
}

export interface ActivityEvent {
  kind: "import" | "task" | "capture" | "post" | "organize";
  text: string;
  detail?: string;
  time: string;
}
