# open-brain

Open Brain — The infrastructure layer to bridge the gap between your mind and your AI agents. One database, one AI gateway, one chat channel — any AI plugs in.

## Overview

Open Brain provides a centralized, semantic-searchable "brain" for AI agents. It leverages Supabase for storage, Deno Edge Functions for the MCP server implementation, and OpenAI/OpenRouter for embedding and metadata extraction.

## Getting Started

### Prerequisites

*   [Supabase Account](https://supabase.com/)
*   [OpenRouter API Key](https://openrouter.ai/)
*   Deno runtime (for local development/testing)

### Configuration

To run the MCP server, you must set the following environment variables in your Supabase project:

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | The secret service role key for administrative access |
| `OPENROUTER_API_KEY` | API key for OpenRouter (used for embeddings and LLM extraction) |
| `MCP_ACCESS_KEY` | A custom shared secret used to authenticate MCP clients |
| `OPEN_BRAIN_CITATION_BASE_URL` | (Optional) Base URL for generating thought citation links |

### Running the MCP Server

The MCP server is deployed as a Supabase Edge Function. Once deployed, you can connect any MCP-compatible client by pointing it to your function's endpoint and providing the `x-brain-key`.

## Architecture

For a detailed technical overview of the system architecture, data flows (Capture vs. Search), and core components, please refer to [docs/architecture.md](docs/architecture.md).
