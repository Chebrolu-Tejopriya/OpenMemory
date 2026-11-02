import { db } from './db';
import { readXBookmarksPage, validBookmarkPage, validateBrowserPosts } from './x-browser';

export const X_SYNC_ALARM = 'xBookmarkSync';
const KEY = 'xBrowserConnection';
interface ScanCheckpoint {
  tabId?: number; owned: boolean; pageId?: string; afterPostId?: string; scrollY?: number; replaying?: boolean;
}
interface Connection {
  enabled: boolean; paused: boolean; username?: string;
  lastSyncAt?: number; nextSyncAt?: number; error?: string;
  note?: string;
  continuation?: ScanCheckpoint;
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
async function closeRun(state: Connection, preserveCheckpoint = false) {
  const run = state.run || (state.continuation?.tabId !== undefined ? state.continuation : undefined);
  if (state.run && preserveCheckpoint) state.continuation = { ...state.continuation, tabId: state.run.tabId, owned: state.run.owned };
  state.run = undefined;
  if (!preserveCheckpoint) state.continuation = undefined;
  await save(state);
  if (run?.owned) {
    try {
      const tab = await chrome.tabs.get(run.tabId!);
      if (!tab.active && validBookmarkPage(tab.url)) {
        if (state.continuation) { state.continuation.tabId = undefined; state.continuation.pageId = undefined; await save(state); }
        await chrome.tabs.remove(run.tabId!);
      }
    } catch { /* Already closed. */ }
  }
}
export async function scheduleXSync() {
  // Remove alarms left behind by versions with automatic browser scanning.
  await chrome.alarms.clear(X_SYNC_ALARM);
}
export function resetXScanOnStartup() {
  return exclusive(async () => {
    const state = await read();
    if (state) {
      state.nextSyncAt = undefined;
      state.note = undefined;
      await closeRun(state, true);
    }
    await scheduleXSync();
  });
}
export function connectX(): Promise<void> {
  return exclusive(async () => {
    const previous = await read();
    if (previous) await closeRun(previous, true);
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
  let tab: chrome.tabs.Tab | undefined;
  if (!interactive && state.continuation?.tabId !== undefined) {
    try {
      const existing = await chrome.tabs.get(state.continuation.tabId);
      if (validBookmarkPage(existing.url) && !existing.discarded) tab = existing;
    } catch { /* Reopen and replay to the saved bookmark if the tab was closed. */ }
  }
  const reused = !!tab;
  tab ||= await chrome.tabs.create({ url: 'https://x.com/i/bookmarks', active: interactive });
  if (tab.id === undefined) throw new Error('Could not open X bookmarks.');
  state.run = { id: crypto.randomUUID(), tabId: tab.id, startedAt: Date.now(), owned: reused ? !!state.continuation?.owned : !interactive };
  state.nextSyncAt = undefined;
  state.error = undefined;
  state.note = state.continuation ? 'Continuing older bookmarks…' : undefined;
  await save(state);
  await scheduleXSync();
  if ((await chrome.tabs.get(tab.id)).status === 'complete') void attachXReader(tab.id);
}
export function syncX(manual = false): Promise<void> {
  return exclusive(async () => {
    if (!manual) { await scheduleXSync(); return; }
    const state = await read();
    if (!state?.enabled || (state.paused && !manual)) return;
    if (manual) state.paused = false;
    if (state.run) {
      if (!manual && Date.now() - state.run.startedAt < 12 * 60000) return;
      state.continuation = { ...state.continuation, tabId: state.run.tabId, owned: state.run.owned };
      state.run = undefined;
    }
    // Recover the last visible batch from beta versions that did not save a cursor.
    if (!state.continuation && state.error?.startsWith('Scan time limit reached')) {
      const posts = await db.xBookmarks.toArray();
      const latest = posts.reduce<typeof posts[number] | undefined>((last, post) => !last || post.indexedAt >= last.indexedAt ? post : last, undefined);
      if (latest) state.continuation = { owned: false, afterPostId: latest.id, replaying: true };
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
    error: state?.error, note: state?.note, continuing: !!state?.continuation, count: await db.xBookmarks.count(), mode: 'browser',
    cloudEnabled: !!cloud.xCloudEnabled, cloud: cloud.xCloudStatus || null };
}
export function pauseX(paused: boolean) {
  return exclusive(async () => {
    const state = await read();
    if (state) {
      state.paused = paused;
      await closeRun(state, true);
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
        await closeRun(current, true);
        await scheduleXSync();
      });
      return;
    }
    await chrome.scripting.executeScript({ target: { tabId }, func: readXBookmarksPage, args: [state.run.id, state.continuation || null] });
  } catch {
    await exclusive(async () => {
      const current = await read();
      if (current?.run?.id !== state.run?.id) return;
      current!.error = 'Could not read X. Open X, sign in, then reconnect.';
      await closeRun(current!, true);
    });
  }
}
export async function handleXBrowserBatch(message: any, sender: chrome.runtime.MessageSender): Promise<{ success: boolean; stop?: boolean }> {
  let response = { success: false, stop: true };
  await exclusive(async () => {
    const state = await read();
    if (!state?.enabled || state.paused || !state.run || sender.id !== chrome.runtime.id || sender.frameId !== 0 ||
        sender.tab?.id !== state.run?.tabId || message.runId !== state.run?.id || !validBookmarkPage(sender.url)) return;
    if (Date.now() - state.run!.startedAt > 12 * 60000) {
      state.continuation = { ...state.continuation, tabId: state.run.tabId, owned: state.run.owned };
      state.nextSyncAt = undefined;
      state.note = 'Progress saved. Click Sync X to continue.';
      await closeRun(state, true); await scheduleXSync(); return;
    }
    const username = typeof message.username === 'string' && /^[a-zA-Z0-9_]{1,15}$/.test(message.username) ? message.username.toLowerCase() : '';
    if (!username) {
      state.paused = true;
      state.error = 'Sign in to X in the opened tab, then reconnect. Your account could not be verified.';
      await closeRun(state, true); await scheduleXSync(); return;
    }
    if (state.username && state.username !== username) {
      state.paused = true;
      state.error = `X account changed. Switch back to @${state.username}, or disconnect before connecting a different account.`;
      await closeRun(state, true); await scheduleXSync(); return;
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
    const checkpoint = message.checkpoint;
    if (checkpoint && typeof checkpoint.pageId === 'string' && checkpoint.pageId.length <= 80 &&
        (checkpoint.afterPostId === undefined || /^\d{1,25}$/.test(checkpoint.afterPostId)) &&
        typeof checkpoint.scrollY === 'number' && Number.isFinite(checkpoint.scrollY) && checkpoint.scrollY >= 0) {
      state.continuation = { tabId: state.run.tabId, owned: state.run.owned, pageId: checkpoint.pageId,
        afterPostId: checkpoint.afterPostId, scrollY: checkpoint.scrollY, replaying: !!checkpoint.replaying };
    }
    response = { success: true, stop: false };
    if (message.done) {
      if (message.reason === 'limit') {
        state.continuation = { ...state.continuation, tabId: state.run.tabId, owned: state.run.owned };
        state.note = 'Progress saved. Click Sync X to continue.';
        state.nextSyncAt = undefined;
        await closeRun(state, true); await scheduleXSync();
        response.stop = true;
        return;
      }
      state.lastSyncAt = Date.now();
      state.note = undefined;
      if (message.reason === 'empty') state.error = 'No readable posts found. Check that your bookmarks loaded in X.';
      if (message.reason === 'view') state.error = 'X Bookmarks view could not be verified. Other History tabs were not imported.';
      await closeRun(state);
      response.stop = true;
    } else await save(state);
  });
  return response;
}
export function xTabClosed(tabId: number) {
  return exclusive(async () => {
    const state = await read();
    if (state && (state.run?.tabId === tabId || state.continuation?.tabId === tabId)) {
      if (state.run) state.continuation = { ...state.continuation, owned: state.run.owned };
      if (state.continuation) { state.continuation.tabId = undefined; state.continuation.pageId = undefined; }
      state.run = undefined;
      state.note = 'Progress saved. The next sync will resume older bookmarks.';
      await save(state);
    }
  });
}
