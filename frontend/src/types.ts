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
  /** The title before an accepted AI clean-up, so it can be restored. */
  originalTitle?: string;
  /** Place in the owner's own order ("My order"); lower comes first. */
  position?: number;

  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
  metadataStatus: MetadataStatus;
  metadataError?: string;

  /** Folder names from the browser export, outermost first. */
  folderPath?: string[];
  /** Import run that created this post (for history and undo). */
  importBatchId?: string;

  fieldSources?: Partial<Record<"title" | "description" | "thumbnailUrl", FieldSource>>;
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
}

export interface Project {
  id: string;
  name: string;
}

export interface SavedView {
  id: string;
  name: string;
  filter: LibraryFilter;
}

export interface LibraryFilter {
  kind?: "all" | "inbox" | "to-review" | "in-progress" | "reference" | "archived" | "favorites" | "category" | "tag" | "platform" | "project" | "uncategorized";
  categoryId?: string;
  tag?: string;
  platform?: Platform;
  projectId?: string;
  search?: string;
}

export interface ActivityEvent {
  kind: "import" | "task" | "capture" | "post" | "organize";
  text: string;
  detail?: string;
  time: string;
}
