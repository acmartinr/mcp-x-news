import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { ErrorCode, isInitializeRequest, McpError } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';

async function loadEnvFileIfPresent(envFilePath) {
  try {
    const raw = await fs.readFile(envFilePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;

      const key = trimmed.slice(0, eq).trim();
      if (!key) continue;

      if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;

      let value = trimmed.slice(eq + 1).trim();
      // Strip surrounding quotes if present.
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return;
    // Non-ENOENT parse/read errors should be visible.
    throw err;
  }
}

function normalizeBearerToken(rawToken) {
  const trimmed = String(rawToken).trim();
  // Some tokens end up URL-encoded in env files. Try decoding; fall back if invalid.
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

function getBearerTokenOrThrow() {
  const raw = process.env.X_BEARER_TOKEN || "AAAAAAAAAAAAAAAAAAAAAFnD%2BAEAAAAAv8pNddMt0rrrya3%2F%2FsX2sIK%2B2Oc%3DsCKDSGaPCPJIK5EweMy2WtCeCiQckraToG0FCkb0BZCbsFgbSf";
  if (!raw) {
    throw new McpError(
      ErrorCode.InternalError,
      'Missing X_BEARER_TOKEN. Set it in the environment or in a .env file next to this server.'
    );
  }
  return normalizeBearerToken(raw);
}

function getXApiBaseUrl() {
  // X API v2 historically used api.twitter.com; keep configurable.
  return (process.env.X_API_BASE_URL || 'https://api.twitter.com/2').replace(/\/+$/, '');
}

function toCommaList(value) {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value.join(',');
  return String(value);
}

async function xApiGet(pathname, query) {
  const baseUrl = getXApiBaseUrl();
  const url = new URL(`${baseUrl}${pathname.startsWith('/') ? '' : '/'}${pathname}`);
  const sp = url.searchParams;

  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null) continue;
    sp.set(k, toCommaList(v));
  }

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${getBearerTokenOrThrow()}`,
      'User-Agent': 'mcp-x-news/1.0'
    }
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const rate = {
      limit: res.headers.get('x-rate-limit-limit'),
      remaining: res.headers.get('x-rate-limit-remaining'),
      reset: res.headers.get('x-rate-limit-reset')
    };

    const details = {
      status: res.status,
      statusText: res.statusText,
      rateLimit: rate,
      error: data
    };
    throw new McpError(ErrorCode.InternalError, `X API request failed: ${JSON.stringify(details)}`);
  }

  return data;
}

function createServer() {
  const server = new McpServer(
    { name: 'mcp-x-news', version: '1.0.0' },
    { capabilities: { logging: {} } }
  );

  const defaultTweetFields = [
    'id',
    'text',
    'created_at',
    'lang',
    'author_id',
    'public_metrics',
    'source'
  ];
  const defaultUserFields = ['id', 'name', 'username', 'profile_image_url', 'verified'];

  server.registerTool(
    'x_search_recent',
    {
      description: 'Search recent posts on X (Twitter) using API v2 recent search.',
      inputSchema: {
        query: z.string().min(1).describe('X search query (v2 syntax). Example: "openai lang:en -is:retweet"'),
        max_results: z.number().int().min(1).max(100).default(10).describe('Max results (1-100).'),
        next_token: z.string().optional().describe('Pagination token from a previous response.'),
        sort_order: z.enum(['recency', 'relevancy']).optional().describe('Sort order (if supported).'),
        start_time: z.string().optional().describe('ISO timestamp (optional).'),
        end_time: z.string().optional().describe('ISO timestamp (optional).')
      }
    },
    async ({ query, max_results, next_token, sort_order, start_time, end_time }) => {
      const data = await xApiGet('/tweets/search/recent', {
        query,
        max_results,
        next_token,
        sort_order,
        start_time,
        end_time,
        // Include useful fields + author expansion so you get user objects back.
        'tweet.fields': defaultTweetFields,
        expansions: ['author_id'],
        'user.fields': defaultUserFields
      });

      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    'x_get_user_by_username',
    {
      description: 'Fetch an X user object by username (no @).',
      inputSchema: {
        username: z.string().min(1).describe('Username without @. Example: "jack".')
      }
    },
    async ({ username }) => {
      const data = await xApiGet(`/users/by/username/${encodeURIComponent(username)}`, {
        'user.fields': defaultUserFields
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    'x_get_user_tweets',
    {
      description: 'Fetch recent posts for a user ID.',
      inputSchema: {
        user_id: z.string().min(1).describe('Numeric user ID (use x_get_user_by_username first).'),
        max_results: z.number().int().min(1).max(100).default(10).describe('Max results (1-100).'),
        pagination_token: z.string().optional().describe('Pagination token from a previous response.')
      }
    },
    async ({ user_id, max_results, pagination_token }) => {
      const data = await xApiGet(`/users/${encodeURIComponent(user_id)}/tweets`, {
        max_results,
        pagination_token,
        'tweet.fields': defaultTweetFields,
        expansions: ['author_id'],
        'user.fields': defaultUserFields
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    'x_get_tweet',
    {
      description: 'Fetch a single post by Tweet ID.',
      inputSchema: {
        id: z.string().min(1).describe('Tweet ID.')
      }
    },
    async ({ id }) => {
      const data = await xApiGet(`/tweets/${encodeURIComponent(id)}`, {
        'tweet.fields': defaultTweetFields,
        expansions: ['author_id'],
        'user.fields': defaultUserFields
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  return server;
}

// Load .env from repo root (unless you already set env vars).
await loadEnvFileIfPresent(process.env.ENV_FILE || path.join(process.cwd(), '.env'));

if (!process.env.X_BEARER_TOKEN) {
  // eslint-disable-next-line no-console
  console.warn('Warning: X_BEARER_TOKEN is not set. X tools will fail until configured.');
}

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8080);

const app = createMcpExpressApp({ host: HOST });

/** @type {Record<string, import('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport | import('@modelcontextprotocol/sdk/server/sse.js').SSEServerTransport>} */
const transports = {};

// STREAMABLE HTTP TRANSPORT (protocol version 2025-11-25)
app.all('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];

    let transport;
    if (sessionId && transports[sessionId]) {
      const existing = transports[sessionId];
      if (existing instanceof StreamableHTTPServerTransport) {
        transport = existing;
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: Session exists but uses a different transport protocol'
          },
          id: null
        });
        return;
      }
    } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        }
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) delete transports[sid];
      };

      const server = createServer();
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Error handling /mcp request:', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null
      });
    }
  }
});

// LEGACY HTTP+SSE TRANSPORT (protocol version 2024-11-05)
app.get('/sse', async (req, res) => {
  try {
    const transport = new SSEServerTransport('/messages', res);
    transports[transport.sessionId] = transport;
    transport.onclose = () => {
      delete transports[transport.sessionId];
    };

    const server = createServer();
    await server.connect(transport);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Error handling /sse request:', err);
    if (!res.headersSent) res.status(500).send('Error establishing SSE stream');
  }
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) {
    res.status(400).send('Missing sessionId parameter');
    return;
  }

  const existing = transports[sessionId];
  if (!(existing instanceof SSEServerTransport)) {
    res.status(404).send('Session not found');
    return;
  }

  try {
    await existing.handlePostMessage(req, res, req.body);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Error handling /messages request:', err);
    if (!res.headersSent) res.status(500).send('Error handling request');
  }
});

const server = app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`mcp-x-news listening on http://${HOST}:${PORT}`);
  // eslint-disable-next-line no-console
  console.log('MCP endpoints:');
  // eslint-disable-next-line no-console
  console.log(`  Streamable HTTP: http://${HOST}:${PORT}/mcp`);
  // eslint-disable-next-line no-console
  console.log(`  Legacy SSE:      http://${HOST}:${PORT}/sse  (POST messages to /messages)`);
});

server.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start server:', err);
  process.exit(1);
});

async function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`Shutting down (${signal})...`);
  for (const sid of Object.keys(transports)) {
    try {
      await transports[sid].close();
    } catch {
      // ignore
    } finally {
      delete transports[sid];
    }
  }
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
