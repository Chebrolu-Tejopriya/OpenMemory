import { canonicalPinterestBoardUrl } from './pinterest-import-policy';

export const DEFAULT_EMBEDDING_BACKEND = 'https://openmemory-backend-j775.onrender.com';

export async function embeddingBackendUrl(): Promise<string> {
  const settings = await chrome.storage.local.get(['backendUrl']);
  return (settings.backendUrl || DEFAULT_EMBEDDING_BACKEND).replace(/\/$/, '');
}

export async function requestPinterestEmbeddingJob(boardUrl: string): Promise<{ accepted: boolean; error?: string }> {
  try {
    const response = await fetch(`${await embeddingBackendUrl()}/run-embeddings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ board_url: canonicalPinterestBoardUrl(boardUrl) }), signal: AbortSignal.timeout(20000)
    });
    const result = await response.json();
    // Old deployments returned success without doing any work; don't accept that response.
    if (!response.ok || result.accepted !== true) throw new Error(result.error || 'The backend embedding worker is not available yet.');
    return { accepted: true };
  } catch (error) { return { accepted: false, error: error instanceof Error ? error.message : 'Could not start embeddings' }; }
}

export async function pinterestEmbeddingStatus(boardUrl: string): Promise<{ total: number; textMissing: number; imageMissing: number; job?: {running: boolean; error?: string} }> {
  const response = await fetch(`${await embeddingBackendUrl()}/embedding-status?board_url=${encodeURIComponent(canonicalPinterestBoardUrl(boardUrl))}`, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
  if (!response.ok) throw new Error('Could not check embedding progress');
  return response.json();
}
