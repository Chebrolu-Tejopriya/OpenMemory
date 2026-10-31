const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { webcrypto } = require('node:crypto');
global.crypto ||= webcrypto;
const load = code => { const mod = { exports: {} }; new Function('module', 'exports', 'require', code)(mod, mod.exports, require); return mod.exports; };
(async () => {
  const browser = load(esbuild.buildSync({ entryPoints: ['src/extension/x-browser.ts'], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text);
  assert.equal(browser.validBookmarkPage('https://x.com/i/bookmarks'), true);
  for (const url of ['https://x.com.evil.example/i/bookmarks', 'https://x.com/home', 'http://x.com/i/bookmarks']) assert.equal(browser.validBookmarkPage(url), false);
  const post = id => ({ id, title: 'Design systems', extendedContent: 'Design systems and components', author: '@designer', imageUrl: 'https://pbs.twimg.com/media/test.jpg' });
  assert.equal(browser.validateBrowserPosts([post('10')])[0].url, 'https://x.com/i/status/10');
  assert.equal(browser.validateBrowserPosts([{ ...post('10'), imageUrl: 'https://evil.example/pixel' }])[0].imageUrl, undefined);
  assert.throws(() => browser.validateBrowserPosts([{ ...post('javascript:1') }]), /Invalid/);
  assert.throws(() => browser.validateBrowserPosts(Array(101).fill(post('1'))), /Invalid/);
  const dom = new JSDOM(`<a data-testid="AppTabBar_Profile_Link" href="/owner">Profile</a>
    <div data-testid="primaryColumn"><article data-testid="tweet"><a href="/designer/status/10"><time>Today</time></a>
    <div data-testid="tweetText">Design systems <a href="https://example.com">link</a></div>
    <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/test.jpg" alt="A component library"></div></article></div>
    <aside><article data-testid="tweet"><a href="/other/status/999"><time>Today</time></a><div data-testid="tweetText">Unrelated</div></article></aside>`,
    { url: 'https://x.com/i/bookmarks', runScripts: 'outside-only' });
  const batches = [];
  dom.window.chrome = { runtime: { sendMessage: async message => { batches.push(message); return { success: true, stop: true }; } } };
  const realTimeout = dom.window.setTimeout.bind(dom.window);
  dom.window.setTimeout = callback => realTimeout(callback, 1);
  dom.window.eval(`(${browser.readXBookmarksPage.toString()})('fixture-run')`);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(batches.length, 1);
  assert.equal(batches[0].username, 'owner');
  assert.deepEqual(batches[0].posts.map(p => p.id).join(','), '10');
  assert.match(batches[0].posts[0].extendedContent, /component library/);
  dom.window.close();

  const store = {}, rows = new Map(), alarms = new Map(), tabs = new Map();
  let tabId = 0, injected = 0;
  global.__xDb = { xBookmarks: { clear: async () => rows.clear(), get: async id => rows.get(id), put: async item => rows.set(item.id, item), count: async () => rows.size },
    transaction: async (...args) => args.at(-1)() };
  global.chrome = { runtime: { id: 'extension-id' }, storage: { local: {
    get: async () => structuredClone(store), set: async value => Object.assign(store, structuredClone(value)),
    remove: async keys => { for (const key of [].concat(keys)) delete store[key]; }
  } }, alarms: { create: async (name, value) => alarms.set(name, value), clear: async name => alarms.delete(name) },
    tabs: { create: async config => { const tab = { ...config, id: ++tabId, status: 'loading' }; tabs.set(tab.id, tab); return tab; },
      get: async id => { if (!tabs.has(id)) throw new Error('Closed'); return tabs.get(id); }, remove: async id => tabs.delete(id) },
    scripting: { executeScript: async () => { injected++; } } };
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
  console.log('Passed X browser sync: DOM extraction, no API calls, sender/run checks, durable batches, deduplication, restart, account changes, pause and tab cleanup.');
})().catch(error => { console.error(error); process.exitCode = 1; });
