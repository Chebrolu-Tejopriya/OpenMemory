import { db } from './db';
import { readXBookmarksPage, validBookmarkPage, validateBrowserPosts } from './x-browser';

export const X_SYNC_ALARM = 'xBookmarkSync';
const KEY = 'xBrowserConnection';
const INTERVAL = 15 * 60000;
interface Connection {
  enabled: boolean; paused: boolean; username?: string;
  lastSyncAt?: number; nextSyncAt?: number; error?: string;
  run?: { id: string; tabId: number; startedAt: number; owned: boolean };
}
let operation: Promise<void> | null = null;
const read = async (): Promise<Connection | undefined> => (await chrome.storage.local.get(KEY))[KEY];
const save = async (value: Connection) => { await chrome.storage.local.set({ [KEY]: value }); };
function exclusive(action: () => Promise<void>): Promise<void> {
  const next = (operation || Promise.resolve()).catch(() => {}).then(action);
  operation = next;
  void next.finally(() => { if (operation === next) operation = null; }).catch(() => {});
  return next;
}
async function closeRun(state: Connection) {
  const run = state.run;
  state.run = undefined;
  await save(state);
  if (run?.owned) {
    try { const tab = await chrome.tabs.get(run.tabId); if (!tab.active && validBookmarkPage(tab.url)) await chrome.tabs.remove(run.tabId); } catch { /* Already closed. */ }
  }
}
export async function scheduleXSync() {
  const state = await read();
  if (!state?.enabled || state.paused) { await chrome.alarms.clear(X_SYNC_ALARM); return; }
  await chrome.alarms.create(X_SYNC_ALARM, { when: Math.max(Date.now() + 1000, state.nextSyncAt || 0), periodInMinutes: 15 });
}
export function connectX(): Promise<void> {
  return exclusive(async () => {
    const previous = await read();
    if (previous) await closeRun(previous);
    const legacy = (await chrome.storage.local.get('xConnection')).xConnection;
    if (!previous && !legacy?.username) await db.xBookmarks.clear();
    await chrome.storage.local.remove(['xConnection', 'xClientId']);
    const state: Connection = { ...previous, username: previous?.username || legacy?.username?.toLowerCase(),
      enabled: true, paused: false, error: undefined, nextSyncAt: 0, run: undefined };
    await save(state);
    await startRun(state, true);
  });
}
async function startRun(state: Connection, interactive: boolean) {
  const tab = await chrome.tabs.create({ url: 'https://x.com/i/bookmarks', active: interactive });
  if (tab.id === undefined) throw new Error('Could not open X bookmarks.');
  state.run = { id: crypto.randomUUID(), tabId: tab.id, startedAt: Date.now(), owned: !interactive };
  state.nextSyncAt = Date.now() + INTERVAL;
  state.error = undefined;
  await save(state);
  await scheduleXSync();
  if ((await chrome.tabs.get(tab.id)).status === 'complete') void attachXReader(tab.id);
}
export function syncX(manual = false): Promise<void> {
  return exclusive(async () => {
    const state = await read();
    if (!state?.enabled || state.paused) return;
    if (state.run) {
      if (Date.now() - state.run.startedAt < 12 * 60000) return;
      await closeRun(state);
    }
    if (!manual && (state.nextSyncAt || 0) > Date.now()) return;
    await startRun(state, false);
  });
}
export async function xStatus() {
  const state = await read();
  const cloud = await chrome.storage.local.get(['xCloudEnabled', 'xCloudStatus']);
  return { connected: !!state?.enabled, username: state?.username, paused: state?.paused,
    syncing: !!state?.run, lastSyncAt: state?.lastSyncAt, nextSyncAt: state?.nextSyncAt,
    error: state?.error, count: await db.xBookmarks.count(), mode: 'browser',
    cloudEnabled: !!cloud.xCloudEnabled, cloud: cloud.xCloudStatus || null };
}
export function pauseX(paused: boolean) {
  return exclusive(async () => {
    const state = await read();
    if (state) {
      state.paused = paused;
      await closeRun(state);
      if (!paused) state.nextSyncAt = 0;
      await save(state);
    }
    await scheduleXSync();
  });
}
export function disconnectX() {
  return exclusive(async () => {
    const state = await read();
    if (state) await closeRun(state);
    await chrome.storage.local.remove([KEY, 'xConnection', 'xClientId']);
    await chrome.alarms.clear(X_SYNC_ALARM);
    await db.xBookmarks.clear();
  });
}
export async function attachXReader(tabId: number) {
  const state = await read();
  if (!state?.enabled || state.paused || state.run?.tabId !== tabId) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!validBookmarkPage(tab.url)) {
      await exclusive(async () => {
        const current = await read();
        if (!current?.run || current.run.id !== state.run?.id) return;
        current.paused = true;
        current.error = 'X needs attention. Sign in and open bookmarks, then reconnect to resume.';
        await closeRun(current);
        await scheduleXSync();
      });
      return;
    }
    await chrome.scripting.executeScript({ target: { tabId }, func: readXBookmarksPage, args: [state.run.id] });
  } catch {
    await exclusive(async () => {
      const current = await read();
      if (current?.run?.id !== state.run?.id) return;
      current!.error = 'Could not read X. Open X, sign in, then reconnect.';
      await closeRun(current!);
    });
  }
}
export async function handleXBrowserBatch(message: any, sender: chrome.runtime.MessageSender): Promise<{ success: boolean; stop?: boolean }> {
  let response = { success: false, stop: true };
  await exclusive(async () => {
    const state = await read();
    if (!state?.enabled || state.paused || !state.run || sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
        sender.tab?.id !== state.run?.tabId || message.runId !== state.run?.id || !validBookmarkPage(sender.url)) return;
    if (Date.now() - state.run!.startedAt > 12 * 60000) { await closeRun(state); return; }
    const username = typeof message.username === 'string' && /^[a-zA-Z0-9_]{1,15}$/.test(message.username) ? message.username.toLowerCase() : '';
    if (!username) {
      state.paused = true;
      state.error = 'Sign in to X in the opened tab, then reconnect. Your account could not be verified.';
      await closeRun(state); await scheduleXSync(); return;
    }
    if (state.username && state.username !== username) {
      state.paused = true;
      state.error = `X account changed. Switch back to @${state.username}, or disconnect before connecting a different account.`;
      await closeRun(state); await scheduleXSync(); return;
    }
    const posts = validateBrowserPosts(message.posts);
    state.username = username;
    await db.transaction('rw', db.xBookmarks, async () => {
      for (const post of posts) {
        const existing = await db.xBookmarks.get(post.id);
        await db.xBookmarks.put({ ...post, indexedAt: existing?.indexedAt || post.indexedAt,
          cloudHash: existing?.cloudHash, cloudProject: existing?.cloudProject,
          imageUrl: post.imageUrl || existing?.imageUrl,
          extendedContent: (existing?.extendedContent.length || 0) > post.extendedContent.length ? existing!.extendedContent : post.extendedContent });
      }
    });
    state.error = undefined;
    response = { success: true, stop: false };
    if (message.done) {
      state.lastSyncAt = Date.now();
      if (message.reason === 'limit') state.error = 'Scan time limit reached. Imported posts are saved; more may remain on X.';
      if (message.reason === 'empty') state.error = 'No readable posts found. Check that your bookmarks loaded in X.';
      await closeRun(state);
      response.stop = true;
    } else await save(state);
  });
  return response;
}
export function xTabClosed(tabId: number) {
  return exclusive(async () => {
    const state = await read();
    if (state?.run?.tabId === tabId) {
      state.run = undefined;
      state.error = 'X tab closed before the scan finished. Imported posts are saved; automatic sync will retry.';
      await save(state);
    }
  });
}
