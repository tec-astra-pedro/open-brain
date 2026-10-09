# AGENTS.md (also CLAUDE.md)

This file provides guidance to coding agents when working with code in this repository.

## What this is

Open Brain is an MCP server that gives AI agents a shared, semantic-searchable memory ("thoughts"). It's a single Supabase Edge Function (Deno/TypeScript, `supabase/functions/open_brain_mcp/index.ts`) backed by a Postgres/pgvector database, using OpenRouter for embeddings and metadata extraction.

## Commands

All work happens inside `supabase/functions/open_brain_mcp/` (a Deno project with its own `deno.json`).

```bash
# Type-check the function
deno check supabase/functions/open_brain_mcp/index.ts

# Run the function locally (requires env vars below)
deno run --allow-net --allow-env supabase/functions/open_brain_mcp/index.ts

# Serve via the Supabase CLI (matches production edge runtime)
supabase functions serve open_brain_mcp

# Deploy
supabase functions deploy open_brain_mcp

# Apply schema changes (run schema/*.sql in order against the Supabase project)
supabase db push
```

There is no test suite or linter configured in this repo currently.

Required env vars (set as Supabase function secrets, or locally via `.env`/`--env-file`): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY`, `MCP_ACCESS_KEY`, and optionally `OPEN_BRAIN_CITATION_BASE_URL`.

## Architecture

See [docs/architecture.md](docs/architecture.md) for the full picture; the essentials:

- **Single entrypoint**: `supabase/functions/open_brain_mcp/index.ts` is a Hono app wrapping an `McpServer` (from `@modelcontextprotocol/sdk`). A new `StreamableHTTPTransport` is created per request; the `McpServer` instance itself is shared/stateless across requests.
- **Auth**: every request must carry `x-brain-key` header (or `?key=` query param) matching `MCP_ACCESS_KEY`. Failures return a JSON-RPC error envelope with HTTP 200 (not a bare 401) — strict MCP hosts like Claude Code/Codex tear down the connection on transport-level 4xx, so auth/protocol errors must stay inside the JSON-RPC envelope.
- **Six MCP tools registered on the server**:
  - `search` / `fetch` — ChatGPT-compatible read-only pair (exact tool shape required for ChatGPT connectors/deep research).
  - `search_thoughts`, `list_thoughts`, `thought_stats` — richer read tools for other MCP clients.
  - `capture_thought` — the only write path.
- **Capture flow**: `capture_thought` runs embedding generation (OpenRouter `text-embedding-3-small`) and metadata extraction (OpenRouter `gpt-4o-mini`, JSON mode) in parallel, then calls the `upsert_thought` Postgres RPC (handles SHA256-fingerprint-based dedup + metadata merge on conflict), then writes the embedding back with a separate `update` call (the RPC can't accept a vector param directly).
- **Search flow**: query text → embedding → `match_thoughts` RPC (pgvector cosine similarity via HNSW index, with optional JSONB metadata containment filter).
- **Database** (`supabase/schema/*.sql`, applied in numeric order): `thoughts` table (`content`, `embedding vector(1536)`, `metadata jsonb`, `content_fingerprint`), `match_thoughts` and `get_thought_stats` RPC functions, RLS restricted to `service_role`.
- **Operational principles** (see architecture doc): append-only integrity (no destructive overwrites), safe-capture (text is saved before enrichment completes so nothing is lost if embedding/metadata calls fail), all external access goes through the edge function's `service_role` — clients never touch Postgres directly.

## MCP SDK Notes

- Installed version: check `node_modules/@modelcontextprotocol/sdk/package.json` (types live in `dist/esm/types.d.ts`, runtime behavior in `dist/esm/server/index.js`) — don't assume spec behavior without checking the installed version, the SDK's surface changes across releases.
- If a tool declares `outputSchema`, the `CallToolRequestSchema` handler must also return `structuredContent` matching it — the SDK does **not** auto-populate `structuredContent` from `content`, and does **not** validate the two against each other or against `outputSchema` at runtime. A drift between them will not throw; it has to be caught by tests.
- For `Tool`, both a top-level `title` and `annotations.title` are valid fields, but `annotations.title` takes precedence if both are set — set only one.

## Conventions in this file

Comments in `index.ts` are used deliberately to explain *why*, not *what* — e.g. why the Accept header gets patched for Claude Desktop, why auth errors use a JSON-RPC envelope instead of HTTP 401, why the embedding write is a separate call from the upsert. Preserve that style when editing.
