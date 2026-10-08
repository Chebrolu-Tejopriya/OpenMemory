// Safety limit shared by import and resync. Larger boards are reported as partial.
export const PINTEREST_IMPORT_LIMIT = 5000;

export function hasExtractionProgress(previousHeight: number, height: number, previousCount: number, count: number): boolean {
  return height !== previousHeight || count > previousCount;
}

export function isBoardComplete(count: number, expectedCount: number | null): boolean {
  return expectedCount !== null && count >= expectedCount;
}
