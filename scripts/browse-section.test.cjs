const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const path = require('node:path');

(async () => {
  const build = await esbuild.build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import BrowseSection from './src/components/BrowseSection'; createRoot(document.getElementById('root')).render(<BrowseSection folders={['Work']} boards={['Design']} />);`, resolveDir: path.resolve('webapp'), loader: 'tsx' },
    bundle: true, format: 'iife', write: false, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_BACKEND_URL': '"http://backend.test"' },
    plugins: [{ name: 'image-test', setup(b) { b.onResolve({ filter: /^next\/image$/ }, () => ({ path: 'image', namespace: 'test' })); b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export default function Image() { return null; }' })); } }] });
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.IntersectionObserver = class { observe() {} disconnect() {} unobserve() {} };
  w.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
  const requests = [];
  w.fetch = async url => {
    const source = new URL(url).searchParams.get('source'); requests.push(source);
    const result = source === 'x' ? { title: 'Saved X post', description: 'Full post content beyond the title https://originkit.dev.\nThank me later: https://t.co/ZDmmlkTcUL\nSee (https://example.com/design_(UI)). <script>alert(1)</script> javascript:alert(1)', author: '@designer', url: 'https://x.com/i/status/99', source: 'x' }
      : { title: `${source} result`, url: 'https://example.com', source, folder: 'Work' };
    return { ok: true, json: async () => ({ results: source === 'x' ? [result, result] : [result] }) };
  };
  try {
    w.eval(build.outputFiles[0].text);
    for (let i = 0; i < 100 && !requests.length; i++) await pause(20);
    const select = w.document.querySelector('button[aria-label="Collection source"]');
    assert.match(select.textContent, /Bookmarks/);
    assert.equal(requests[0], 'chrome');
    select.click(); await pause(50);
    assert.equal(select.getAttribute('aria-expanded'), 'true');
    [...w.document.querySelectorAll('[role=menuitemradio]')].find(item => item.textContent.endsWith('X bookmarks')).click();
    for (let i = 0; i < 100 && !w.document.querySelector('article'); i++) await pause(20);
    assert.equal(w.document.querySelectorAll('article').length, 2, 'One unique X post in each responsive layout');
    assert.match(w.document.querySelector('article').textContent, /Full post content beyond the title/);
    const post = w.document.querySelector('article');
    const links = [...post.querySelectorAll('p a')];
    assert.deepEqual(links.map(link => link.getAttribute('href')), ['https://originkit.dev', 'https://t.co/ZDmmlkTcUL', 'https://example.com/design_(UI)']);
    assert.ok(links.every(link => link.target === '_blank' && link.rel.includes('noopener')));
    assert.match(post.textContent, /https:\/\/originkit.dev\.\nThank me later/);
    assert.equal(post.querySelector('script'), null);
    const grid = [...w.document.querySelectorAll('button')].find(button => button.textContent === 'Grid');
    grid.click(); await pause(100);
    assert.equal(grid.getAttribute('aria-pressed'), 'true');
    assert.equal(w.document.querySelectorAll('article').length, 0);
    select.click(); await pause(50);
    [...w.document.querySelectorAll('[role=menuitemradio]')].find(item => item.textContent === 'Pinterest').click();
    for (let i = 0; i < 100 && !requests.includes('pinterest'); i++) await pause(20);
    assert.ok(requests.includes('pinterest'));
    console.log('Passed Collections: default Bookmarks dropdown, source switching, full X feed, duplicate suppression and grid toggle.');
  } finally { w.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
