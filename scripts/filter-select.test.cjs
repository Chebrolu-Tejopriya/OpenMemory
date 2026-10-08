console.log('Loading dropdown test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { JSDOM } = require('jsdom');
const { buildSync } = require('esbuild');

const dom = new JSDOM('<!doctype html><body>' + ['source', 'board', 'folder', 'time'].map(name =>
  `<label for="filter-${name}">${name}</label><select id="filter-${name}"><option value="">All</option><option value="chosen">Chosen</option></select>`
).join(''), { url: 'http://localhost' });
for (const name of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'Event', 'KeyboardEvent', 'CustomEvent', 'HTMLInputElement', 'HTMLSelectElement']) {
  global[name] = dom.window[name];
}
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
for (const name of Object.getOwnPropertyNames(dom.window).filter(name => /^(HTML|SVG)|^(NodeFilter|ShadowRoot|Document)$/.test(name))) {
  global[name] = dom.window[name];
}
global.requestAnimationFrame = callback => setTimeout(callback, 0);
global.cancelAnimationFrame = clearTimeout;
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
global.IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = function () {};
HTMLElement.prototype.hasPointerCapture = () => false;
HTMLElement.prototype.setPointerCapture = function () {};
HTMLElement.prototype.releasePointerCapture = function () {};

console.log('DOM initialized');
const { act } = require('react');
const compiled = new Module(__filename, module);
compiled.paths = module.paths;
compiled._compile(buildSync({
  entryPoints: ['src/extension/filter-select.tsx'], bundle: true, write: false,
  format: 'cjs', packages: 'external',
}).outputFiles[0].text, __filename);
const { mountFilterSelects, refreshFilterSelects } = compiled.exports;

(async () => {
  console.log('Mounting controls');
  await act(async () => mountFilterSelects());
  console.log('Controls mounted');
  assert.equal(document.querySelectorAll('[role="combobox"]').length, 4);
  const select = document.getElementById('filter-board');
  const trigger = document.getElementById('filter-board-trigger');
  assert.equal(trigger.getAttribute('aria-label'), 'board');
  assert.equal(select.hidden, true);
  let changes = 0;
  select.addEventListener('change', () => { changes++; refreshFilterSelects(); });
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  const option = Array.from(document.querySelectorAll('[role="option"]')).find(el => el.textContent.includes('Chosen'));
  assert.ok(option, 'Dropdown options render in a portal');
  await act(async () => {
    option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  assert.equal(select.value, 'chosen');
  assert.equal(changes, 1);
  assert.match(trigger.textContent, /Chosen/);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  await act(async () => { select.value = ''; refreshFilterSelects(); });
  assert.match(trigger.textContent, /All/);
  await act(async () => {
    select.innerHTML = '<option value="">All</option><option value="new" selected>New board</option>';
    refreshFilterSelects();
  });
  assert.match(trigger.textContent, /New board/);
  console.log('Passed: keyboard selection, filter change, chip reset and refreshed board options.');
  dom.window.close();
  process.exit(0);
})().catch(error => { console.error(error); dom.window.close(); process.exit(1); });
