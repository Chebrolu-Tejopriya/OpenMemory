// Safety limit shared by import and resync. Larger boards are reported as partial.
export const PINTEREST_IMPORT_LIMIT = 5000;

export function canonicalPinterestBoardUrl(raw: string): string {
  const url = new URL(raw);
  const parts = url.pathname.split('/').filter(Boolean);
  if (!/(^|\.)pinterest\.com$/.test(url.hostname) || parts.length !== 2 || ['pin', 'ideas', 'search'].includes(parts[0])) {
    throw new Error('Open a Pinterest board page first.');
  }
  return `https://www.pinterest.com/${parts.map(part => encodeURIComponent(decodeURIComponent(part).toLowerCase())).join('/')}/`;
}

export function hasExtractionProgress(previousHeight: number, height: number, previousCount: number, count: number): boolean {
  return height !== previousHeight || count > previousCount;
}

export function isBoardComplete(count: number, expectedCount: number | null): boolean {
  return expectedCount !== null && count >= expectedCount;
}
