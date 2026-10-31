const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const load = code => { const mod = { exports: {} }; new Function('module', 'exports', 'require', code)(mod, mod.exports, require); return mod.exports; };
(async () => {
  process.env.SUPABASE_URL = 'https://project.example'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  const rows = [{ id: '01', title: 'Design', description: 'Component library', author: '@designer', image_url: 'https://pbs.twimg.com/media/a.jpg', updated_at: '2026-10-31T00:00:00Z', embedding: null, image_embedding: null },
    { id: '02', title: 'Broken image', description: 'No zero vectors', author: '@designer', image_url: 'https://pbs.twimg.com/media/b.jpg', updated_at: '2026-10-31T00:00:00Z', embedding: null, image_embedding: null }];
  const calls = [];
  global.fetch = async (url, init) => {
    const parsed = new URL(url); calls.push({ parsed, init });
    if (parsed.pathname.endsWith('rpc/search_x_bookmarks')) {
      assert.equal(JSON.parse(init.body).search_query, 'components');
      return { ok: true, json: async () => [{ title: 'Design', url: 'https://x.com/i/status/1', account_username: 'owner', score: 0.8, similarity: 0.7, keyword_score: 0.8 }] };
    }
    if (init.method === 'PATCH') {
      const row = rows.find(r => `eq.${r.id}` === parsed.searchParams.get('id'));
      assert.equal(parsed.searchParams.get('updated_at'), `eq.${row.updated_at}`, 'Avoid attaching stale vectors');
      Object.assign(row, JSON.parse(init.body));
      return { ok: true, json: async () => [{ id: row.id }] };
    }
    const column = parsed.searchParams.has('embedding') ? 'embedding' : 'image_embedding';
    const cursor = parsed.searchParams.get('id')?.slice(3);
    return { ok: true, json: async () => rows.filter(row => !row[column] && (!cursor || row.id > cursor)).slice(0, Number(parsed.searchParams.get('limit'))) };
  };
  const output = await esbuild.build({ entryPoints: ['backend/src/x-bookmarks.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'embedding-mocks', setup(b) {
      b.onResolve({ filter: /^\.\/embeddings\.js$/ }, () => ({ path: 'embeddings', namespace: 'test' }));
      b.onResolve({ filter: /^\.\/pinterest-embeddings\.js$/ }, () => ({ path: 'queue', namespace: 'test' }));
      b.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({ contents: path === 'queue' ? 'export const enqueueEmbeddingWork = task => task();' :
        'export const checkEmbedServerAvailable = async () => true; export const generateQueryEmbedding = async () => Array(384).fill(0.1); export const generateTextEmbeddings = async texts => texts.map(() => Array(384).fill(0.1)); export const generateImageEmbeddings = async urls => urls.map(url => url.includes("/a.") ? Array(512).fill(0.1) : null);' }));
    } }] });
  const worker = load(output.outputFiles[0].text);
  await worker.runXEmbeddings();
  assert.ok(rows.every(row => row.embedding?.length === 384));
  assert.ok(rows.every(row => row.image_embedding === null), 'Free Render only runs text');
  const writes = calls.filter(c => c.init.method === 'PATCH').length;
  await worker.runXEmbeddings(); assert.equal(calls.filter(c => c.init.method === 'PATCH').length, writes);
  await worker.runXEmbeddings(true); assert.equal(rows[0].image_embedding.length, 512); assert.equal(rows[1].image_embedding, null);
  const result = await worker.searchXBookmarks('components'); assert.equal(result.results[0].source, 'x');
  console.log('Passed X embeddings: text backfill, existing-vector preservation, image-worker separation, failed images stay NULL, stale-write guards and semantic search mapping.');
})().catch(error => { console.error(error); process.exitCode = 1; });
