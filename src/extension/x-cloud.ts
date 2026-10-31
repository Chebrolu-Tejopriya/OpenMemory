import { db } from './db';
import { embeddingBackendUrl } from './embedding-jobs';
import type { XBookmark } from './x-api';

export const X_CLOUD_ALARM = 'xCloudSync';
let flushing: Promise<void> | null = null;
let cloudController: AbortController | null = null;
const content = (post: XBookmark, username: string) => JSON.stringify([username, post.id, post.title, post.extendedContent, post.author, post.imageUrl || '']);
export async function xCloudFingerprint(post: XBookmark, username: string): Promise<string> {
  const bytes = new TextEncoder().encode(content(post, username));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
export async function setXCloudEnabled(enabled: boolean) {
  if (!enabled) cloudController?.abort();
  await chrome.storage.local.set({ xCloudEnabled: enabled });
  if (enabled) {
    await chrome.alarms.create(X_CLOUD_ALARM, { when: Date.now() + 1000, periodInMinutes: 1 });
  } else await chrome.alarms.clear(X_CLOUD_ALARM);
}
export async function scheduleXCloudSync() {
  if ((await chrome.storage.local.get('xCloudEnabled')).xCloudEnabled) {
    await chrome.alarms.create(X_CLOUD_ALARM, { when: Date.now() + 1000, periodInMinutes: 1 });
  }
}
export function flushXCloud(): Promise<void> {
  if (flushing) return flushing;
  flushing = run().finally(() => { flushing = null; });
  return flushing;
}
async function run() {
  const settings = await chrome.storage.local.get(['xCloudEnabled', 'xBrowserConnection', 'supabaseUrl', 'supabaseAnonKey', 'xCloudStatus']);
  const connection = settings.xBrowserConnection;
  if (!settings.xCloudEnabled || !connection?.enabled || connection.paused || !connection.username) return;
  const status = settings.xCloudStatus || {};
  if (status.retryAt > Date.now()) return;
  const base = settings.supabaseUrl?.replace(/\/$/, '');
  if (!base || !settings.supabaseAnonKey) {
    await chrome.storage.local.set({ xCloudStatus: { error: 'Configure Supabase to sync X to the web app.' } }); return;
  }
  cloudController = new AbortController();
  const signal = (ms: number) => AbortSignal.any([cloudController!.signal, AbortSignal.timeout(ms)]);
  try {
    const posts = await db.xBookmarks.toArray();
    const hashes = await Promise.all(posts.map(post => xCloudFingerprint(post, connection.username)));
    const pending = posts.map((post, i) => ({ post, hash: hashes[i] }))
      .filter(({ post, hash }) => post.cloudProject !== base || post.cloudHash !== hash).slice(0, 50);
    if (pending.length) {
      const payload = pending.map(({ post }) => ({ account_username: connection.username, post_id: post.id,
        url: post.url, title: post.title, description: post.extendedContent, author: post.author, image_url: post.imageUrl || null }));
      const response = await fetch(`${base}/rest/v1/x_bookmarks?on_conflict=account_username,post_id`, {
        method: 'POST', headers: { apikey: settings.supabaseAnonKey, Authorization: `Bearer ${settings.supabaseAnonKey}`,
          'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(payload), signal: signal(20000)
      });
      if (!response.ok) throw new Error(response.status === 404
        ? 'X table is not installed. Apply the X bookmarks migration first.'
        : `X upload rejected (${response.status}). Check the configured project and its access policies.`);
      await db.transaction('rw', db.xBookmarks, async () => {
        for (const { post, hash } of pending) {
          const current = await db.xBookmarks.get(post.id);
          // Keep a concurrently enriched post pending instead of acknowledging data never sent.
          if (current && content(current, connection.username) === content(post, connection.username)) {
            await db.xBookmarks.put({ ...current, cloudHash: hash, cloudProject: base });
          }
        }
      });
    }
    // NULL vectors in the database are the durable queue; repeated triggers are idempotent.
    const response = await fetch(`${await embeddingBackendUrl()}/run-x-embeddings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supabase_url: base }), signal: signal(75000)
    });
    const job = await response.json();
    if (!response.ok || job.accepted !== true) throw new Error(job.error || 'X uploads saved; the embedding backend needs updating.');
    const progressResponse = await fetch(`${await embeddingBackendUrl()}/x-embedding-status`, { signal: signal(15000), cache: 'no-store' });
    const progress = progressResponse.ok ? await progressResponse.json() : null;
    await chrome.storage.local.set({ xCloudStatus: { uploadedAt: Date.now(), pending: Math.max(0, posts.length - posts.filter((post, i) => post.cloudProject === base && post.cloudHash === hashes[i]).length - pending.length),
      textQueued: true, progress, error: progress?.job?.error, retryAt: 0 } });
  } catch (error) {
    if (cloudController?.signal.aborted) return;
    await chrome.storage.local.set({ xCloudStatus: { ...status,
      error: error instanceof Error ? error.message : 'X cloud sync failed.', retryAt: Date.now() + 60000 } });
  } finally { cloudController = null; }
}
