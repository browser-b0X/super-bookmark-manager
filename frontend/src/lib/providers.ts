// Metadata enrichment provider abstraction.
// Enrichment is best-effort and never blocks the UI; every post renders
// fully from URL-derived fallback data even when enrichment fails.

import type { SavedPost } from "../types";
import { detectMediaType, detectPlatform, domainOf, faviconFor, normalizeUrl, slugId, titleFromUrl } from "./platform";

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
      thumbnailUrl: faviconFor(url),
      metadataStatus: "partial",
    };
  },
};

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
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`backend ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error("enrichment failed");
    return {
      title: typeof data.title === "string" ? data.title : undefined,
      description: typeof data.summary === "string" ? data.summary : undefined,
      thumbnailUrl: typeof data.thumbnail === "string" ? data.thumbnail : undefined,
      metadataStatus: data.status === "partial" || !(data.title || data.summary || data.thumbnail) ? "partial" : "enriched",
      metadataError: data.error ? "Some metadata is unavailable; retry later." : undefined,
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
  const canonical = normalizeUrl(url);
  const platform = detectPlatform(canonical);
  const now = new Date().toISOString();
  return {
    id: slugId(canonical),
    url: url.trim(),
    canonicalUrl: canonical,
    source,
    platform,
    domain: domainOf(canonical),
    mediaType: detectMediaType(canonical, platform),
    title: titleFromUrl(canonical),
    thumbnailUrl: faviconFor(canonical),
    categories: [],
    tags: [],
    projectIds: [],
    status: "inbox",
    createdAt: now,
    updatedAt: now,
    metadataStatus: "partial",
  };
}

