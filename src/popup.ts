import { ChromeBookmarksAdapter } from './adapters';

const API_URL = 'http://localhost:3000';

const syncBtn = document.getElementById('sync-btn') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLParagraphElement;

function setStatus(text: string) {
  statusEl.textContent = text;
}

async function syncBookmarks() {
  syncBtn.disabled = true;
  setStatus('Fetching bookmarks...');

  try {
    const adapter = new ChromeBookmarksAdapter();
    const items = await adapter.getAll();

    setStatus(`Sending ${items.length} bookmarks...`);

    const response = await fetch(`${API_URL}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });

    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }

    const result = await response.json();
    setStatus(`Synced ${result.count ?? items.length} bookmarks`);
  } catch (err) {
    setStatus(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
  } finally {
    syncBtn.disabled = false;
  }
}

syncBtn.addEventListener('click', syncBookmarks);
