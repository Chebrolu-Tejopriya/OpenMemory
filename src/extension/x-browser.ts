import type { XBookmark } from './x-api';

export function validBookmarkPage(value?: string): boolean {
  try {
    const url = new URL(value || '');
    return url.protocol === 'https:' && ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname) &&
      /^\/i\/bookmarks\/?$/.test(url.pathname);
  } catch { return false; }
}
export function validateBrowserPosts(value: unknown): XBookmark[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid X bookmark batch.');
  return value.map(post => {
    if (!post || typeof post.id !== 'string' || !/^\d{1,25}$/.test(post.id) ||
        typeof post.extendedContent !== 'string' || typeof post.title !== 'string') throw new Error('Invalid X post.');
    let imageUrl: string | undefined;
    try {
      const url = new URL(post.imageUrl);
      if (url.protocol === 'https:' && ['pbs.twimg.com', 'video.twimg.com'].includes(url.hostname)) imageUrl = url.href;
    } catch { /* No media. */ }
    return { id: post.id, url: `https://x.com/i/status/${post.id}`, title: post.title.slice(0, 180),
      folder: 'X bookmarks', extendedContent: post.extendedContent.slice(0, 30000), contentType: 'x',
      indexStatus: 'indexed', indexedAt: Date.now(), author: typeof post.author === 'string' ? post.author.slice(0, 100) : 'X', imageUrl };
  });
}

/** Serialized by executeScript; every helper must be declared inside this function. */
export function readXBookmarksPage(runId: string): void {
  const scope = globalThis as typeof globalThis & { __openMemoryXReader?: string };
  if (scope.__openMemoryXReader === runId) return;
  scope.__openMemoryXReader = runId;
  const started = Date.now();
  let stopped = false, running = false, observed = 0, idleRounds = 0;
  const sent = new Map<string, string>();
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const onBookmarks = () => /^\/i\/bookmarks\/?$/.test(location.pathname);
  function account(): string {
    const profile = document.querySelector<HTMLAnchorElement>('a[data-testid="AppTabBar_Profile_Link"]');
    const path = profile?.getAttribute('href')?.match(/^\/([a-zA-Z0-9_]{1,15})\/?$/);
    if (path) return path[1];
    return document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')?.textContent?.match(/@([a-zA-Z0-9_]{1,15})\b/)?.[1] || '';
  }
  function collect() {
    const posts: Array<{ id: string; title: string; extendedContent: string; author: string; imageUrl?: string }> = [];
    const primary = document.querySelector('[data-testid="primaryColumn"]');
    for (const article of Array.from(primary?.querySelectorAll('article[data-testid="tweet"]') || [])) {
      const time = article.querySelector('time');
      const permalink = time?.closest('a')?.getAttribute('href');
      const match = permalink?.match(/^\/([a-zA-Z0-9_]+)\/status\/(\d+)/);
      if (!match) continue;
      const textNode = article.querySelector('[data-testid="tweetText"]');
      const text = textNode?.textContent?.trim() || '';
      const author = `@${match[1]}`;
      const links = Array.from(textNode?.querySelectorAll<HTMLAnchorElement>('a[href]') || []).map(a => a.href).join(' ');
      const imageUrl = article.querySelector<HTMLImageElement>('[data-testid="tweetPhoto"] img')?.src;
      const imageAlt = article.querySelector<HTMLImageElement>('[data-testid="tweetPhoto"] img')?.alt || '';
      const title = text || imageAlt || `Post by ${author}`;
      const post = { id: match[2], title: title.slice(0, 180), extendedContent: `${author} ${text} ${imageAlt} ${links}`, author, imageUrl };
      if (sent.get(post.id) === JSON.stringify(post)) continue;
      posts.push(post);
      if (posts.length >= 100) break;
    }
    return posts;
  }
  async function publish(done = false, reason?: string): Promise<boolean> {
    if (stopped || scope.__openMemoryXReader !== runId || !onBookmarks()) { stopped = true; return false; }
    const username = account();
    if (!username && !done) return true;
    const posts = collect();
    try {
      const response = await chrome.runtime.sendMessage({ type: 'X_BROWSER_BATCH', runId, username, posts, done, reason });
      if (!response?.success || response.stop) stopped = true;
      if (response?.success) {
        for (const post of posts) sent.set(post.id, JSON.stringify(post));
        observed += posts.length;
      }
      return !stopped;
    } catch { stopped = true; return false; }
  }
  const observer = new MutationObserver(() => {
    if (!running && !stopped) { running = true; void publish().finally(() => { running = false; }); }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  void (async () => {
    try {
      while (!stopped && Date.now() - started < 10 * 60000) {
        await wait(2000);
        if (running) continue;
        running = true;
        if (!await publish()) break;
        if (!account()) {
          running = false;
          if (Date.now() - started > 30000) { await publish(true, 'empty'); break; }
          continue;
        }
        const before = sent.size;
        const height = document.documentElement.scrollHeight;
        window.scrollBy(0, Math.max(300, window.innerHeight * 0.8));
        await wait(2000);
        if (!await publish()) break;
        const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 20;
        idleRounds = atBottom && sent.size === before && height === document.documentElement.scrollHeight ? idleRounds + 1 : 0;
        running = false;
        if (idleRounds >= 4) { await publish(true, observed ? 'settled' : 'empty'); break; }
      }
      if (!stopped) await publish(true, observed ? 'limit' : 'empty');
    } finally { stopped = true; observer.disconnect(); if (scope.__openMemoryXReader === runId) delete scope.__openMemoryXReader; }
  })();
}
