import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// This worker polls Supabase directly. No public endpoint or inbound port is needed.
dotenv.config({ path: 'scripts/.env', quiet: true });
dotenv.config({ path: 'backend/.env', quiet: true });
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!url || !key) throw new Error('Set SUPABASE_URL and a Supabase key in scripts/.env');
const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const boardFilter = process.argv.find(arg => arg.startsWith('https://'));
const once = process.argv.includes('--once');
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const listener = createServer();
await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
process.env.EMBED_SERVER_PORT = String((listener.address() as {port:number}).port);
await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
const logPath = path.join(tmpdir(), 'openmemory-image-worker-model.log');
const log = createWriteStream(logPath, { flags: 'a' });
const model = spawn(process.env.PYTHON_COMMAND || 'python', ['backend/python/embed_server.py'], {
  env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
});
model.stdout?.pipe(log, {end:false}); model.stderr?.pipe(log, {end:false});
let stopping = false;
let spawnError: Error | undefined;
model.on('error', error => { spawnError = error; stopping = true; });
process.on('SIGINT', () => { stopping = true; model.kill(); });
process.on('SIGTERM', () => { stopping = true; model.kill(); });
const { runPinterestEmbeddingJob, pinterestEmbeddingCounts } = await import('../backend/src/pinterest-embeddings');

async function pendingBoards(): Promise<string[]> {
  const boards = new Set<string>();
  for (let offset = 0; ; offset += 500) {
    let query = client.from('pinterest_pins').select('board_url').is('image_embedding', null).order('id').range(offset, offset + 499);
    if (boardFilter) query = query.eq('board_url', boardFilter);
    const { data, error } = await query;
    if (error) throw new Error(`Could not read pending image pins: ${error.message}`);
    for (const row of data || []) if (row.board_url) boards.add(row.board_url);
    if (!data || data.length < 500) break;
  }
  return [...boards];
}

try {
  console.log(`Separate image worker started. Model logs: ${logPath}`);
  while (!stopping) {
    if (spawnError) throw spawnError;
    if (model.exitCode !== null) throw new Error(`Model process exited (${model.exitCode}); inspect ${logPath}`);
    try {
      for (const board of await pendingBoards()) {
        if (stopping) break;
        console.log('Processing:', board);
        await runPinterestEmbeddingJob(board, undefined, { imagesOnly: true });
        const counts = await pinterestEmbeddingCounts(board);
        console.log('Remaining:', JSON.stringify(counts));
        if (once && counts.imageMissing) process.exitCode = 1;
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Image worker failed');
      if (once) { process.exitCode = 1; break; }
    }
    if (once) break;
    // Missing vectors themselves are the persistent queue; completed ones are skipped.
    console.log('Watching for newly imported pins (checks every 60 seconds).');
    for (let i = 0; i < 60 && !stopping; i++) await delay(1000);
  }
  if (spawnError) throw spawnError;
} finally {
  model.kill();
  log.end();
}
