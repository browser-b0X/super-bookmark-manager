// Canonical data model — adapted to the existing SQLite schema
// (title/summary/tags/category) while extending it forward.

export type Platform =
  | "instagram" | "x" | "youtube" | "github" | "reddit"
  | "tiktok" | "web" | "pdf" | "other";

export type PostStatus = "inbox" | "to-review" | "in-progress" | "reference" | "archived";
export type MetadataStatus = "pending" | "enriched" | "partial" | "failed";
export type Source = "telegram" | "manual" | "browser" | "import" | "api";

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

  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
  metadataStatus: MetadataStatus;
  metadataError?: string;
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
