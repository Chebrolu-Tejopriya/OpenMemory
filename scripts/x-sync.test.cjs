const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { webcrypto } = require('node:crypto');
global.crypto ||= webcrypto;
const load = code => { const mod = { exports: {} }; new Function('module', 'exports', 'require', code)(mod, mod.exports, require); return mod.exports; };
(async () => {
  const browser = load(esbuild.buildSync({ entryPoints: ['src/extension/x-browser.ts'], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text);
  assert.equal(browser.validBookmarkPage('https://x.com/i/bookmarks'), true);
  assert.equal(browser.validBookmarkPage('https://x.com/i/history'), true);
  for (const url of ['https://x.com.evil.example/i/bookmarks', 'https://x.com/home', 'http://x.com/i/bookmarks']) assert.equal(browser.validBookmarkPage(url), false);
  const post = id => ({ id, title: 'Design systems', extendedContent: 'Design systems and components', author: '@designer', imageUrl: 'https://pbs.twimg.com/media/test.jpg' });
  assert.equal(browser.validateBrowserPosts([post('10')])[0].url, 'https://x.com/i/status/10');
  assert.equal(browser.validateBrowserPosts([{ ...post('10'), imageUrl: 'https://evil.example/pixel' }])[0].imageUrl, undefined);
  assert.throws(() => browser.validateBrowserPosts([{ ...post('javascript:1') }]), /Invalid/);
  assert.throws(() => browser.validateBrowserPosts(Array(101).fill(post('1'))), /Invalid/);
  const dom = new JSDOM(`<a data-testid="AppTabBar_Profile_Link" href="/owner">Profile</a>
    <div data-testid="primaryColumn"><article data-testid="tweet"><a href="/designer/status/10"><time>Today</time></a>
    <div data-testid="tweetText">Design systems <a href="https://example.com">link</a></div>
    <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/test.jpg" alt="A component library"></div></article>
    <article data-testid="tweet"><a href="/designer/status/11"><time>Today</time></a><div data-testid="tweetText">Video reference</div><video poster="https://pbs.twimg.com/amplify_video_thumb/example.jpg"></video></article></div>
    <aside><article data-testid="tweet"><a href="/other/status/999"><time>Today</time></a><div data-testid="tweetText">Unrelated</div></article></aside>`,
    { url: 'https://x.com/i/bookmarks', runScripts: 'outside-only' });
  const batches = [];
  dom.window.chrome = { runtime: { sendMessage: async message => { batches.push(message); return { success: true, stop: true }; } } };
  const realTimeout = dom.window.setTimeout.bind(dom.window);
  dom.window.setTimeout = callback => realTimeout(callback, 1);
  dom.window.scrollBy = () => {};
  dom.window.eval(`(${browser.readXBookmarksPage.toString()})('fixture-run')`);
  for (let i = 0; i < 100 && !batches.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
  dom.window.close();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].username, 'owner');
  assert.deepEqual(batches[0].posts.map(p => p.id).join(','), '10,11');
  assert.match(batches[0].posts[0].extendedContent, /component library/);
  assert.match(batches[0].posts[1].imageUrl, /amplify_video_thumb/);
  assert.equal(batches[0].checkpoint.afterPostId, '11');
  const history = new JSDOM(`<a data-testid="AppTabBar_Profile_Link" href="/owner">Profile</a>
    <button role="tab" aria-selected="true">All</button><button role="tab" aria-selected="false">Bookmarks</button>
    <div aria-label="Timeline: History"><article data-testid="tweet"><a href="/other/status/999"><time>Today</time></a><div data-testid="tweetText">Private history, not a bookmark</div></article></div>
    <div aria-label="Timeline: Bookmarks"><article data-testid="tweet"><a href="/designer/status/30"><time>Today</time></a><div data-testid="tweetText">Saved bookmark</div></article></div>`,
    { url: 'https://x.com/i/history', runScripts: 'outside-only' });
  const historyBatches = [];
  history.window.document.querySelectorAll('[role="tab"]')[1].addEventListener('click', event => { event.target.setAttribute('aria-selected', 'true'); });
  history.window.chrome = { runtime: { sendMessage: async message => { historyBatches.push(message); return { success: true, stop: true }; } } };
  const historyTimeout = history.window.setTimeout.bind(history.window);
  history.window.setTimeout = callback => historyTimeout(callback, 1);
  history.window.scrollBy = () => {};
  history.window.eval(`(${browser.readXBookmarksPage.toString()})('history-run')`);
  for (let i = 0; i < 100 && !historyBatches.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
  history.window.close();
  assert.equal(historyBatches.length, 1);
  assert.equal(historyBatches[0].posts.map(post => post.id).join(','), '30', 'Never extract other History timelines');

  for (const sameDocument of [false, true]) {
    const page = new JSDOM(`<a data-testid="AppTabBar_Profile_Link" href="/owner">Profile</a><div data-testid="primaryColumn"></div>`,
      { url: 'https://x.com/i/bookmarks', runScripts: 'outside-only' });
    const timeline = page.window.document.querySelector('[data-testid="primaryColumn"]');
    const render = id => { timeline.innerHTML = `<article data-testid="tweet"><a href="/designer/status/${id}"><time>Today</time></a><div data-testid="tweetText">Saved ${id}</div></article>`; };
    render(sameDocument ? '21' : '10');
    const resumedBatches = [];
    let resets = 0;
    page.window.__openMemoryXPage = sameDocument ? 'saved-page' : 'new-page';
    Object.defineProperty(page.window, 'scrollY', { value: sameDocument ? 5000 : 0, writable: true });
    page.window.scrollTo = () => { resets++; page.window.scrollY = 0; };
    page.window.scrollBy = () => { render('20'); page.window.scrollY = 5000; };
    const nativeTimer = page.window.setTimeout.bind(page.window);
    page.window.setTimeout = callback => nativeTimer(callback, 1);
    page.window.chrome = { runtime: { sendMessage: async message => {
      resumedBatches.push(message); return { success: true, stop: sameDocument || !message.checkpoint.replaying };
    } } };
    page.window.eval(`(${browser.readXBookmarksPage.toString()})('resume-run', ${JSON.stringify({ pageId: 'saved-page', afterPostId: '20', scrollY: 5000 })})`);
    for (let i = 0; i < 100 && !resumedBatches.some(batch => !batch.checkpoint.replaying); i++) await new Promise(resolve => setTimeout(resolve, 20));
    page.window.close();
    assert.equal(resets, sameDocument ? 0 : 1);
    assert.equal(resumedBatches[0].checkpoint.afterPostId, sameDocument ? '21' : '20');
    assert.equal(resumedBatches.at(-1).checkpoint.replaying, false, 'A reopened page finds the saved anchor before advancing');
  }

  const store = {}, rows = new Map(), alarms = new Map(), tabs = new Map();
  let tabId = 0, injected = 0, injection;
  global.__xDb = { xBookmarks: { clear: async () => rows.clear(), get: async id => rows.get(id), put: async item => rows.set(item.id, item), count: async () => rows.size, toArray: async () => [...rows.values()] },
    transaction: async (...args) => args.at(-1)() };
  global.chrome = { runtime: { id: 'extension-id' }, storage: { local: {
    get: async () => structuredClone(store), set: async value => Object.assign(store, structuredClone(value)),
    remove: async keys => { for (const key of [].concat(keys)) delete store[key]; }
  } }, alarms: { create: async (name, value) => alarms.set(name, value), clear: async name => alarms.delete(name) },
    tabs: { create: async config => { const tab = { ...config, id: ++tabId, status: 'loading' }; tabs.set(tab.id, tab); return tab; },
      get: async id => { if (!tabs.has(id)) throw new Error('Closed'); return tabs.get(id); }, remove: async id => tabs.delete(id) },
    scripting: { executeScript: async options => { injected++; injection = options; } } };
  global.fetch = async () => { throw new Error('Browser sync must not call an API'); };
  const build = await esbuild.build({ entryPoints: ['src/extension/x-sync.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'test-db', setup(b) { b.onResolve({ filter: /^\.\/db$/ }, () => ({ path: 'db', namespace: 'test' }));
      b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const db = globalThis.__xDb;' })); } }] });
  const sync = load(build.outputFiles[0].text);
  await sync.connectX();
  assert.equal(tabs.get(1).active, true);
  await sync.attachXReader(1); assert.equal(injected, 1);
  const sender = id => ({ id: 'extension-id', frameId: 0, url: 'https://x.com/i/bookmarks', tab: { id } });
  const message = () => ({ runId: store.xBrowserConnection.run.id, username: 'owner', posts: [post('10')] });
  const previousRun = message();
  await sync.syncX(true);
  assert.equal(tabId, 1, 'Manual sync reuses the active scan tab');
  assert.notEqual(store.xBrowserConnection.run.id, previousRun.runId, 'Manual sync restarts an unresponsive reader immediately');
  assert.equal((await sync.handleXBrowserBatch(previousRun, sender(1))).success, false, 'Old readers cannot write after a restart');
  assert.equal((await sync.handleXBrowserBatch(message(), sender(55))).success, false);
  assert.equal(rows.size, 0);
  assert.equal((await sync.handleXBrowserBatch(message(), { ...sender(1), url: 'https://x.com/home' })).success, false);
  await sync.handleXBrowserBatch(message(), sender(1));
  await sync.handleXBrowserBatch(message(), sender(1)); assert.equal(rows.size, 1);
  const restarted = load(build.outputFiles[0].text);
  await restarted.handleXBrowserBatch({ ...message(), posts: [post('11')], done: true }, sender(1));
  assert.equal(rows.size, 2); assert.ok(store.xBrowserConnection.lastSyncAt);
  assert.ok(tabs.has(1), 'The foreground setup tab must stay open');
  await restarted.syncX(); assert.equal(tabId, 1, 'Scheduled scan respects interval');
  await restarted.syncX(true); assert.equal(tabs.get(2).active, false);
  await restarted.handleXBrowserBatch({ ...message(), done: true }, sender(2));
  assert.ok(!tabs.has(2), 'Only the owned background tab closes');
  await restarted.syncX(true);
  await restarted.handleXBrowserBatch({ ...message(), username: 'someone_else', posts: [post('99')] }, sender(3));
  assert.equal(rows.has('99'), false); assert.equal(store.xBrowserConnection.paused, true);
  await restarted.pauseX(false); await restarted.syncX(true);
  const stale = message();
  await restarted.pauseX(true);
  assert.equal((await restarted.handleXBrowserBatch(stale, sender(4))).success, false);
  assert.equal(alarms.size, 0);
  await restarted.disconnectX(); assert.equal(rows.size, 0); assert.equal(store.xBrowserConnection, undefined);
  await restarted.connectX();
  const loginTab = tabId;
  tabs.get(loginTab).url = 'https://x.com/i/flow/login';
  await restarted.attachXReader(loginTab);
  assert.equal(store.xBrowserConnection.paused, true, 'Login redirects pause instead of opening endless background tabs');
  assert.ok(tabs.has(loginTab), 'Keep the login tab available for the user');
  await restarted.disconnectX();
  await restarted.connectX();
  await restarted.handleXBrowserBatch({ ...message(), username: '', done: true }, sender(tabId));
  assert.equal(store.xBrowserConnection.paused, true, 'An unverified account must never be imported');
  await restarted.disconnectX();
  await restarted.connectX();
  const resumeTab = tabId;
  const checkpoint = { pageId: 'document-1', afterPostId: '10', scrollY: 15000, replaying: false };
  await restarted.handleXBrowserBatch({ ...message(), done: true, reason: 'limit', checkpoint }, sender(resumeTab));
  assert.ok(tabs.has(resumeTab), 'Keep the live timeline for continuation');
  assert.equal(store.xBrowserConnection.error, undefined);
  assert.equal(store.xBrowserConnection.lastSyncAt, undefined, 'A timed scan is not a completed sync');
  assert.ok(alarms.get('xBookmarkSync').when <= Date.now() + 31000);
  const resumed = load(build.outputFiles[0].text);
  await resumed.syncX(true);
  assert.equal(tabId, resumeTab, 'Continuation must reuse the existing page');
  await resumed.attachXReader(resumeTab);
  assert.equal(injection.args[1].afterPostId, '10');
  assert.equal(injection.args[1].scrollY, 15000);
  await resumed.pauseX(true);
  assert.equal(store.xBrowserConnection.continuation.afterPostId, '10');
  tabs.delete(resumeTab); await resumed.xTabClosed(resumeTab);
  await resumed.pauseX(false); await resumed.syncX(true);
  await resumed.attachXReader(tabId);
  assert.equal(injection.args[1].afterPostId, '10', 'Closed tabs retain the replay anchor');
  assert.equal(injection.args[1].pageId, undefined);
  const ownedTab = tabId;
  await resumed.handleXBrowserBatch({ ...message(), done: true, reason: 'limit', checkpoint }, sender(ownedTab));
  await resumed.syncX(true);
  assert.equal(tabId, ownedTab);
  await resumed.handleXBrowserBatch({ ...message(), done: true, reason: 'settled' }, sender(ownedTab));
  assert.equal(tabs.has(ownedTab), false, 'Completed owned continuation closes');
  assert.equal(store.xBrowserConnection.continuation, undefined);
  await resumed.disconnectX();
  console.log('Passed X browser sync: DOM extraction, no API calls, sender/run checks, durable batches, deduplication, restart, account changes, pause and tab cleanup.');
})().catch(error => { console.error(error); process.exitCode = 1; });
