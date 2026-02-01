/**
 * Intent types for bookmarks and queries.
 * Used for intent-aware retrieval.
 */
export type Intent = 'inspiration' | 'learning' | 'reference' | 'tooling';

/**
 * Standardized item from any source adapter.
 * This is what the ingestion pipeline accepts.
 */
export interface StandardizedItem {
  source: string;
  title: string;
  url: string;
  folder: string | null;
  created_at: string | Date;
}

/**
 * Scraped webpage metadata for rich embeddings.
 */
export interface PageMetadata {
  domain: string;
  pageTitle: string | null;
  metaDescription: string | null;
  metaKeywords: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogSiteName: string | null;
  h1: string[];
  h2: string[];
}

/**
 * Stored item with embedding vector and intent.
 */
export interface StoredItem {
  id: number;
  source: string;
  title: string;
  url: string;
  folder: string | null;
  intent: Intent;
  metadata: PageMetadata | null;
  embedding: number[];
  created_at: string;
  ingested_at: string;
}
