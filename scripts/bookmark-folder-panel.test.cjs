const assert = require('node:assert/strict');
const fs = require('node:fs');
const { build } = require('esbuild');
const { JSDOM } = require('jsdom');

(async () => {
  const recovered = 'Bookmarks bar/Imported/Recovered from Open Memory - 2026-11-07';
  const cloud = ['Tools', 'Inspirations', 'Voice', 'Editing', recovered].map((folder, i) => ({
    url: `https://example.com/${i}`, title: `Bookmark ${i}`, folder,
  }));
  const bundle = await build({
    entryPoints: ['src/extension/search.ts'], bundle: true, format: 'iife', write: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'read-only-local-cache', setup(build) {
      build.onLoad({ filter: /[\\/]extension[\\/]db\.ts$/ }, () => ({ contents: 'export const db = globalThis.__testDb;', loader: 'ts' }));
    } }],
  });
  const dom = new JSDOM(fs.readFileSync('dist/sidepanel.html', 'utf8'), { url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  const settings = { supabaseUrl: 'https://test.supabase.co', supabaseAnonKey: 'test' };
  const table = { toArray: async () => [], count: async () => 0, get: async () => undefined };
  win.__testDb = {
    bookmarks: { ...table, toArray: async () => cloud.slice(0, 3).map((row, i) => ({ ...row, id: i + 1, indexStatus: 'indexed' })) },
    pins: table, xBookmarks: table, queue: table, integrations: table, pinterestBoards: table,
  };
  win.chrome = {
    storage: { local: { get: (_keys, callback) => { callback?.(settings); return Promise.resolve(settings); }, set: async () => {} } },
    runtime: { getURL: file => `http://localhost/${file}`, sendMessage: async () => ({ success: true, count: 3 }), onMessage: { addListener() {} } },
  };
  let catalogReads = 0;
  win.fetch = async (url, options) => {
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
    console.log('Passed: actual sidepanel loads cloud-only folders and shows OM while retaining its filter path.');
  } finally { dom.window.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
