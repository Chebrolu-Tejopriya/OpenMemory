/**
 * Standardized item shape that all source adapters must produce.
 * This is the common format used throughout the ingestion pipeline.
 */
export interface StandardizedItem {
  source: string;
  title: string;
  url: string;
  folder: string | null;
  created_at: Date;
}

/**
 * Source Adapter Interface
 *
 * Any integration (Chrome Bookmarks, Pinterest, Instagram, etc.)
 * must implement this interface to plug into the ingestion pipeline.
 */
export interface SourceAdapter<TRawData = unknown> {
  /** Unique identifier for this source (e.g., "chrome_bookmarks") */
  readonly sourceId: string;

  /**
   * Transforms raw data from the source into standardized items.
   * @param rawData - The raw data format from the source
   * @returns Array of standardized items ready for the ingestion pipeline
   */
  normalize(rawData: TRawData): StandardizedItem[];
}
