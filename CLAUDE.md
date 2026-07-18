# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

The whole project is one Deno module: `supabase/functions/open_brain_mcp/` (dependencies pinned in its `deno.json`, no `node_modules`).

### Build and Run
- **Type-check**: `deno check supabase/functions/open_brain_mcp/index.ts`
- **Run locally**: `deno run --allow-net --allow-env supabase/functions/open_brain_mcp/index.ts` (needs the env vars below)
- **Serve via Supabase CLI** (matches the production edge runtime exactly): `supabase functions serve open_brain_mcp`
- **Deploy**: `supabase functions deploy open_brain_mcp`
- **Apply schema**: `supabase db push` (runs `supabase/schema/*.sql` in numeric order — see Database below)

Required env vars (Supabase function secrets, or a local `--env-file`): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY`, `MCP_ACCESS_KEY`, and optionally `OPEN_BRAIN_CITATION_BASE_URL`.

### Testing
There is no test suite, linter, or CI configured in this repo. `deno check` is the only automated verification available — after any change to `index.ts`, also manually exercise the affected tool via `supabase functions serve` plus an MCP client (or curl with `x-brain-key`) before considering the change done, since schema drift between a tool's Zod `outputSchema` and the object it actually returns will not throw (see SDK Notes below) and won't be caught by type-checking alone.

## Code Architecture

This is a single Supabase Edge Function implementing an MCP server for a shared, semantic-searchable AI memory ("thoughts"). See [docs/architecture.md](docs/architecture.md) for the full data-flow diagrams; the essentials:

### Structure
- `supabase/functions/open_brain_mcp/index.ts` — the entire server: type defs, OpenRouter helpers, all 6 MCP tool registrations, and the Hono app/auth/CORS layer. There is no other source file.
- `supabase/schema/*.sql` — numbered, applied in order: `1_thoughts_table`, `2_semantic_search_function` (`match_thoughts` RPC), `3_row_level_security`, `4_grant_service_role_access`, `5_deduplication` (`content_fingerprint` column + `upsert_thought` RPC), `6_get_thought_stats_function` (`get_thought_stats` RPC). Treat these as an ordered migration log, not a single schema file — a change to the `thoughts` table shape should be a new numbered file, not an edit to `1_thoughts_table.sql`.
- `docs/architecture.md` — the authoritative architecture writeup (component diagram, capture/search data flows, operational principles). Read it before making structural changes.

### Key Technologies
- **Runtime**: Deno, deployed as a Supabase Edge Function
- **Web framework**: Hono, via `@hono/mcp`'s `StreamableHTTPTransport` for the MCP protocol layer
- **MCP SDK**: `@modelcontextprotocol/sdk` (pinned `1.24.3` in `deno.json`)
- **Validation**: `zod` (pinned `4.1.13`)
- **DB client**: `@supabase/supabase-js`, using the service-role key — RLS restricts all table access to `service_role` (`supabase/schema/3_row_level_security.sql`), so the function is the only writer/reader
- **LLM/embeddings**: OpenRouter — `openai/text-embedding-3-small` for embeddings, `openai/gpt-4o-mini` (JSON mode) for metadata extraction

### Request lifecycle
One shared `McpServer` instance lives for the life of the function; a new `StreamableHTTPTransport` is created per request (`app.all("*", ...)` in `index.ts`) since the transport is stateful per-connection but the server registration isn't. Every request must carry `x-brain-key` (header or `?key=` query param) matching `MCP_ACCESS_KEY`, checked before the transport is created.

### The 6 registered tools
- `search` / `fetch` — read-only pair with the exact tool shape ChatGPT connectors/deep research expect. Don't rename their fields (`thought_id`/`title`/`url` for search results) without checking that compatibility contract.
- `search_thoughts`, `list_thoughts`, `thought_stats` — richer read tools for other MCP clients (Claude, etc.).
- `capture_thought` — the only write path.

### Capture flow
`capture_thought` runs embedding generation and metadata extraction in parallel (`Promise.all`), then calls the `upsert_thought` Postgres RPC — which fingerprints content via SHA256 and either inserts or merges metadata into an existing row keyed by `content_fingerprint`. The embedding is written back with a **separate** `update` call afterward, because `upsert_thought` can't accept a `vector` parameter directly. This means a thought can briefly exist with content/metadata but no embedding (unsearchable) if the process dies between the two calls — this is intentional (see "safe-capture" below), not a bug to "fix" by merging the calls.

### Search flow
Query text → embedding (OpenRouter) → `match_thoughts` RPC (pgvector cosine similarity over an HNSW index, with an optional JSONB `@>` containment filter). `match_thoughts` returns a column named `id`; the tool handlers map that to the client-facing `thought_id` field — don't rename the RPC's `id` column or the mapping breaks silently (this regressed once, see commit `7a1bc50`).

### Operational principles (from docs/architecture.md)
- **Append-only integrity**: updates merge/refine rather than overwrite; don't add destructive update paths.
- **Safe-capture pattern**: content is persisted before enrichment (embedding/metadata) completes, so a failure in the OpenRouter calls never loses the raw thought — it just stays temporarily unsearchable/under-tagged.
- **Security through isolation**: all external access goes through the edge function's `service_role`; clients never get direct Postgres credentials.

## Git Workflow

`main` is branch-protected: direct pushes are rejected, and merging requires the `type-check` CI check (`.github/workflows/ci.yml`, runs `deno check`) to pass. For any change beyond a one-line doc fix: create a feature branch, commit there, push it, and open a PR into `main`. There's no way around the PR step — plan for the branch+PR up front.

## MCP SDK Notes
- If a tool declares `outputSchema`, the handler must build a matching `structuredContent` object itself — the SDK does not auto-populate or validate `structuredContent` against `outputSchema`/`content` at runtime. Every tool here funnels through `toToolResult<T>()` to keep the two in sync; use it rather than constructing `CallToolResult` by hand.
- `inputSchema` takes a plain Zod raw shape (object of fields), not a `z.object(...)` — the SDK wraps it internally. `outputSchema` is the opposite: a full `z.object(...)`.
- A zero-argument tool (`thought_stats`) still needs `inputSchema: {}` — omitting it is invalid for this SDK version.
- Auth/protocol failures are returned as JSON-RPC error envelopes over HTTP 200, not bare 4xx — strict MCP hosts (Claude Code, Codex CLI) treat a transport-level 4xx as a fatal connection error rather than an application error, so `unauthorizedResponse()` in `index.ts` deliberately stays inside the JSON-RPC envelope.
- Claude Desktop's connector client omits the `Accept: text/event-stream` header `StreamableHTTPTransport` expects; `index.ts` patches the request headers before handing off to the transport if it's missing. Don't remove this without confirming Claude Desktop connectors still work (see the linked issue in the code comment).
