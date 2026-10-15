# Open Brain Architecture

Open Brain is a specialized infrastructure layer designed to bridge human cognition and AI agents by providing a centralized, semantic-searchable "brain." It acts as an intermediary that allows various LLMs to plug into a single, persistent memory source via the Model Context Protocol (MCP).

## High-Level Overview

The system follows a serverless, event-driven architecture centered around Supabase. Data flows from user/agent interactions through an edge computing layer and is stored in a structured, vector-enabled PostgreSQL database.

```mermaid
graph TD
    A[AI Agent / MCP Client] -- "JSON-RPC (MCP)" --> B[Supabase Edge Function (Deno)]
    B -- "Auth via Service Role" --> C[Supabase/PostgreSQL]
    C -- "Semantic Search (pgvector)" --> D[(Thoughts Table)]
    B -- "Embeddings / LLM Extraction" --> E[OpenRouter API]
    E -- "Vector & Metadata" --> B
```

## Core Components

### 1. Client Layer (The Interface)
AI Agents (such as Claude Code, ChatGPT, or custom scripts) act as **MCP Clients**. They communicate with Open Brain using the Model Context Protocol via a `StreamableHTTPTransport`. This allows them to use tools like `search`, `fetch`, and `capture_thought` as if they were native capabilities.

### 2. Integration Layer (The Gateway)
The **Supabase Edge Function (`open_brain_mcp`)** serves as the central gateway. Written in TypeScript and running on the Deno runtime, it performs several critical roles:
*   **Protocol Translation:** Converts MCP JSON-RPC requests into database operations.
*   **Security Enforcement:** Validates incoming requests via a shared `MCP_ACCESS_KEY`.
*   **Intelligence Orchestration:** 
    *   Calls **OpenRouter** to generate high-dimensional embeddings for semantic search.
    *   Uses LLMs (e.g., `gpt-4o-mini`) to perform structured metadata extraction (people, topics, action items) during the capture process.
*   **Statelessness:** The function is designed to be stateless, creating a new transport instance per request to maintain compatibility with HTTP-based MCP implementations.

### 3. Data & Intelligence Layer (The Brain)
**Supabase (PostgreSQL)** provides the persistent storage and intelligence:
*   **`thoughts` Table:** The core repository storing raw content, metadata (JSONB), and vector embeddings (`vector(1536)`).
*   **Semantic Search:** Utilizes `pgvector` with an `HNSW` index for high-speed, approximate nearest neighbor search.
*   **Deduplication Logic:** Uses a specialized `upsert_thought` RPC function that implements SHA256 fingerprinting to prevent duplicate entries while merging metadata for existing thoughts.
*   **Analytical Engine:** Provides real-time statistics (topics, people, temporal trends) via the `get_thought_stats` function.

## Data Flow: Capturing a Thought

1.  **Request:** The Agent calls `capture_thought(content="...")`.
2.  **Extraction:** The Edge Function sends the text to OpenRouter for **embeddings** and simultaneously uses an LLM to extract **structured metadata**.
3.  **Deduplication:** The Edge Function calls the `upsert_thought` RPC in Postgres.
    *   The DB generates a `content_fingerprint`.
    *   If the fingerprint exists, it merges new metadata with existing data and updates `updated_at`.
4.  **Embedding Sync:** The generated vector is written back to the record via an `update` call.
5.  **Response:** The Agent receives a confirmation containing the `thought_id` and parsed metadata.

## Data Flow: Searching the Brain

1.  **Request:** The Agent calls `search(query="...")`.
2.  **Vectorization:** The Edge Function converts the query string into a 1536-dimension vector via OpenRouter.
3.  **Similarity Search:** The function executes the `match_thoughts` RPC, which performs a cosine similarity search against the `hnsw` index in Postgres.
4.  **Result:** The Agent receives a list of matching thoughts including their similarity scores and citation URLs.

---

## Operational Principles

*   **Append-Only Integrity:** To ensure history is never lost, all updates are recorded as new entries or refinements rather than overwriting core records (per the *Open Brain Interaction Protocol*).
*   **Safe-Capture Pattern:** Data preservation is prioritized over absolute atomicity. The text is saved immediately, while enrichment (embeddings/metadata) happens in a way that ensures searchability follows capture.
*   **Security through Isolation:** All external access is mediated through the Edge Function using the `service_role` to maintain strict control over data integrity and RLS policies.
