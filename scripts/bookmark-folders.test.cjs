const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { buildSync } = require('esbuild');

function load(entry) {
  const result = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false });
  const mod = new Module(path.resolve(entry), module);
  mod.filename = path.resolve(entry);
  mod.paths = module.paths;
  mod._compile(result.outputFiles[0].text, mod.filename);
  return mod.exports;
}

(async () => {
  const catalog = load('src/extension/bookmark-catalog.ts');
  const recovered = 'Bookmarks bar/Imported/Recovered from Open Memory - 2026-11-07';
  const cloud = Array.from({ length: 2477 }, (_, i) => ({
    url: `https://example.com/${i}`, title: `Bookmark ${i}`,
    folder: i === 2476 ? recovered : `Folder ${i % 25}`,
  }));
  const requests = [];
  const mockFetch = async (url, options) => {
    assert.equal(options.method, 'GET', 'Catalog must never write to Supabase');
    const params = new URL(url).searchParams;
    assert.equal(params.get('select'), 'url,title,folder', 'Do not download embeddings');
    assert.equal(params.get('order'), 'id.asc');
    const offset = Number(params.get('offset'));
    requests.push(offset);
    // Simulate a service row cap smaller than the requested page size.
    return { ok: true, json: async () => cloud.slice(offset, offset + 600) };
  };
  const fetched = await catalog.fetchBookmarkCatalog({ url: 'https://test.supabase.co', anonKey: 'test' }, mockFetch);
  assert.equal(fetched.length, 2477);
  assert.deepEqual(requests, [0, 600, 1200, 1800, 2400, 2477]);
  const local = cloud.slice(0, 3).map((row, i) => ({ ...row, folder: 'Local cache', id: i + 1, indexStatus: 'indexed' }));
  const original = JSON.stringify(local);
  const merged = catalog.mergeBookmarkCatalog(local, fetched);
  assert.equal(merged.length, 2477, 'Cloud records must load even when the local cache is nonempty');
  assert.equal(JSON.stringify(local), original, 'Do not mutate local records');
  assert.equal(new Set(merged.map(row => row.id)).size, 2477, 'Search IDs must not collide');
  assert.equal(new Set(merged.map(row => row.folder)).size, 26);
  assert.equal(merged[0].id, 1);
  assert.equal(merged[0].folder, 'Folder 0');
  assert.equal(catalog.bookmarkFolderLabel(recovered), 'OM');
  assert.equal(merged.at(-1).folder, recovered, 'OM is a display label, not a database move');
  assert.equal(catalog.bookmarkFolderLabel('Bookmarks bar/Tools'), 'Bookmarks bar/Tools');
  await assert.rejects(catalog.fetchBookmarkCatalog({ url: 'https://test.supabase.co', anonKey: 'test' }, async () => ({ ok: false, status: 503 })));

  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(options.method, 'GET', 'Folder discovery must be read-only');
    const offset = Number(new URL(url).searchParams.get('offset'));
    return { ok: true, json: async () => cloud.slice(offset, offset + 500).map(row => ({ folder: row.folder })) };
  };
  try {
    const backend = load('backend/src/supabase-search.ts');
    const folders = await backend.getSupabaseFolders();
    assert.equal(folders.length, 26);
    assert.ok(folders.includes(recovered), 'Include folders found beyond the first API page');
  } finally { global.fetch = originalFetch; }

  const labels = load('webapp/src/lib/bookmark-folders.ts');
  assert.equal(labels.bookmarkFolderLabel(recovered), 'OM');
  assert.equal(labels.bookmarkFolderName(recovered), 'OM');
  assert.equal(labels.bookmarkFolderName('Bookmarks bar/Tools'), 'Tools');
  const boardCatalog = load('src/extension/pinterest-board-catalog.ts');
  const boardRows = ['tracker', 'figbruary', 'OpenMemory', 'tracker', null, '', 'Test board'].map(board_name => ({ board_name }));
  const boardOffsets = [];
  const boards = await boardCatalog.fetchPinterestBoardNames({ url: 'https://test.supabase.co', anonKey: 'test' }, async (url, options) => {
    assert.equal(options.method, 'GET');
    const endpoint = new URL(url);
    assert.equal(endpoint.pathname, '/rest/v1/pinterest_boards');
    assert.equal(endpoint.searchParams.get('select'), 'board_name', 'No pin download needed for board names');
    const offset = Number(endpoint.searchParams.get('offset'));
    boardOffsets.push(offset);
    return { ok: true, json: async () => boardRows.slice(offset, offset + 2) };
  });
  assert.deepEqual(boardOffsets, [0, 2, 4, 6, 7]);
  assert.deepEqual(boards, ['figbruary', 'OpenMemory', 'tracker']);
  assert.deepEqual(boardCatalog.collectPinterestBoardNames(boards, ['Local board', 'tracker']), ['figbruary', 'Local board', 'OpenMemory', 'tracker']);
  await assert.rejects(boardCatalog.fetchPinterestBoardNames({ url: 'https://test.supabase.co', anonKey: 'test' }, async () => ({ ok: false, status: 503 })));
  console.log('Passed: complete catalog, partial local cache, unique search IDs, paginated folders, read-only requests, and OM labels.');
})().catch(error => { console.error(error); process.exitCode = 1; });
