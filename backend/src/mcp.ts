/**
 * MCP endpoint — exposes OpenMemory to coding agents (Claude Code, Codex,
 * Cursor, ...) over Streamable HTTP at POST /mcp.
 *
 * Read-only. Protected by a bearer token (MCP_AUTH_TOKEN); the endpoint
 * refuses every request while that variable is unset.
 */
import type { Express, Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { searchAll, listFolders, listBoards, CatalogResult } from './catalog.js';
import { browseSupabase } from './supabase-search.js';
import { browseXBookmarks } from './x-bookmarks.js';

export interface McpDeps {
  /** Active (non-archived) sticky notes, newest first. */
  listNotes: () => Promise<Array<Record<string, unknown>>>;
}

// Only image CDNs the app already stores URLs for; the agent supplies the URL,
// so anything broader would turn this server into an open fetch proxy.
const IMAGE_HOSTS = new Set(['i.pinimg.com', 'pbs.twimg.com', 'video.twimg.com']);
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }] });
const failure = (message: string) => ({ ...text(message), isError: true });
const errorText = (err: unknown) => err instanceof Error ? err.message : 'Unknown error';

const SOURCE_LABEL: Record<string, string> = { chrome: 'bookmark', pinterest: 'pinterest', x: 'x' };

function present(r: CatalogResult) {
  return {
    title: r.title,
    url: r.url,
    source: SOURCE_LABEL[r.source] ?? r.source,
    collection: r.folder,
    // Bookmarks only carry a site favicon, which is noise to an agent.
    ...(r.source !== 'chrome' && r.imageUrl ? { image_url: r.imageUrl } : {}),
    ...(r.description ? { description: r.description } : {}),
    ...(r.author ? { author: r.author } : {}),
  };
}

/** Resolve a user-typed collection name against the real list, ignoring case. */
function matchName(names: string[], wanted: string): string | undefined {
  const needle = wanted.trim().toLowerCase();
  return names.find(n => n.toLowerCase() === needle);
}

function buildServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: 'openmemory', version: '1.0.0' },
    { instructions: 'OpenMemory is the user\'s personal inspiration library: Chrome bookmarks (grouped in folders), Pinterest pins (grouped in boards) and X bookmarks. Use search_inspirations to find references for the task at hand, then get_image to actually look at a pin or post image before borrowing from its design.' }
  );

  server.registerTool('search_inspirations', {
    title: 'Search inspirations',
    description: 'Semantic + keyword search over the user\'s saved bookmarks, Pinterest pins and X bookmarks. Returns title, URL, collection and (for pins and X posts) an image_url. Pin titles are often short, so try a few phrasings.',
    inputSchema: {
      query: z.string().min(1).describe('What to look for, e.g. "pricing page", "dark dashboard", "serif landing page"'),
      source: z.enum(['all', 'bookmarks', 'pinterest', 'x']).default('all').describe('Restrict to one source'),
      folder: z.string().optional().describe('Bookmark folder to search within (exact name from list_collections)'),
      board: z.string().optional().describe('Pinterest board to search within (exact name from list_collections)'),
      limit: z.number().int().min(1).max(50).default(15),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ query, source, folder, board, limit }) => {
    try {
      if (folder && board) return failure('Pass either folder or board, not both.');
      if (folder) {
        const match = matchName(await listFolders(), folder);
        if (!match) return failure(`No bookmark folder named "${folder}". Call list_collections for the available names.`);
        folder = match;
      }
      if (board) {
        const match = matchName(await listBoards(), board);
        if (!match) return failure(`No Pinterest board named "${board}". Call list_collections for the available names.`);
        board = match;
      }
      // A folder or board scopes the search to its own source.
      const backendSource = folder ? 'chrome' : board ? 'pinterest'
        : source === 'bookmarks' ? 'chrome' : source === 'all' ? undefined : source;
      const found = await searchAll(query, limit, backendSource, folder, board);
      return text({ count: found.results.length, has_more: found.hasMore, results: found.results.map(present) });
    } catch (err) {
      return failure(`Search failed: ${errorText(err)}`);
    }
  });

  server.registerTool('list_collections', {
    title: 'List collections',
    description: 'List the user\'s bookmark folders and Pinterest boards. Use the names with search_inspirations or browse_collection.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    try {
      const [bookmark_folders, pinterest_boards] = await Promise.all([listFolders(), listBoards()]);
      return text({ bookmark_folders, pinterest_boards, other_sources: ['x (browse with source "x", no collection name)'] });
    } catch (err) {
      return failure(`Could not list collections: ${errorText(err)}`);
    }
  });

  server.registerTool('browse_collection', {
    title: 'Browse a collection',
    description: 'List the newest items in one bookmark folder, one Pinterest board, or the X bookmarks, without a search query.',
    inputSchema: {
      source: z.enum(['bookmarks', 'pinterest', 'x']),
      name: z.string().optional().describe('Folder name (bookmarks) or board name (pinterest). Not used for x.'),
      limit: z.number().int().min(1).max(200).default(30),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ source, name, limit }) => {
    try {
      if (source === 'x') {
        const x = await browseXBookmarks(limit);
        return text({ count: x.results.length, results: x.results.map(present) });
      }
      if (!name) return failure(`name is required when source is "${source}". Call list_collections for the available names.`);
      const names = source === 'bookmarks' ? await listFolders() : await listBoards();
      const match = matchName(names, name);
      if (!match) return failure(`No ${source === 'bookmarks' ? 'bookmark folder' : 'Pinterest board'} named "${name}". Call list_collections for the available names.`);
      const browsed = await browseSupabase(source === 'bookmarks' ? 'chrome' : 'pinterest', match, limit);
      const results = browsed.results.slice(0, limit);
      return text({ collection: match, count: results.length, results: results.map(present) });
    } catch (err) {
      return failure(`Browse failed: ${errorText(err)}`);
    }
  });

  server.registerTool('list_notes', {
    title: 'List sticky notes',
    description: 'List the user\'s active sticky notes (title, body, to-dos), newest first. Attached images are not included.',
    inputSchema: { limit: z.number().int().min(1).max(200).default(50) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ limit }) => {
    try {
      const notes = (await deps.listNotes()).slice(0, limit).map(n => ({
        id: n.id, title: n.title, body: n.body, created_at: n.created_at,
        ...(n.todos ? { todos: n.todos } : {}),
        ...(n.pinned ? { pinned: true } : {}),
      }));
      return text({ count: notes.length, notes });
    } catch (err) {
      return failure(`Could not load notes: ${errorText(err)}`);
    }
  });

  server.registerTool('get_image', {
    title: 'View an inspiration image',
    description: 'Fetch the image behind an image_url returned by search_inspirations or browse_collection, so you can look at the actual design. Only Pinterest and X image URLs are accepted.',
    inputSchema: { image_url: z.string().url() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ image_url }) => {
    try {
      const url = new URL(image_url);
      if (url.protocol !== 'https:' || !IMAGE_HOSTS.has(url.hostname)) {
        return failure(`Only https image URLs on ${[...IMAGE_HOSTS].join(', ')} can be fetched.`);
      }
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
      if (!response.ok) return failure(`Image request failed (${response.status}).`);
      const mimeType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
      if (!mimeType.startsWith('image/')) return failure('That URL did not return an image.');
      if (Number(response.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) return failure('Image is larger than 4 MB.');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_IMAGE_BYTES) return failure('Image is larger than 4 MB.');
      return { content: [{ type: 'image' as const, data: bytes.toString('base64'), mimeType }] };
    } catch (err) {
      return failure(`Could not fetch image: ${errorText(err)}`);
    }
  });

  return server;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

function requireToken(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.MCP_AUTH_TOKEN;
  if (!expected) {
    return res.status(503).json({ jsonrpc: '2.0', error: { code: -32000, message: 'MCP is disabled: set MCP_AUTH_TOKEN on the backend.' }, id: null });
  }
  const header = req.headers.authorization ?? '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  // Compare digests so the check is constant-time regardless of length.
  if (!supplied || !timingSafeEqual(digest(supplied), digest(expected))) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
  }
  next();
}

export function mountMcp(app: Express, deps: McpDeps) {
  // Stateless: a fresh server + transport per request, so nothing is held in
  // memory between calls and a Render restart never strands a session.
  app.post('/mcp', requireToken, async (req, res) => {
    const server = buildServer(deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[MCP] request failed:', err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  });

  const notAllowed = (_req: Request, res: Response) => {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  };
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
