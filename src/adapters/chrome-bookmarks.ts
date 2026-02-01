import { SourceAdapter, StandardizedItem } from '../types';

/**
 * Chrome bookmark node structure from chrome.bookmarks API
 */
export interface ChromeBookmarkNode {
  id: string;
  title: string;
  url?: string;
  dateAdded?: number;
  children?: ChromeBookmarkNode[];
}

/**
 * Chrome Bookmarks Source Adapter
 *
 * Fetches and transforms Chrome's nested bookmark tree into standardized items.
 */
export class ChromeBookmarksAdapter implements SourceAdapter<ChromeBookmarkNode[]> {
  readonly sourceId = 'chrome_bookmarks';

  /**
   * Fetches all bookmarks from Chrome using the bookmarks API.
   * Must be called from a Chrome extension context with "bookmarks" permission.
   */
  async fetch(): Promise<ChromeBookmarkNode[]> {
    return chrome.bookmarks.getTree();
  }

  /**
   * Transforms raw Chrome bookmark tree into standardized items.
   */
  normalize(rawData: ChromeBookmarkNode[]): StandardizedItem[] {
    const items: StandardizedItem[] = [];
    this.traverseNodes(rawData, null, items);
    return items;
  }

  /**
   * Convenience method: fetches and normalizes in one call.
   */
  async getAll(): Promise<StandardizedItem[]> {
    const raw = await this.fetch();
    return this.normalize(raw);
  }

  /**
   * Recursively traverses the bookmark tree, collecting bookmarks (not folders).
   * Builds full folder paths like "Design/Inspiration/Dashboards".
   */
  private traverseNodes(
    nodes: ChromeBookmarkNode[],
    folderPath: string | null,
    items: StandardizedItem[]
  ): void {
    for (const node of nodes) {
      if (node.url) {
        // It's a bookmark - add to items
        items.push({
          source: this.sourceId,
          title: node.title || node.url,
          url: node.url,
          folder: folderPath,
          created_at: new Date(node.dateAdded ?? Date.now()),
        });
      } else if (node.children) {
        // It's a folder - build path and recurse
        // Skip empty root node titles (Chrome's invisible root)
        const newPath = node.title
          ? (folderPath ? `${folderPath}/${node.title}` : node.title)
          : folderPath;
        this.traverseNodes(node.children, newPath, items);
      }
    }
  }
}
