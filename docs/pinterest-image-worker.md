# Separate Pinterest image worker

Render's 512 MB service generates text vectors. It refuses to load the CLIP image
model because that operation has repeatedly exceeded its memory budget. A separate
worker processes missing image vectors directly from Supabase, without opening an
inbound port. It uses the existing 512-dimensional CLIP model and never replaces
completed vectors or writes placeholders.

## Run on a computer or another server

Use a machine with enough memory for Python, CLIP, and inference. Install Node.js
and Python, then from the repository root:

```sh
npm install
python -m pip install -r backend/python/requirements.txt
```

Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `scripts/.env` on the worker.
The existing `SUPABASE_ANON_KEY` also works when the table's access rules allow it.
Keep credentials on the worker, never in a public frontend or committed file.

```sh
npm run embeddings:images
```

The worker scans missing image vectors every 60 seconds. New imports enter this
queue automatically; failed images remain NULL for a later retry. Keep the process
running for continuous processing. When it stops, imports and text generation still
work, but image vectors wait until it runs again. Machine login/startup automation
or a server process manager must be configured separately for unattended operation.

For a single board and one pass (including Windows):

```sh
node --import tsx scripts/pinterestImageWorker.ts --once https://www.pinterest.com/tejopriya_chebrolu/portfolio-references/
```

The model server listens only on loopback on a dynamically assigned port. Model
logs are in the system temporary directory as `openmemory-image-worker-model.log`.
Stop the worker with Ctrl+C. A one-pass run exits nonzero if images remain missing.

## Memory guard

The Python server reads the container memory limit and blocks image loading at
512 MB or less. On Render, if that limit cannot be read, it assumes the current
512 MB Free configuration. On a larger worker with an unreadable container limit,
set `EMBED_MEMORY_LIMIT_MB` to that worker's actual memory budget. This setting
does not allocate RAM or change the hosting plan.
