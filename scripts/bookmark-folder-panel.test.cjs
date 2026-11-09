const assert = require('node:assert/strict');
const fs = require('node:fs');
const { build } = require('esbuild');
const { JSDOM } = require('jsdom');

(async () => {
  const recovered = 'Bookmarks bar/Imported/Recovered from Open Memory - 2026-11-07';
  const cloud = ['Tools', 'Inspirations', 'Voice', 'Editing', recovered].map((folder, i) => ({
    url: `https://example.com/${i}`, title: `Bookmark ${i}`, folder,
  }));
  const cloudBoards = ['tracker', 'figbruary', 'OpenMemory', ...Array.from({ length: 36 }, (_, i) => `Cloud board ${i}`)];
  const boardsOffline = process.argv.includes('--boards-offline');
  const bundle = await build({
    entryPoints: ['src/extension/search.ts'], bundle: true, format: 'iife', write: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'read-only-local-cache', setup(build) {
      build.onLoad({ filter: /[\\/]extension[\\/]db\.ts$/ }, () => ({ contents: 'export const db = globalThis.__testDb;', loader: 'ts' }));
    } }],
  });
  const dom = new JSDOM(fs.readFileSync('dist/sidepanel.html', 'utf8'), { url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  const uiErrors = [];
  const warnings = [];
  win.addEventListener('error', event => uiErrors.push(event.error));
  win.console.warn = (...args) => warnings.push(args);
  const settings = { supabaseUrl: 'https://test.supabase.co', supabaseAnonKey: 'test' };
  const table = { toArray: async () => [], count: async () => 0, get: async () => undefined };
  win.__testDb = {
    bookmarks: { ...table, toArray: async () => cloud.slice(0, 3).map((row, i) => ({ ...row, id: i + 1, indexStatus: 'indexed' })) },
    pins: { ...table, toArray: async () => [{ pinId: '1', pinUrl: 'https://www.pinterest.com/pin/1/', title: 'Tracker pin', boardName: 'tracker' }] },
    xBookmarks: table, queue: table, integrations: table,
    pinterestBoards: { ...table, toArray: async () => [{ name: 'Local board without downloaded pins', archived: false }] },
  };
  win.chrome = {
    storage: { local: { get: (_keys, callback) => { callback?.(settings); return Promise.resolve(settings); }, set: async () => {} } },
    runtime: { getURL: file => `http://localhost/${file}`, sendMessage: async () => ({ success: true, count: 3 }), onMessage: { addListener() {} } },
  };
  let catalogReads = 0;
  let boardReads = 0;
  win.fetch = async (url, options) => {
    if (String(url).includes('/rest/v1/pinterest_boards?')) {
      assert.equal(options.method, 'GET', 'Board menu must not trigger a cloud write');
      boardReads++;
      if (boardsOffline) return { ok: false, status: 503 };
      const offset = Number(new URL(url).searchParams.get('offset'));
      return { ok: true, json: async () => cloudBoards.slice(offset, offset + 10).map(board_name => ({ board_name })) };
    }
    if (String(url).includes('select=url%2Ctitle%2Cfolder')) {
      assert.equal(options.method, 'GET');
      catalogReads++;
      const offset = Number(new URL(url).searchParams.get('offset'));
      return { ok: true, json: async () => cloud.slice(offset, offset + 2) };
    }
    return { ok: true, headers: { get: () => '0-0/5' }, json: async () => [] };
  };
  win.AbortSignal = global.AbortSignal;
  win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.HTMLElement.prototype.scrollIntoView = function () {};
  win.HTMLElement.prototype.hasPointerCapture = () => false;
  win.HTMLElement.prototype.setPointerCapture = function () {};
  win.HTMLElement.prototype.releasePointerCapture = function () {};
  try {
    win.eval(bundle.outputFiles[0].text);
    const select = win.document.getElementById('filter-folder');
    for (let i = 0; i < 50 && select.options.length < 6; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(select.options.length, 6, 'All five cloud folders appear despite only three local folders');
    assert.ok([...select.options].some(option => option.value === recovered && option.textContent === 'OM'));
    assert.ok([...select.options].some(option => option.value === 'Editing'));
    assert.equal(catalogReads, 4, 'Read each capped API page through the empty final page');
    const boardSelect = win.document.getElementById('filter-board');
    assert.equal(boardSelect.options.length, boardsOffline ? 3 : 41, 'Merge cloud boards, locally saved board metadata, and pins');
    assert.ok([...boardSelect.options].some(option => option.value === 'tracker'));
    assert.ok([...boardSelect.options].some(option => option.value === 'Local board without downloaded pins'));
    assert.equal(boardReads, boardsOffline ? 1 : 5);
    if (!boardsOffline) {
      assert.ok([...boardSelect.options].some(option => option.value === 'figbruary'));
      assert.ok([...boardSelect.options].some(option => option.value === 'OpenMemory'));
      win.document.getElementById('filter-source').value = 'pinterest';
      win.document.getElementById('filter-source').dispatchEvent(new win.Event('change', { bubbles: true }));
      boardSelect.value = 'figbruary';
      boardSelect.dispatchEvent(new win.Event('change', { bubbles: true }));
      assert.equal(boardSelect.value, 'figbruary', 'Cloud-only board selection survives filter refresh');
      assert.match(win.document.getElementById('filter-chips').textContent, /figbruary/);
    }
    // Let the custom React selects commit their event-driven refresh before
    // closing the jsdom document they render into.
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(uiErrors, [], 'Filter controls must render without errors');
    assert.equal(warnings.length, boardsOffline ? 1 : 0);
    console.log(`Passed: sidepanel folders, OM, and ${boardsOffline ? 'offline board fallback' : '39 cloud boards with cloud-only selection'}.`);
  } finally { dom.window.close(); }
})().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
