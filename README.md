# mcp-x-news

MCP server that exposes a few X (Twitter) API v2 tools.

## Config

Create `.env` (or set real env vars):

- `X_BEARER_TOKEN` (required)
- `X_API_BASE_URL` (optional, defaults to `https://api.twitter.com/2`)

## Run

```bash
npm run start
```

It serves MCP on:

- Streamable HTTP: `http://127.0.0.1:3000/mcp`
- Legacy SSE: `http://127.0.0.1:3000/sse` (POST to `/messages`)
