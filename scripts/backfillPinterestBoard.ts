import dotenv from 'dotenv';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalPinterestBoardUrl } from '../src/extension/pinterest-import-policy';

dotenv.config({ path: 'scripts/.env', quiet: true });
dotenv.config({ path: 'backend/.env', quiet: true });
const boardUrl = canonicalPinterestBoardUrl(process.argv.find(arg => arg.startsWith('https://')) || '');
let worker: ReturnType<typeof spawn> | undefined;
if (process.argv.includes('--local')) {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as {port:number}).port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  process.env.EMBED_SERVER_PORT = String(port);
  worker = spawn('python', ['backend/python/embed_server.py'], { env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(path.join(tmpdir(), 'openmemory-backfill-model.log'));
  worker.stdout?.pipe(log, {end:false}); worker.stderr?.pipe(log, {end:false});
  console.log('Starting the local embedding models...');
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try { ready = (await fetch(`http://127.0.0.1:${port}/health`, {signal:AbortSignal.timeout(1000)})).ok; } catch {}
    if (ready) break;
    if (worker.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve,1000));
  }
  if (!ready) { worker.kill(); throw new Error('Local models did not start; see openmemory-backfill-model.log in the temporary directory'); }
}
const { runPinterestEmbeddingJob, pinterestEmbeddingCounts } = await import('../backend/src/pinterest-embeddings');
try {
console.log('Before:', await pinterestEmbeddingCounts(boardUrl));
console.log('Result:', await runPinterestEmbeddingJob(boardUrl));
const remaining = await pinterestEmbeddingCounts(boardUrl);
console.log('After:', remaining);
if (remaining.textMissing || remaining.imageMissing) process.exitCode = 1;
} finally { worker?.kill(); }
