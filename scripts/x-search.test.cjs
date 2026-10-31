const assert = require('node:assert/strict');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
(async () => {
  const bundle = await esbuild.build({ entryPoints: ['src/extension/search.ts'], bundle: true, format: 'iife', write: false,
    define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{ name: 'test-db', setup(build) {
      build.onResolve({ filter: /^\.\/db$/ }, () => ({ path: 'db', namespace: 'test' }));
      build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const db = globalThis.__testDb;' }));
    } }] });
  const dom = new JSDOM(fs.readFileSync('src/extension/sidepanel.html', 'utf8'), {
    url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    w.__testDb = { bookmarks: { toArray: async () => [{ id: 1, title: 'Design systems Chrome', url: 'https://example.com', folder: 'Work', indexStatus: 'indexed' }] },
      pins: { toArray: async () => [] }, queue: { count: async () => 0 }, xBookmarks: { toArray: async () => [{ id: '99', title: 'Design systems on X',
        url: 'https://x.com/i/status/99', folder: 'X bookmarks', extendedContent: '@designer Component libraries', author: '@designer', indexedAt: Date.now(), indexStatus: 'indexed' }] } };
    let paused = false;
    w.chrome = { storage: { local: { get: (_keys, callback) => callback ? callback({}) : Promise.resolve({}) } }, runtime: {
      getURL: file => `http://localhost/${file}`, onMessage: { addListener() {} }, sendMessage: async msg => {
        if (msg.type === 'X_PAUSE') paused = msg.paused;
        if (msg.type.startsWith('X_')) return { success: true, connected: true, count: 1, username: 'designer', clientId: 'test',
          redirectUri: 'https://extension.chromiumapp.org/x', paused };
        return { success: true, pins: [], boards: [], count: 0 };
      } } };
    w.fetch = async () => { throw new Error('X-only search must not request a remote backend'); };
    w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    w.HTMLElement.prototype.scrollIntoView = function () {};
    w.eval(bundle.outputFiles[0].text);
    await pause(150);
    const doc = w.document;
    assert.match(doc.getElementById('x-status').textContent, /@designer/);
    doc.getElementById('x-settings-toggle').click();
    assert.equal(doc.getElementById('x-settings').style.display, 'block');
    assert.match(doc.getElementById('x-settings').textContent, /No API key needed/);
    assert.equal(doc.getElementById('x-client-id'), null);
    const source = doc.getElementById('filter-source'); source.value = 'x';
    source.dispatchEvent(new w.Event('change', { bubbles: true }));
    const input = doc.getElementById('search-input'); input.value = 'design systems';
    input.dispatchEvent(new w.Event('input', { bubbles: true }));
    await pause(500);
    assert.match(doc.getElementById('results').textContent, /Design systems on X/);
    assert.doesNotMatch(doc.getElementById('results').textContent, /Chrome/);
    assert.equal(doc.querySelector('#results a').href, 'https://x.com/i/status/99');
    assert.equal(doc.getElementById('filter-board-section').style.display, 'none');
    assert.equal(doc.getElementById('filter-folder-section').style.display, 'none');
    doc.getElementById('x-pause').click(); await pause(100);
    assert.equal(paused, true);
    assert.equal(doc.getElementById('x-pause').textContent, 'Resume');
    console.log('Passed X UI: browser setup, keyword search, source filter, private result link and pause/resume state.');
  } finally { w.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
