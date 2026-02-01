"use strict";
(() => {
  // src/adapters/chrome-bookmarks.ts
  var ChromeBookmarksAdapter = class {
    sourceId = "chrome_bookmarks";
    /**
     * Fetches all bookmarks from Chrome using the bookmarks API.
     * Must be called from a Chrome extension context with "bookmarks" permission.
     */
    async fetch() {
      return chrome.bookmarks.getTree();
    }
    /**
     * Transforms raw Chrome bookmark tree into standardized items.
     */
    normalize(rawData) {
      const items = [];
      this.traverseNodes(rawData, null, items);
      return items;
    }
    /**
     * Convenience method: fetches and normalizes in one call.
     */
    async getAll() {
      const raw = await this.fetch();
      return this.normalize(raw);
    }
    /**
     * Recursively traverses the bookmark tree, collecting bookmarks (not folders).
     * Builds full folder paths like "Design/Inspiration/Dashboards".
     */
    traverseNodes(nodes, folderPath, items) {
      for (const node of nodes) {
        if (node.url) {
          items.push({
            source: this.sourceId,
            title: node.title || node.url,
            url: node.url,
            folder: folderPath,
            created_at: new Date(node.dateAdded ?? Date.now())
          });
        } else if (node.children) {
          const newPath = node.title ? folderPath ? `${folderPath}/${node.title}` : node.title : folderPath;
          this.traverseNodes(node.children, newPath, items);
        }
      }
    }
  };

  // src/popup.ts
  var API_URL = "http://localhost:3000";
  var syncBtn = document.getElementById("sync-btn");
  var statusEl = document.getElementById("status");
  function setStatus(text) {
    statusEl.textContent = text;
  }
  async function syncBookmarks() {
    syncBtn.disabled = true;
    setStatus("Fetching bookmarks...");
    try {
      const adapter = new ChromeBookmarksAdapter();
      const items = await adapter.getAll();
      setStatus(`Sending ${items.length} bookmarks...`);
      const response = await fetch(`${API_URL}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items })
      });
      if (!response.ok) {
        throw new Error(`Server error: ${response.status}`);
      }
      const result = await response.json();
      setStatus(`Synced ${result.count ?? items.length} bookmarks`);
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      syncBtn.disabled = false;
    }
  }
  syncBtn.addEventListener("click", syncBookmarks);
})();
