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
  const sync = load('src/extension/bookmark-sync-state.ts');
  const stored = { title: 'Docs', folder: 'Tools', chrome_id: '7' };
  const local = { url: 'https://example.com', title: 'Docs', folder: 'Tools', chrome_id: '7' };

  // The regression: an unchanged, already-embedded bookmark must not be rewritten.
  assert.deepEqual(sync.planBookmarkWrite(local, stored, true), { write: false, embed: false });
  assert.deepEqual(sync.planBookmarkWrite(local, undefined, false), { write: true, embed: true }, 'New bookmarks are written and embedded');
  assert.deepEqual(sync.planBookmarkWrite(local, stored, false), { write: true, embed: true }, 'A missing embedding is filled in');
  assert.deepEqual(sync.planBookmarkWrite({ ...local, title: 'Docs v2' }, stored, true), { write: true, embed: true }, 'A new title is re-embedded');
  assert.deepEqual(sync.planBookmarkWrite({ ...local, folder: 'Reading' }, stored, true), { write: true, embed: false }, 'A move is written without re-embedding');
  assert.deepEqual(sync.planBookmarkWrite({ ...local, chrome_id: '8' }, stored, true), { write: true, embed: false });
  assert.deepEqual(sync.planBookmarkWrite(local, stored, true, true), { write: true, embed: true }, 'A forced embedding still writes');
  assert.deepEqual(sync.planBookmarkWrite({ url: local.url, title: 'Docs', folder: null }, { title: 'Docs', folder: null, chrome_id: null }, true),
    { write: false, embed: false }, 'Absent folder and chrome id compare equal to stored nulls');

  // The snapshot is read-only, paginates past a server row cap, and never downloads vectors.
  const cloud = Array.from({ length: 2484 }, (_, i) => ({ url: `https://example.com/${i}`, title: `B${i}`, folder: 'F', chrome_id: String(i) }));
  const unembedded = cloud.filter((_, i) => i % 1000 === 3).map(row => ({ url: row.url }));
  const mockFetch = async (url, options) => {
    assert.equal(options.method, 'GET', 'Loading sync state must never write');
    const params = new URL(url).searchParams;
    assert.ok(!params.get('select').includes('embedding'), 'Do not download embeddings');
    assert.equal(params.get('order'), 'id.asc');
    const source = params.get('embedding') === 'is.null' ? unembedded : cloud;
    if (params.get('embedding') === 'is.null') assert.equal(params.get('select'), 'url');
    else assert.equal(params.get('select'), 'url,title,folder,chrome_id');
    const offset = Number(params.get('offset'));
    return { ok: true, json: async () => source.slice(offset, offset + 700) };
  };
  const state = await sync.fetchBookmarkSyncState({ url: 'https://test.supabase.co/', anonKey: 'test' }, mockFetch);
  assert.equal(state.rows.size, 2484, 'Every page is loaded');
  assert.deepEqual([...state.missingEmbedding], ['https://example.com/3', 'https://example.com/1003', 'https://example.com/2003']);

  // A routine sync of an unchanged library plans zero writes apart from missing embeddings.
  const writes = cloud.filter(row => sync.planBookmarkWrite(row, state.rows.get(row.url), !state.missingEmbedding.has(row.url)).write);
  assert.equal(writes.length, 3);

  await assert.rejects(sync.fetchBookmarkSyncState({ url: 'https://test.supabase.co', anonKey: 'test' }, async () => ({ ok: false, status: 503 })),
    'A failed read must not look like an empty cloud');
  console.log('bookmark-sync-state tests passed');
})().catch(error => { console.error(error); process.exit(1); });
