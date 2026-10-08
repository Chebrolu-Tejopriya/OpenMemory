const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

const dom = new JSDOM(fs.readFileSync('dist/sidepanel.html', 'utf8'), {
  url: 'http://localhost', runScripts: 'outside-only', pretendToBeVisual: true,
});
const window = dom.window;
window.chrome = {
  storage: { local: {
    get: (_keys, callback) => callback ? callback({}) : Promise.resolve({}),
    set: (_data, callback) => callback?.(),
  } },
  runtime: {
    getURL: file => `http://localhost/${file}`,
    sendMessage: async () => ({ success: true, pins: [], boards: [], count: 0 }),
    onMessage: { addListener() {} },
  },
};
window.fetch = async () => ({ ok: true, json: async () => ({ items: [], folders: [] }) });
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
window.HTMLElement.prototype.scrollIntoView = function () {};
window.HTMLElement.prototype.hasPointerCapture = () => false;
window.HTMLElement.prototype.setPointerCapture = function () {};
window.HTMLElement.prototype.releasePointerCapture = function () {};

(async () => {
  window.eval(fs.readFileSync('dist/search.js', 'utf8'));
  await new Promise(resolve => setTimeout(resolve, 100));
  const button = window.document.getElementById('filter-add');
  const menu = window.document.getElementById('filter-menu');
  button.click();
  assert.ok(menu.classList.contains('active'), 'Add Filter opens the filter panel');
  await new Promise(resolve => setTimeout(resolve, 50));
  const trigger = window.document.getElementById('filter-source-trigger');
  assert.ok(trigger, 'Production bundle mounts custom controls');
  trigger.click();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(trigger.getAttribute('aria-expanded'), 'true', 'Source dropdown opens');
  assert.ok(menu.classList.contains('active'), 'Filter panel stays open with dropdown');
  const option = Array.from(window.document.querySelectorAll('[role="option"]')).find(el => el.textContent.includes('Bookmarks'));
  assert.ok(option, 'Source options are visible');
  option.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(window.document.getElementById('filter-source').value, 'bookmarks');
  assert.match(trigger.textContent, /Bookmarks/);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'Choosing an option closes the dropdown');
  assert.ok(menu.classList.contains('active'), 'Choosing an option keeps the filter panel open');
  console.log('Passed: production Add Filter and Source dropdown open.');
  dom.window.close(); process.exit(0);
})().catch(error => { console.error(error); dom.window.close(); process.exit(1); });
