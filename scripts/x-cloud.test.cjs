const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { webcrypto } = require('node:crypto');
global.crypto ||= webcrypto;
const load = code => { const mod = { exports: {} }; new Function('module', 'exports', 'require', code)(mod, mod.exports, require); return mod.exports; };
(async () => {
  const post = { id: '1', url: 'https://x.com/i/status/1', title: 'Design systems', extendedContent: 'Accessible component libraries', author: '@designer', indexedAt: 1 };
  const rows = new Map([['1', post]]);
  const settings = { xCloudEnabled: true, xBrowserConnection: { enabled: true, paused: false, username: 'owner' }, supabaseUrl: 'https://project.example', supabaseAnonKey: 'test-key' };
  global.__cloudDb = { xBookmarks: { toArray: async () => [...rows.values()], get: async id => rows.get(id), put: async row => rows.set(row.id, row) }, transaction: async (...args) => args.at(-1)() };
  global.chrome = { storage: { local: { get: async () => structuredClone(settings), set: async value => Object.assign(settings, structuredClone(value)) } }, alarms: { create: async () => {}, clear: async () => {} } };
  const code = await esbuild.build({ entryPoints: ['src/extension/x-cloud.ts'], bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'cloud-mocks', setup(b) {
      b.onResolve({ filter: /^\.\/db$/ }, () => ({ path: 'db', namespace: 'test' }));
      b.onResolve({ filter: /^\.\/embedding-jobs$/ }, () => ({ path: 'embedding', namespace: 'test' }));
      b.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({ contents: path === 'db' ? 'export const db = globalThis.__cloudDb;' : 'export const embeddingBackendUrl = async () => "https://worker.example";' }));
    } }] });
  let uploads = 0, jobs = 0, fail = false;
  global.fetch = async (url, init) => {
    if (String(url).includes('/rest/v1/')) {
      uploads++;
      const payload = JSON.parse(init.body);
      assert.equal(payload[0].description, post.extendedContent);
      assert.ok(!('embedding' in payload[0]), 'Upsert must preserve generated vectors');
      if (fail) return { ok: false, status: 503 };
      return { ok: true, status: 204 };
    }
    if (String(url).endsWith('/x-embedding-status')) return { ok: true, json: async () => ({ total: 1, textMissing: 1, imageMissing: 0 }) };
    jobs++; assert.equal(JSON.parse(init.body).supabase_url, settings.supabaseUrl);
    return { ok: true, json: async () => ({ accepted: true }) };
  };
  const cloud = load(code.outputFiles[0].text);
  await cloud.flushXCloud(); assert.equal(uploads, 1); assert.equal(jobs, 1); assert.ok(rows.get('1').cloudHash);
  await cloud.flushXCloud(); assert.equal(uploads, 1, 'Unchanged posts are not uploaded twice'); assert.equal(jobs, 2, 'Missing vectors remain retryable');
  rows.set('1', { ...rows.get('1'), title: 'Changed post' }); fail = true;
  const priorHash = rows.get('1').cloudHash;
  await cloud.flushXCloud(); assert.equal(rows.get('1').cloudHash, priorHash); assert.ok(settings.xCloudStatus.error);
  const attempted = uploads; await cloud.flushXCloud(); assert.equal(uploads, attempted, 'Failures back off');
  settings.xCloudStatus.retryAt = 0; fail = false;
  const restarted = load(code.outputFiles[0].text); await restarted.flushXCloud(); assert.notEqual(rows.get('1').cloudHash, priorHash);
  settings.xCloudEnabled = false; await restarted.flushXCloud(); assert.equal(uploads, attempted + 1);
  console.log('Passed X cloud: durable retries, restart, deduplication, full post text, project matching, opt-out and vector-preserving upserts.');
})().catch(error => { console.error(error); process.exitCode = 1; });
