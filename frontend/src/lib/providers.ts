// Metadata enrichment provider abstraction.
// Enrichment is best-effort and never blocks the UI; every post renders
// fully from URL-derived fallback data even when enrichment fails.

import type { SavedPost } from "../types";
import { detectMediaType, detectPlatform, domainOf, idForUrl, libraryUrl, normalizeUrl, titleFromUrl } from "./platform";

export interface MetadataProvider {
  name: string;
  canHandle(url: string): boolean;
  enrich(input: { url: string; existing?: Partial<SavedPost> }): Promise<Partial<SavedPost>>;
}

/**
 * Local heuristic provider — always succeeds, no network.
 * Derives platform, domain, media type and a title from the URL path.
 */
export const localProvider: MetadataProvider = {
  name: "local",
  canHandle: () => true,
  async enrich({ url }) {
    const platform = detectPlatform(url);
    return {
      platform,
      domain: domainOf(url),
      mediaType: detectMediaType(url, platform),
      title: titleFromUrl(url),
      metadataStatus: "partial",
    };
  },
};

export class EnrichmentError extends Error {
  constructor(readonly code: string, readonly retryAfter?: number, readonly linkStatus?: "gone", readonly httpStatus?: number) { super(code); }
}

/** Failures that will happen again no matter how often we retry. */
export function isTerminalEnrichmentCode(code: string): boolean {
  return DETERMINISTIC_CODES.has(code);
}

// The backend answers with a safe_http code, not prose. These describe the
// link or the site's response shape, so a retry repeats the same failure.
// Anything else — including a transient fault and any unrecognized code —
// keeps the retry wording.
const DETERMINISTIC_CODES = new Set(["invalid_url", "blocked_url", "too_large", "unsupported_encoding", "redirect_limit", "invalid_image"]);

export function enrichmentFailure(code: string): string {
  return DETERMINISTIC_CODES.has(code)
    ? "This link's metadata could not be read. The saved link is unchanged."
    : "Metadata unavailable. The saved link is unchanged; retry later.";
}

/**
 * Optional backend provider — uses the existing local Flask service
 * (metadata_fetcher.py) when it is running. Never required: on any
 * failure we fall back gracefully.
 */
export const backendProvider: MetadataProvider = {
  name: "local-backend",
  canHandle: () => true,
  async enrich({ url }) {
    const res = await fetch("/api/enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      // Page, preview image and site icon are fetched and cached server-side.
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      throw new EnrichmentError(typeof data?.error === "string" && data.error ? data.error : res.ok ? "internal_error" : "http_error",
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
        data?.linkStatus === "gone" ? "gone" : undefined, Number.isSafeInteger(data?.httpStatus) ? data.httpStatus : undefined);
    }
    const text = (key: string) => (typeof data[key] === "string" && data[key] ? data[key] as string : undefined);
    const count = (key: string) => (Number.isSafeInteger(data[key]) && data[key] >= 0 ? data[key] as number : undefined);
    const empty = !(data.title || data.summary || data.thumbnail);
    return {
      title: text("title"),
      description: text("summary"),
      thumbnailUrl: text("thumbnail"),
      // `empty`: the site has no preview data at all — a terminal, honest state.
      metadataStatus: data.status === "empty" || empty ? "none" : data.status === "partial" ? "partial" : "enriched",
      metadataError: data.error ? "Some metadata is unavailable; retry later." : undefined,
      siteName: text("siteName"), author: text("author"), publishedAt: text("publishedAt"), lang: text("lang"),
      faviconUrl: text("faviconUrl"), canonicalUrl: text("canonicalUrl"), finalUrl: text("finalUrl"),
      linkStatus: (["ok", "redirected", "gone", "error"] as const).find(v => v === data.linkStatus) ?? "ok",
      wordCount: count("wordCount"), readingMinutes: count("readingMinutes"),
    };
  },
};

export async function backendAvailable(): Promise<boolean> {
  try {
    const r = await fetch("/api/stats", { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Create a fully-formed SavedPost from a bare URL. */
export function postFromUrl(url: string, source: SavedPost["source"] = "manual"): SavedPost {
  const exact = libraryUrl(url);
  const canonical = normalizeUrl(exact);
  const platform = detectPlatform(canonical);
  const now = new Date().toISOString();
  return {
    id: idForUrl(exact),
    url: exact,
    canonicalUrl: canonical,
    source,
    platform,
    domain: domainOf(canonical),
    mediaType: detectMediaType(canonical, platform),
    title: titleFromUrl(canonical),
    // No third-party favicon service: the site icon is fetched and cached locally.
    categories: [],
    tags: [],
    projectIds: [],
    status: "inbox",
    createdAt: now,
    updatedAt: now,
    metadataStatus: "pending",
    fieldSources: { title: "derived" },
  };
}

