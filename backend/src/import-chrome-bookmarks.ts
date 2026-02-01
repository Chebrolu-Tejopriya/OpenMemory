/**
 * Imports Chrome bookmarks directly from the filesystem.
 * Use this for local testing without loading the Chrome extension.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ingestItems } from './ingest.js';
import { StandardizedItem } from './types.js';

interface ChromeBookmarkNode {
  id: string;
  name: string;
  type: 'url' | 'folder';
  url?: string;
  date_added?: string;
  children?: ChromeBookmarkNode[];
}

interface ChromeBookmarksFile {
  roots: {
    bookmark_bar: ChromeBookmarkNode;
    other: ChromeBookmarkNode;
    synced: ChromeBookmarkNode;
  };
}

/**
 * Get Chrome bookmarks file path based on OS.
 * Tries multiple common profile locations.
 */
function getChromeBookmarksPath(): string {
  const platform = os.platform();
  const homeDir = os.homedir();

  let userDataDir: string;
  if (platform === 'win32') {
    userDataDir = path.join(
      process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local'),
      'Google', 'Chrome', 'User Data'
    );
  } else if (platform === 'darwin') {
    userDataDir = path.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome');
  } else {
    userDataDir = path.join(homeDir, '.config', 'google-chrome');
  }

  // Try common profile locations in order of preference
  const profiles = ['Default', 'Profile 1', 'Profile 2', 'Profile 3', 'Profile 4'];

  for (const profile of profiles) {
    const bookmarksPath = path.join(userDataDir, profile, 'Bookmarks');
    if (fs.existsSync(bookmarksPath)) {
      return bookmarksPath;
    }
  }

  // Fallback to Default even if it doesn't exist (will error with helpful message)
  return path.join(userDataDir, 'Default', 'Bookmarks');
}

/**
 * Recursively extract bookmarks from Chrome's nested structure.
 */
function extractBookmarks(
  node: ChromeBookmarkNode,
  folderPath: string | null,
  items: StandardizedItem[]
): void {
  if (node.type === 'url' && node.url) {
    items.push({
      source: 'chrome_bookmarks',
      title: node.name || node.url,
      url: node.url,
      folder: folderPath,
      created_at: node.date_added
        ? new Date(parseInt(node.date_added) / 1000 - 11644473600000)
        : new Date(),
    });
  } else if (node.type === 'folder' && node.children) {
    const newPath = node.name
      ? (folderPath ? `${folderPath}/${node.name}` : node.name)
      : folderPath;

    for (const child of node.children) {
      extractBookmarks(child, newPath, items);
    }
  }
}

async function main() {
  const bookmarksPath = getChromeBookmarksPath();
  console.log(`Reading Chrome bookmarks from: ${bookmarksPath}`);

  if (!fs.existsSync(bookmarksPath)) {
    console.error('Chrome bookmarks file not found at:', bookmarksPath);
    console.error('Make sure Chrome is installed and you have bookmarks saved.');
    process.exit(1);
  }

  const content = fs.readFileSync(bookmarksPath, 'utf-8');
  const data: ChromeBookmarksFile = JSON.parse(content);

  const items: StandardizedItem[] = [];

  // Extract from all bookmark roots
  extractBookmarks(data.roots.bookmark_bar, null, items);
  extractBookmarks(data.roots.other, null, items);
  extractBookmarks(data.roots.synced, null, items);

  console.log(`Found ${items.length} bookmarks`);

  if (items.length === 0) {
    console.log('No bookmarks to import.');
    process.exit(0);
  }

  console.log('Ingesting bookmarks (scraping pages + generating embeddings)...');
  console.log('This may take a while for large bookmark collections.\n');

  const count = await ingestItems(items, (message) => {
    process.stdout.write(`\r${message}`.padEnd(80));
  });

  console.log(`\n\nSuccessfully ingested ${count} bookmarks with rich metadata`);

  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
