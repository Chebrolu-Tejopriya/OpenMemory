/**
 * OpenMemory - Supabase Client & Real-time Bookmark Sync
 * Handles incremental bookmark sync with Supabase backend
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Supabase configuration - set these in chrome.storage.local
interface SupabaseConfig {
  url: string;
  anonKey: string;
}

interface BookmarkPayload {
  url: string;
  title: string;
  folder: string | null;
  chrome_id?: string;
}

interface SupabaseBookmark {
  id: string;
  url: string;
  title: string;
  folder: string | null;
  chrome_id: string | null;
  embedding: number[] | null;
  created_at: string;
  updated_at: string;
}

// ============== CONFIGURATION ==============

let cachedConfig: SupabaseConfig | null = null;
let cachedClient: SupabaseClient | null = null;
let cachedClientKey: string | null = null;

async function getSupabaseConfig(): Promise<SupabaseConfig | null> {
  if (cachedConfig) return cachedConfig;

  const stored = await chrome.storage.local.get(['supabaseUrl', 'supabaseAnonKey']);

  if (stored.supabaseUrl && stored.supabaseAnonKey) {
    cachedConfig = {
      url: stored.supabaseUrl,
      anonKey: stored.supabaseAnonKey
    };
    return cachedConfig;
  }

  return null;
}

async function getSupabaseClient(): Promise<SupabaseClient | null> {
  const config = await getSupabaseConfig();
  if (!config) return null;

  const cacheKey = `${config.url}|${config.anonKey}`;
  if (cachedClient && cachedClientKey === cacheKey) {
    return cachedClient;
  }

  cachedClient = createClient(config.url, config.anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
  cachedClientKey = cacheKey;
  return cachedClient;
}

export async function setSupabaseConfig(url: string, anonKey: string): Promise<void> {
  await chrome.storage.local.set({
    supabaseUrl: url,
    supabaseAnonKey: anonKey
  });
  cachedConfig = { url, anonKey };
  console.log('[Supabase] Configuration saved');
}

export async function isSupabaseConfigured(): Promise<boolean> {
  const config = await getSupabaseConfig();
  return config !== null;
}

// ============== API HELPERS ==============

async function supabaseRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<{ data: T | null; error: string | null }> {
  const config = await getSupabaseConfig();

  if (!config) {
    return { data: null, error: 'Supabase not configured' };
  }

  const url = `${config.url}/rest/v1/${endpoint}`;

  const headers: Record<string, string> = {
    'apikey': config.anonKey,
    'Authorization': `Bearer ${config.anonKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
    ...(options.headers as Record<string, string> || {})
  };

  try {
    const response = await fetch(url, {
      ...options,
      headers
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Supabase] Request failed:', response.status, errorText);
      return { data: null, error: `HTTP ${response.status}: ${errorText}` };
    }

    const data = await response.json();
    return { data, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Supabase] Request error:', message);
    return { data: null, error: message };
  }
}

// Call Supabase Edge Function for embedding generation
async function generateEmbedding(text: string): Promise<number[] | null> {
  const config = await getSupabaseConfig();

  if (!config) {
    console.warn('[Supabase] Not configured, skipping embedding generation');
    return null;
  }

  const embeddingUrl = `${config.url}/functions/v1/generate-embedding`;
  console.log('[Supabase] Calling embedding function:', embeddingUrl);

  try {
    const response = await fetch(embeddingUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.anonKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text })
    });

    console.log('[Supabase] Embedding response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Supabase] Embedding generation failed:', response.status, errorText);
      return null;
    }

    const result = await response.json();
    console.log('[Supabase] Embedding result:', result.embedding ? `array of ${result.embedding.length}` : 'null', result.fallback ? '(fallback)' : '');
    return result.embedding || null;
  } catch (err) {
    console.error('[Supabase] Embedding generation error:', err);
    return null;
  }
}

// ============== BOOKMARK SYNC OPERATIONS ==============

/**
 * UPSERT a bookmark to Supabase using URL as unique key
 * Generates embedding only for new items or when title changes
 */
export async function upsertBookmark(
  bookmark: BookmarkPayload,
  forceEmbedding = false
): Promise<{ success: boolean; error?: string }> {
  console.log('[Supabase] upsertBookmark called for:', bookmark.url);

  const config = await getSupabaseConfig();
  console.log('[Supabase] Config:', config ? 'present' : 'missing');

  if (!config) {
    return { success: false, error: 'Supabase not configured' };
  }

  try {
    // First, check if bookmark exists and if title changed
    console.log('[Supabase] Checking if bookmark exists...');
    const { data: existing, error: fetchError } = await supabaseRequest<SupabaseBookmark[]>(
      `bookmarks?url=eq.${encodeURIComponent(bookmark.url)}&select=id,title,embedding`
    );

    if (fetchError) {
      console.error('[Supabase] Error checking existing bookmark:', fetchError);
    }

    const existingBookmark = existing?.[0];
    const titleChanged = existingBookmark && existingBookmark.title !== bookmark.title;
    const needsEmbedding = forceEmbedding || !existingBookmark || titleChanged || !existingBookmark.embedding;

    console.log('[Supabase] Existing:', !!existingBookmark, 'Needs embedding:', needsEmbedding);

    // Generate embedding if needed
    let embedding: number[] | null = null;
    if (needsEmbedding) {
      const textForEmbedding = `${bookmark.title} ${bookmark.folder || ''}`.trim();
      console.log('[Supabase] Generating embedding for text:', textForEmbedding.substring(0, 100));
      embedding = await generateEmbedding(textForEmbedding);
      console.log('[Supabase] Embedding result:', embedding ? `${embedding.length} dimensions` : 'null');
    }

    // Prepare payload
    const payload: Record<string, unknown> = {
      url: bookmark.url,
      title: bookmark.title,
      folder: bookmark.folder,
      chrome_id: bookmark.chrome_id || null,
      updated_at: new Date().toISOString()
    };

    if (embedding) {
      payload.embedding = embedding;
    }

    console.log('[Supabase] Sending upsert request...');

    // UPSERT using Supabase's on_conflict
    const { data, error } = await supabaseRequest<SupabaseBookmark[]>(
      'bookmarks?on_conflict=url',
      {
        method: 'POST',
        headers: {
          'Prefer': 'resolution=merge-duplicates,return=representation'
        },
        body: JSON.stringify(payload)
      }
    );

    if (error) {
      console.error('[Supabase] Upsert error:', error);
      return { success: false, error };
    }

    console.log('[Supabase] Upsert success:', bookmark.url.substring(0, 50));
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Supabase] Exception in upsertBookmark:', message, err);
    return { success: false, error: message };
  }
}

/**
 * Delete a bookmark from Supabase by URL or Chrome ID
 */
export async function deleteBookmark(
  urlOrChromeId: string,
  byField: 'url' | 'chrome_id' = 'url'
): Promise<{ success: boolean; error?: string }> {
  console.log('[Supabase] deleteBookmark called:', { value: urlOrChromeId.substring(0, 50), byField });

  const config = await getSupabaseConfig();

  if (!config) {
    return { success: false, error: 'Supabase not configured' };
  }

  try {
    const endpoint = `bookmarks?${byField}=eq.${encodeURIComponent(urlOrChromeId)}`;
    console.log('[Supabase] Delete endpoint:', endpoint);

    const { error } = await supabaseRequest<null>(
      endpoint,
      { method: 'DELETE' }
    );

    if (error) {
      console.error('[Supabase] Delete error:', error);
      return { success: false, error };
    }

    console.log('[Supabase] Delete successful:', urlOrChromeId.substring(0, 50));
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Supabase] Delete exception:', message);
    return { success: false, error: message };
  }
}

/**
 * Update bookmark metadata (title, folder) and regenerate embedding if title changed
 */
export async function updateBookmark(
  url: string,
  updates: { title?: string; folder?: string }
): Promise<{ success: boolean; error?: string }> {
  const config = await getSupabaseConfig();

  if (!config) {
    return { success: false, error: 'Supabase not configured' };
  }

  try {
    // Get existing bookmark to check if title changed
    const { data: existing } = await supabaseRequest<SupabaseBookmark[]>(
      `bookmarks?url=eq.${encodeURIComponent(url)}&select=id,title,folder`
    );

    if (!existing || existing.length === 0) {
      return { success: false, error: 'Bookmark not found' };
    }

    const existingBookmark = existing[0];
    const titleChanged = updates.title && updates.title !== existingBookmark.title;

    // Prepare payload
    const payload: Record<string, unknown> = {
      ...updates,
      updated_at: new Date().toISOString()
    };

    // Regenerate embedding only if title changed
    if (titleChanged && updates.title) {
      const folder = updates.folder ?? existingBookmark.folder;
      const textForEmbedding = `${updates.title} ${folder || ''}`.trim();
      const embedding = await generateEmbedding(textForEmbedding);

      if (embedding) {
        payload.embedding = embedding;
        console.log('[Supabase] Regenerated embedding due to title change');
      }
    }

    const { error } = await supabaseRequest<SupabaseBookmark[]>(
      `bookmarks?url=eq.${encodeURIComponent(url)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload)
      }
    );

    if (error) {
      return { success: false, error };
    }

    console.log('[Supabase] Updated bookmark:', url.substring(0, 50));
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: message };
  }
}

/**
 * Bulk upsert bookmarks (for initial sync)
 * Processes in batches to avoid overwhelming the API
 */
export async function bulkUpsertBookmarks(
  bookmarks: BookmarkPayload[],
  onProgress?: (processed: number, total: number) => void
): Promise<{ success: number; failed: number }> {
  const BATCH_SIZE = 10;
  let success = 0;
  let failed = 0;

  for (let i = 0; i < bookmarks.length; i += BATCH_SIZE) {
    const batch = bookmarks.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(
      batch.map(b => upsertBookmark(b))
    );

    for (const result of results) {
      if (result.success) {
        success++;
      } else {
        failed++;
      }
    }

    onProgress?.(Math.min(i + BATCH_SIZE, bookmarks.length), bookmarks.length);

    // Small delay between batches to avoid rate limiting
    if (i + BATCH_SIZE < bookmarks.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return { success, failed };
}

/**
 * Get bookmark by URL from Supabase
 */
export async function getBookmarkByUrl(url: string): Promise<SupabaseBookmark | null> {
  const { data } = await supabaseRequest<SupabaseBookmark[]>(
    `bookmarks?url=eq.${encodeURIComponent(url)}&select=*`
  );

  return data?.[0] || null;
}

/**
 * Search bookmarks using vector similarity (requires pgvector)
 */
export async function searchBookmarks(
  query: string,
  limit = 20
): Promise<SupabaseBookmark[]> {
  const config = await getSupabaseConfig();

  if (!config) {
    return [];
  }

  try {
    // Generate embedding for the query
    const queryEmbedding = await generateEmbedding(query);

    if (!queryEmbedding) {
      console.warn('[Supabase] Could not generate query embedding');
      return [];
    }

    // Call RPC function for vector similarity search
    const response = await fetch(`${config.url}/rest/v1/rpc/search_bookmarks`, {
      method: 'POST',
      headers: {
        'apikey': config.anonKey,
        'Authorization': `Bearer ${config.anonKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query_embedding: queryEmbedding,
        match_count: limit
      })
    });

    if (!response.ok) {
      console.error('[Supabase] Search failed:', response.status);
      return [];
    }

    return await response.json();
  } catch (err) {
    console.error('[Supabase] Search error:', err);
    return [];
  }
}

// ============== SYNC STATUS ==============

export interface SyncStatus {
  lastSyncAt: number | null;
  totalSynced: number;
  pendingSync: number;
  syncInProgress: boolean;
}

let syncStatus: SyncStatus = {
  lastSyncAt: null,
  totalSynced: 0,
  pendingSync: 0,
  syncInProgress: false
};

export function getSyncStatus(): SyncStatus {
  return { ...syncStatus };
}

export function updateSyncStatus(updates: Partial<SyncStatus>): void {
  syncStatus = { ...syncStatus, ...updates };
}

// ============== PINTEREST PIN SYNC OPERATIONS ==============

export interface PinterestPinPayload {
  pin_id: string;
  board_name: string;
  board_url?: string;
  title?: string;
  description?: string;
  pin_url: string;
  image_url?: string;
  image?: string;
}

export interface PinterestBoardRow {
  id?: string;
  board_name: string | null;
  board_url: string;
  total_pins: number | null;
  imported_pins: number | null;
  last_synced_at: string | null;
}

export interface PinterestPinInsert {
  pin_id: string;
  pin_url: string;
  image_url: string;
  title: string;
  description: string | null;
  board_name: string;
  board_url: string;
  created_at: string;
}

interface SupabasePinterestPin {
  id: string;
  pin_id: string;
  board_name: string;
  board_url: string | null;
  title: string | null;
  description: string | null;
  pin_url: string;
  image_url: string | null;
  image: string | null;
  embedding: number[] | null;
  similarity?: number;
  synced_at: string;
}

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

async function getSupabaseCount(endpoint: string): Promise<number> {
  const config = await getSupabaseConfig();
  if (!config) return 0;

  try {
    const response = await fetch(`${config.url}/rest/v1/${endpoint}`, {
      headers: {
        'apikey': config.anonKey,
        'Authorization': `Bearer ${config.anonKey}`,
        'Prefer': 'count=exact'
      }
    });

    if (!response.ok) return 0;

    const countHeader = response.headers.get('content-range');
    if (countHeader) {
      const match = countHeader.match(/\/(\d+)/);
      if (match) return parseInt(match[1], 10);
    }
    return 0;
  } catch {
    return 0;
  }
}

/**
 * UPSERT a Pinterest pin to Supabase using pin_url as unique key
 */
export async function upsertPinterestPin(
  pin: PinterestPinPayload,
  forceEmbedding = false
): Promise<{ success: boolean; error?: string }> {
  const config = await getSupabaseConfig();

  if (!config) {
    return { success: false, error: 'Supabase not configured' };
  }

  try {
    // Check if pin exists and if title changed
    const { data: existing } = await supabaseRequest<SupabasePinterestPin[]>(
      `pinterest_pins?pin_url=eq.${encodeURIComponent(pin.pin_url)}&select=id,title,embedding`
    );

    const existingPin = existing?.[0];
    const titleChanged = existingPin && existingPin.title !== pin.title;
    const needsEmbedding = forceEmbedding || !existingPin || titleChanged || !existingPin.embedding;

    // Generate embedding if needed (non-blocking)
    let embedding: number[] | null = null;
    if (needsEmbedding) {
      const textForEmbedding = `${pin.title || ''} ${pin.description || ''} ${pin.board_name}`.trim();
      if (textForEmbedding.length > 0) {
        try {
          embedding = await generateEmbedding(textForEmbedding);
        } catch {
          embedding = null;
        }
        console.log('Embedding success:', !!embedding);
      }
    }

    // Prepare payload
    const payload: Record<string, unknown> = {
      pin_id: pin.pin_id,
      board_name: pin.board_name,
      board_url: pin.board_url || null,
      title: pin.title || null,
      description: pin.description || null,
      pin_url: pin.pin_url,
      image_url: pin.image_url || null,
      image: pin.image || null,
      synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    if (embedding) {
      payload.embedding = embedding;
    }

    // UPSERT using Supabase's on_conflict
    const requestPayload = { ...payload, embedding: embedding || null };

    const { error } = await supabaseRequest<SupabasePinterestPin[]>(
      'pinterest_pins?on_conflict=pin_url',
      {
        method: 'POST',
        headers: {
          'Prefer': 'resolution=merge-duplicates,return=representation'
        },
        body: JSON.stringify(requestPayload)
      }
    );

    if (error) {
      console.log({ pin_url: pin.pin_url, error });
      return { success: false, error };
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.log({ pin_url: pin.pin_url, error: message });
    return { success: false, error: message };
  }
}

// ============== PINTEREST BOARD TRACKING ==============

export async function upsertPinterestBoard(
  board: Omit<PinterestBoardRow, 'id'>
): Promise<{ success: boolean; error?: string }> {
  const client = await getSupabaseClient();
  if (!client) {
    return { success: false, error: 'Supabase not configured' };
  }

  try {
    const { error } = await client
      .from('pinterest_boards')
      .upsert({
        board_name: board.board_name,
        board_url: board.board_url,
        total_pins: board.total_pins,
        imported_pins: board.imported_pins,
        last_synced_at: board.last_synced_at
      }, { onConflict: 'board_url' });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: message };
  }
}

export async function getPinterestBoards(): Promise<PinterestBoardRow[]> {
  const client = await getSupabaseClient();
  if (!client) return [];

  const { data, error } = await client
    .from('pinterest_boards')
    .select('board_name,board_url,total_pins,imported_pins,last_synced_at')
    .order('last_synced_at', { ascending: false, nullsFirst: false });

  if (error || !data) return [];
  return data as PinterestBoardRow[];
}

export async function getPinterestPinsCountByBoard(boardUrl: string): Promise<number> {
  const client = await getSupabaseClient();
  if (!client) return 0;

  const { count, error } = await client
    .from('pinterest_pins')
    .select('pin_url', { count: 'exact', head: true })
    .eq('board_url', boardUrl);

  if (error) return 0;
  return count ?? 0;
}

export async function getExistingPinterestPinUrls(pinUrls: string[]): Promise<Set<string>> {
  if (pinUrls.length === 0) return new Set();
  const client = await getSupabaseClient();
  if (!client) return new Set();

  const existing = new Set<string>();
  const chunks = chunkArray(pinUrls, 50);

  for (const chunk of chunks) {
    const { data, error } = await client
      .from('pinterest_pins')
      .select('pin_url')
      .in('pin_url', chunk);

    if (!error && data) {
      data.forEach((row: { pin_url: string }) => existing.add(row.pin_url));
    }
  }

  return existing;
}

export async function bulkInsertPinterestPins(
  pins: PinterestPinInsert[]
): Promise<{ success: number; failed: number }>
{
  const client = await getSupabaseClient();
  if (!client) return { success: 0, failed: pins.length };

  const BATCH_SIZE = 50;
  let success = 0;
  let failed = 0;

  for (let i = 0; i < pins.length; i += BATCH_SIZE) {
    const batch = pins.slice(i, i + BATCH_SIZE);
    const { error, data } = await client
      .from('pinterest_pins')
      .insert(batch)
      .select('id');

    if (error) {
      failed += batch.length;
      batch.forEach(pin => console.log({ pin_url: pin.pin_url, error: error.message }));
    } else {
      success += data ? data.length : batch.length;
    }
  }

  return { success, failed };
}

export async function resyncPinterestBoard(
  boardUrl: string,
  pins: PinterestPinInsert[],
  boardName?: string,
  totalPins?: number | null
): Promise<{ added: number; total: number }>
{
  const existingUrls = await getExistingPinterestPinUrls(pins.map(pin => pin.pin_url));
  const newPins = pins.filter(pin => !existingUrls.has(pin.pin_url));

  let added = 0;
  if (newPins.length > 0) {
    const result = await bulkInsertPinterestPins(newPins);
    added = result.success;
  }

  const total = await getPinterestPinsCountByBoard(boardUrl);
  await upsertPinterestBoard({
    board_name: boardName || null,
    board_url: boardUrl,
    total_pins: totalPins ?? null,
    imported_pins: total,
    last_synced_at: new Date().toISOString()
  });

  return { added, total };
}

export async function getPinterestNullEmbeddingCount(): Promise<number> {
  const client = await getSupabaseClient();
  if (!client) return 0;

  const { count, error } = await client
    .from('pinterest_pins')
    .select('id', { count: 'exact', head: true })
    .is('embedding', null);

  if (error) return 0;
  return count ?? 0;
}

/**
 * Bulk upsert Pinterest pins (for sync)
 */
export async function bulkUpsertPinterestPins(
  pins: PinterestPinPayload[],
  onProgress?: (processed: number, total: number) => void
): Promise<{ success: number; failed: number }> {
  const BATCH_SIZE = 10;
  let success = 0;
  let failed = 0;

  for (let i = 0; i < pins.length; i += BATCH_SIZE) {
    const batch = pins.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(
      batch.map(p => upsertPinterestPin(p))
    );

    for (const result of results) {
      if (result.success) {
        success++;
      } else {
        failed++;
      }
    }

    onProgress?.(Math.min(i + BATCH_SIZE, pins.length), pins.length);

    // Small delay between batches to avoid rate limiting
    if (i + BATCH_SIZE < pins.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return { success, failed };
}

/**
 * Search Pinterest pins using vector similarity
 */
export async function searchPinterestPins(
  query: string,
  limit = 20,
  board?: string
): Promise<SupabasePinterestPin[]> {
  const config = await getSupabaseConfig();

  if (!config) {
    return [];
  }

  try {
    // Generate embedding for the query
    const queryEmbedding = await generateEmbedding(query);

    if (!queryEmbedding) {
      console.warn('[Supabase] Could not generate query embedding for Pinterest search');
      return searchPinterestPinsText(query, limit, board);
    }

    // Call RPC function for vector similarity search
    const response = await fetch(`${config.url}/rest/v1/rpc/search_pinterest_pins`, {
      method: 'POST',
      headers: {
        'apikey': config.anonKey,
        'Authorization': `Bearer ${config.anonKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query_embedding: queryEmbedding,
        match_count: limit,
        filter_board: board || null
      })
    });

    if (!response.ok) {
      console.error('[Supabase] Pinterest search failed:', response.status);
      return searchPinterestPinsText(query, limit, board);
    }

    return await response.json();
  } catch (err) {
    console.error('[Supabase] Pinterest search error:', err);
    return [];
  }
}

/**
 * Text-based search fallback for Pinterest pins
 */
async function searchPinterestPinsText(
  query: string,
  limit = 20,
  board?: string
): Promise<SupabasePinterestPin[]> {
  const config = await getSupabaseConfig();

  if (!config) {
    return [];
  }

  try {
    const response = await fetch(`${config.url}/rest/v1/rpc/search_pinterest_pins_text`, {
      method: 'POST',
      headers: {
        'apikey': config.anonKey,
        'Authorization': `Bearer ${config.anonKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        search_query: query,
        match_count: limit,
        filter_board: board || null
      })
    });

    if (!response.ok) return [];
    return await response.json();
  } catch {
    return [];
  }
}

/**
 * Search all items (bookmarks + pinterest pins) using combined vector search
 */
export async function searchAllItems(
  query: string,
  limit = 50,
  folder?: string
): Promise<Array<{
  source: 'chrome' | 'pinterest';
  item_id: string;
  url: string;
  title: string;
  folder_or_board: string | null;
  image_url: string | null;
  similarity: number;
}>> {
  const config = await getSupabaseConfig();

  if (!config) {
    return [];
  }

  try {
    const queryEmbedding = await generateEmbedding(query);

    if (!queryEmbedding) {
      console.warn('[Supabase] Could not generate query embedding');
      return [];
    }

    const response = await fetch(`${config.url}/rest/v1/rpc/search_all_items`, {
      method: 'POST',
      headers: {
        'apikey': config.anonKey,
        'Authorization': `Bearer ${config.anonKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query_embedding: queryEmbedding,
        match_count: limit,
        filter_folder: folder || null
      })
    });

    if (!response.ok) {
      console.error('[Supabase] Combined search failed:', response.status);
      return [];
    }

    return await response.json();
  } catch (err) {
    console.error('[Supabase] Combined search error:', err);
    return [];
  }
}

/**
 * Get Pinterest pin count from Supabase
 */
export async function getPinterestPinCount(): Promise<number> {
  const config = await getSupabaseConfig();
  if (!config) return 0;

  try {
    const response = await fetch(`${config.url}/rest/v1/pinterest_pins?select=count`, {
      headers: {
        'apikey': config.anonKey,
        'Authorization': `Bearer ${config.anonKey}`,
        'Prefer': 'count=exact'
      }
    });

    if (!response.ok) return 0;

    const countHeader = response.headers.get('content-range');
    if (countHeader) {
      const match = countHeader.match(/\/(\d+)/);
      if (match) return parseInt(match[1], 10);
    }
    return 0;
  } catch {
    return 0;
  }
}
