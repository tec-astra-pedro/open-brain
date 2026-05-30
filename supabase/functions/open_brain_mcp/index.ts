import "@supabase/functions-js/edge-runtime.d.ts";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY")!;

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

type ThoughtMetadata = {
  people?: string[];
  action_items?: string[];
  dates_mentioned?: string[];
  topics?: string[];
  type?: "observation" | "task" | "idea" | "reference" | "person_note";
  source?: string;
};

type ThoughtMatch = {
  thought_id: string;
  content: string;
  metadata: ThoughtMetadata;
  similarity: number;
  created_at: string;
};

type ThoughtRecord = {
  id: string;
  content: string;
  metadata: ThoughtMetadata;
  created_at: string;
  updated_at?: string | null;
};

type OpenRouterEmbeddingResponse = {
  data: Array<{ embedding: number[] }>;
};

type OpenRouterChatResponse = {
  choices: Array<{
    message: {
      content: string | null;
      refusal?: string | null;
    };
  }>;
};

// Output types mirroring each tool's outputSchema — used to type-check the
// data we construct before handing it off to toToolResult().
type SearchOutput = {
  results: Array<{ thought_id: string; title: string; url: string }>;
  error?: string;
  guidance?: string;
};

type FetchOutput = {
  thought_id?: string;
  title?: string;
  text?: string;
  url?: string;
  metadata?: ThoughtMetadata & { created_at?: string; updated_at?: string | null };
  error?: string;
  guidance?: string;
};

type SearchThoughtsOutput = {
  thoughts: Array<{
    thought_id: string;
    content: string;
    similarity: number;
    type?: string;
    topics?: string[];
    people?: string[];
    action_items?: string[];
    created_at: string;
  }>;
  error?: string;
  guidance?: string;
};

type ListThoughtsOutput = {
  thoughts: Array<{
    thought_id: string;
    content: string;
    type?: string;
    topics?: string[];
    people?: string[];
    action_items?: string[];
    created_at: string;
  }>;
  error?: string;
  guidance?: string;
};

type ThoughtStatsOutput = {
  total?: number;
  date_range?: string;
  types?: Record<string, number>;
  topics?: Record<string, number>;
  people?: Record<string, number>;
  error?: string;
  guidance?: string;
};

type CaptureThoughtOutput = {
  thought_id?: string;
  type?: string;
  topics?: string[];
  people?: string[];
  action_items?: string[];
  error?: string;
  guidance?: string;
};

type JsonRpcId = string | number | null;

const CITATION_BASE_URL = Deno.env.get("OPEN_BRAIN_CITATION_BASE_URL") ||
  "https://openbrain.local/thoughts";

function thoughtTitle(content: string, createdAt?: string): string {
  const firstLine = content.replace(/\s+/g, " ").trim().slice(0, 80);
  const datePrefix = createdAt
    ? new Date(createdAt).toLocaleDateString()
    : "Open Brain";
  return firstLine ? `${datePrefix} - ${firstLine}` : `${datePrefix} thought`;
}

function thoughtUrl(thought_id: string): string {
  return `${CITATION_BASE_URL.replace(/\/$/, "")}/${thought_id}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Wraps a typed structured output into the MCP CallToolResult shape.
// The SDK always requires a `content` array alongside `structuredContent`.
function toToolResult<T extends object>(data: T): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
  };
}

async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`OpenRouter embeddings failed: ${r.status} ${msg}`);
  }
  const d = await r.json() as OpenRouterEmbeddingResponse;
  return d.data[0].embedding;
}

async function extractMetadata(text: string): Promise<ThoughtMetadata> {
  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  const d = await r.json() as OpenRouterChatResponse;
  const choice = d.choices?.[0];
  if (choice?.message?.refusal) {
    console.warn("OpenAI model refused request:", choice.message.refusal);
    return { topics: ["uncategorized"], type: "observation" };
  }
  try {
    return JSON.parse(choice?.message?.content ?? "") as ThoughtMetadata;
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

// --- MCP Server Setup ---

const server = new McpServer({
  name: "open-brain",
  version: "1.0.0",
});

// ChatGPT compatibility: restricted connector surfaces, company knowledge, and deep
// research look for exact read-only `search` and `fetch` tool shapes.
server.registerTool(
  "search",
  {
    title: "Search Open Brain",
    description:
      "Search Open Brain memories by meaning. Use this read-only compatibility tool when ChatGPT needs search/fetch-style access to stored thoughts.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    inputSchema: {
      query: z.string().describe(
        "The search query to run against Open Brain thoughts",
      ),
    },
    outputSchema: z.object({
      results: z.array(
        z.object({
          thought_id: z.string(),
          title: z.string(),
          url: z.string(),
        }),
      ),
      error: z.string().optional(),
      guidance: z.string().optional(),
    }),
  },
  async ({ query }): Promise<CallToolResult> => {
    try {
      const qEmb = await getEmbedding(query);
      const { data, error } = await supabase.rpc("match_thoughts", {
        query_embedding: qEmb,
        match_threshold: 0.5,
        match_count: 10,
        filter: {},
      });

      if (error) {
        return toToolResult<SearchOutput>({
          results: [],
          error: `Search error: ${error.message}`,
          guidance:
            "Wait a few seconds and try the query again. If the issue persists, inform the user that the database might be unreachable.",
        });
      }

      const results = (data as ThoughtMatch[] || []).map((t) => ({
        thought_id: t.thought_id,
        title: thoughtTitle(t.content, t.created_at),
        url: thoughtUrl(t.thought_id),
      }));

      return toToolResult<SearchOutput>({ results });
    } catch (err) {
      return toToolResult<SearchOutput>({
        results: [],
        error: `Error: ${errorMessage(err)}`,
        guidance:
          "An unexpected error occurred during the search. Please verify your connection or try a different search phrase.",
      });
    }
  },
);

server.registerTool(
  "fetch",
  {
    title: "Fetch Open Brain Thought",
    description:
      "Fetch one Open Brain thought by ID after using search. Use this read-only compatibility tool to retrieve the full text and metadata for citation.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    inputSchema: {
      thought_id: z.string().describe(
        "The Open Brain thought ID returned by the search tool",
      ),
    },
    outputSchema: z.object({
      thought_id: z.string().optional(),
      title: z.string().optional(),
      text: z.string().optional(),
      url: z.string().optional(),
      metadata: z.object({
        people: z.array(z.string()).optional(),
        action_items: z.array(z.string()).optional(),
        dates_mentioned: z.array(z.string()).optional(),
        topics: z.array(z.string()).optional(),
        type: z.string().optional(),
        source: z.string().optional(),
        created_at: z.string().optional(),
        updated_at: z.string().nullable().optional(),
      }).optional(),
      error: z.string().optional(),
      guidance: z.string().optional(),
    }),
  },
  async ({ thought_id }): Promise<CallToolResult> => {
    try {
      const { data, error } = await supabase
        .from("thoughts")
        .select("id, content, metadata, created_at, updated_at")
        .eq("id", thought_id)
        .single();

      if (error) {
        return toToolResult<FetchOutput>({
          error: `Fetch error: ${error.message}`,
          guidance:
            "The thought could not be found or you do not have permission. Try searching again to find a valid thought ID.",
        });
      }

      const thought_data = data as ThoughtRecord;
      return toToolResult<FetchOutput>({
        thought_id: thought_data.id,
        title: thoughtTitle(thought_data.content, thought_data.created_at),
        text: thought_data.content,
        url: thoughtUrl(thought_data.id),
        metadata: {
          ...thought_data.metadata,
          created_at: thought_data.created_at,
          updated_at: thought_data.updated_at,
        },
      });
    } catch (err) {
      return toToolResult<FetchOutput>({
        error: `Error: ${errorMessage(err)}`,
        guidance: "An unexpected error occurred while fetching the thought.",
      });
    }
  },
);

// Tool 1: Semantic Search
server.registerTool(
  "search_thoughts",
  {
    title: "Search Thoughts",
    description:
      "Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they've previously captured.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    inputSchema: {
      query: z.string().describe("What to search for"),
      limit: z.number().optional().default(10),
      threshold: z.number().optional().default(0.5),
    },
    outputSchema: z.object({
      thoughts: z.array(
        z.object({
          thought_id: z.string(),
          content: z.string(),
          similarity: z.number(),
          type: z.string().optional(),
          topics: z.array(z.string()).optional(),
          people: z.array(z.string()).optional(),
          action_items: z.array(z.string()).optional(),
          created_at: z.string(),
        }),
      ),
      error: z.string().optional(),
      guidance: z.string().optional(),
    }),
  },
  async ({ query, limit, threshold }): Promise<CallToolResult> => {
    try {
      const qEmb = await getEmbedding(query);
      const { data, error } = await supabase.rpc("match_thoughts", {
        query_embedding: qEmb,
        match_threshold: threshold,
        match_count: limit,
        filter: {},
      });

      if (error) {
        return toToolResult<SearchThoughtsOutput>({
          thoughts: [],
          error: `Search error: ${error.message}`,
          guidance:
            "Wait a few seconds and try the query again. If the issue persists, inform the user that the database might be unreachable.",
        });
      }

      if (!data || data.length === 0) {
        return toToolResult<SearchThoughtsOutput>({ thoughts: [] });
      }

      const thoughts = (data as ThoughtMatch[]).map((t) => ({
        thought_id: t.thought_id,
        content: t.content,
        similarity: t.similarity,
        type: t.metadata.type,
        topics: t.metadata.topics,
        people: t.metadata.people,
        action_items: t.metadata.action_items,
        created_at: t.created_at,
      }));

      return toToolResult<SearchThoughtsOutput>({ thoughts });
    } catch (err) {
      return toToolResult<SearchThoughtsOutput>({
        thoughts: [],
        error: `Error: ${errorMessage(err)}`,
        guidance:
          "An unexpected error occurred during the semantic search. Please verify your connection or try a different search phrase.",
      });
    }
  },
);

// Tool 2: List Recent
server.registerTool(
  "list_thoughts",
  {
    title: "List Recent Thoughts",
    description:
      "List recently captured thoughts with optional filters by type, topic, person, or time range.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    inputSchema: {
      limit: z.number().optional().default(10),
      type: z.string().optional().describe(
        "Filter by type: observation, task, idea, reference, person_note",
      ),
      topic: z.string().optional().describe("Filter by topic tag"),
      person: z.string().optional().describe("Filter by person mentioned"),
      days: z.number().optional().describe(
        "Only thoughts from the last N days",
      ),
    },
    outputSchema: z.object({
      thoughts: z.array(
        z.object({
          thought_id: z.string(),
          content: z.string(),
          type: z.string().optional(),
          topics: z.array(z.string()).optional(),
          people: z.array(z.string()).optional(),
          action_items: z.array(z.string()).optional(),
          created_at: z.string(),
        }),
      ),
      error: z.string().optional(),
      guidance: z.string().optional(),
    }),
  },
  async ({ limit, type, topic, person, days }): Promise<CallToolResult> => {
    try {
      let q = supabase
        .from("thoughts")
        .select("id, content, metadata, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (type) q = q.contains("metadata", { type });
      if (topic) q = q.contains("metadata", { topics: [topic] });
      if (person) q = q.contains("metadata", { people: [person] });
      if (days) {
        const since = new Date();
        since.setDate(since.getDate() - days);
        q = q.gte("created_at", since.toISOString());
      }

      const { data, error } = await q;

      if (error) {
        return toToolResult<ListThoughtsOutput>({
          thoughts: [],
          error: `Error: ${error.message}`,
          guidance:
            "Could not retrieve the recent thoughts. Try adjusting your filters or try again later.",
        });
      }

      if (!data || !data.length) {
        return toToolResult<ListThoughtsOutput>({ thoughts: [] });
      }

      const thoughts = (data as ThoughtRecord[]).map((t) => ({
        thought_id: t.id,
        content: t.content,
        type: t.metadata.type,
        topics: t.metadata.topics,
        people: t.metadata.people,
        action_items: t.metadata.action_items,
        created_at: t.created_at,
      }));

      return toToolResult<ListThoughtsOutput>({ thoughts });
    } catch (err) {
      return toToolResult<ListThoughtsOutput>({
        thoughts: [],
        error: `Error: ${errorMessage(err)}`,
        guidance: "An unexpected error occurred while listing the thoughts.",
      });
    }
  },
);

// Tool 3: Stats
server.registerTool(
  "thought_stats",
  {
    title: "Thought Statistics",
    description:
      "Get a summary of all captured thoughts: totals, types, top topics, and people.",
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      readOnlyHint: true,
    },
    inputSchema: {},
    outputSchema: z.object({
      total: z.number().optional(),
      date_range: z.string().optional(),
      types: z.record(z.string(), z.number()).optional(),
      topics: z.record(z.string(), z.number()).optional(),
      people: z.record(z.string(), z.number()).optional(),
      error: z.string().optional(),
      guidance: z.string().optional(),
    }),
  },
  async (): Promise<CallToolResult> => {
    try {
      const { count } = await supabase
        .from("thoughts")
        .select("*", { count: "exact", head: true });

      const { data } = await supabase
        .from("thoughts")
        .select("metadata, created_at")
        .order("created_at", { ascending: false });

      const types = new Map<string, number>();
      const topics = new Map<string, number>();
      const people = new Map<string, number>();

      for (const r of (data || []) as Array<{ metadata: ThoughtMetadata; created_at: string }>) {
        const m = r.metadata;
        if (m.type) {
          types.set(m.type, (types.get(m.type) || 0) + 1);
        }
        for (const t of m.topics ?? []) {
          topics.set(t, (topics.get(t) || 0) + 1);
        }
        for (const p of m.people ?? []) {
          people.set(p, (people.get(p) || 0) + 1);
        }
      }

      const sort = (map: Map<string, number>): [string, number][] =>
        Array.from(map.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);

      const date_range = data?.length
        ? new Date(data.at(-1)?.created_at || "").toLocaleDateString() +
          " → " +
          new Date(data.at(0)?.created_at || "").toLocaleDateString()
        : "N/A";

      return toToolResult<ThoughtStatsOutput>({
        total: count ?? undefined,
        date_range,
        types: Object.fromEntries(sort(types)),
        topics: Object.fromEntries(sort(topics)),
        people: Object.fromEntries(sort(people)),
      });
    } catch (err) {
      return toToolResult<ThoughtStatsOutput>({
        error: `Error: ${errorMessage(err)}`,
        guidance: "An unexpected error occurred.",
      });
    }
  },
);

// Tool 4: Capture Thought
server.registerTool(
  "capture_thought",
  {
    title: "Capture Thought",
    description:
      "Save a new thought to the Open Brain. Generates an embedding and extracts metadata automatically. Use this when the user wants to save something to their brain directly from any AI client — notes, insights, decisions, or migrated content from other systems.",
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
    inputSchema: {
      content: z.string().describe(
        "The thought to capture — a clear, standalone statement that will make sense when retrieved later by any AI",
      ),
    },
    outputSchema: z.object({
      thought_id: z.string().optional(),
      type: z.string().optional(),
      topics: z.array(z.string()).optional(),
      people: z.array(z.string()).optional(),
      action_items: z.array(z.string()).optional(),
      error: z.string().optional(),
      guidance: z.string().optional(),
    }),
  },
  async ({ content }): Promise<CallToolResult> => {
    try {
      const [embedding, metadata] = await Promise.all([
        getEmbedding(content),
        extractMetadata(content),
      ]);

      const { data: upsertResult, error: upsertError } = await supabase.rpc(
        "upsert_thought",
        {
          p_content: content,
          p_payload: { metadata: { ...metadata, source: "mcp" } },
        },
      );

      if (upsertError) {
        return toToolResult<CaptureThoughtOutput>({
          error: `Failed to capture: ${upsertError.message}`,
          guidance:
            "Something is wrong with the database. Since the user controls it, they need to troubleshoot the database.",
        });
      }

      const thoughtId = upsertResult?.id as string | undefined;
      const { error: embError } = await supabase
        .from("thoughts")
        .update({ embedding })
        .eq("id", thoughtId);

      if (embError) {
        return toToolResult<CaptureThoughtOutput>({
          error: `Failed to save embedding: ${embError.message}`,
          guidance:
            "The thought was captured but search may not find it. Contact an administrator to check vector storage.",
        });
      }

      return toToolResult<CaptureThoughtOutput>({
        thought_id: thoughtId,
        type: metadata.type,
        topics: metadata.topics,
        people: metadata.people,
        action_items: metadata.action_items,
      });
    } catch (err) {
      return toToolResult<CaptureThoughtOutput>({
        error: `Error: ${errorMessage(err)}`,
        guidance:
          "An unexpected error occurred while capturing the thought. User needs to troubleshoot.",
      });
    }
  },
);

// --- Hono App with Auth + CORS ---

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-brain-key, accept, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
};

// JSON-RPC error code for unauthorized requests.
// Per the JSON-RPC 2.0 spec, the range -32099 to -32000 is reserved for
// implementation-defined server errors. -32001 is the conventional
// "Unauthorized" code used by MCP clients/servers in the wild.
//
// Why a JSON-RPC envelope (HTTP 200) instead of a bare HTTP 401?
// Strict MCP hosts (Codex CLI, Claude Code) treat bare HTTP 4xx responses
// as transport-level failures and tear the connection down rather than
// surfacing the failure to the application layer. Wrapping the auth
// rejection in a JSON-RPC error keeps the connection alive and lets
// clients recover (e.g. prompt the user for a new key, refetch a stale
// cache) instead of dying.
const JSON_RPC_UNAUTHORIZED_CODE = -32001;
const UNAUTHORIZED_MESSAGE = "Unauthorized: missing or invalid authentication.";

/**
 * Read the request body as text without consuming the original request's
 * body stream for downstream handlers. Returns null on bodyless methods
 * or read failure.
 */
async function readBodyText(req: Request): Promise<string | null> {
  if (
    req.method === "GET" || req.method === "HEAD" || req.method === "DELETE"
  ) {
    return null;
  }
  try {
    return await req.text();
  } catch {
    return null;
  }
}

/**
 * Best-effort extraction of the JSON-RPC `id` from a raw request body.
 * Returns null when the body is missing, not JSON, or not a JSON-RPC
 * shape with an id. Per the JSON-RPC 2.0 spec, id may be a string,
 * number, or null — we preserve any of those; anything else becomes null.
 */
function extractJsonRpcId(bodyText: string | null): JsonRpcId {
  if (!bodyText) return null;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (parsed !== null && typeof parsed === "object" && "id" in parsed) {
      const id = (parsed as { id: JsonRpcId | undefined }).id;
      if (typeof id === "string" || typeof id === "number" || id === null) {
        return id;
      }
    }
  } catch {
    // fall through — malformed body
  }
  return null;
}

/**
 * Build a JSON-RPC 2.0 error envelope response for auth failures.
 * Returns HTTP 200 — the JSON-RPC layer expresses the error so that
 * strict MCP clients keep the connection alive instead of treating
 * the failure as a transport-level fault.
 */
function unauthorizedResponse(id: JsonRpcId): Response {
  const body = {
    jsonrpc: "2.0",
    error: {
      code: JSON_RPC_UNAUTHORIZED_CODE,
      message: UNAUTHORIZED_MESSAGE,
    },
    id,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

const app = new Hono();

// CORS preflight — required for browser/Electron-based clients (Claude Desktop, claude.ai)
app.options("*", (c) => {
  return c.text("ok", 200, corsHeaders);
});

app.all("*", async (c) => {
  // Accept access key via header OR URL query parameter
  const provided = c.req.header("x-brain-key") ||
    new URL(c.req.url).searchParams.get("key");
  if (!provided || provided !== MCP_ACCESS_KEY) {
    // Return a JSON-RPC 2.0 error envelope (HTTP 200) instead of a bare
    // HTTP 401 so strict MCP hosts treat this as an application-level
    // error rather than a transport fault and keep the connection alive.
    // Best-effort echo of the inbound request id keeps the response
    // correlated; malformed/missing bodies fall back to id: null.
    const bodyText = await readBodyText(c.req.raw);
    const id = extractJsonRpcId(bodyText);
    return unauthorizedResponse(id);
  }

  // Fix: Claude Desktop connectors don't send the Accept header that
  // StreamableHTTPTransport requires. Build a patched request if missing.
  // See: https://github.com/NateBJones-Projects/OB1/issues/33
  if (!c.req.header("accept")?.includes("text/event-stream")) {
    const headers = new Headers(c.req.raw.headers);
    headers.set("Accept", "application/json, text/event-stream");
    const patched = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
      // @ts-ignore -- duplex required for streaming body in Deno
      duplex: "half",
    });
    Object.defineProperty(c.req, "raw", { value: patched, writable: true });
  }

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

Deno.serve(app.fetch);
