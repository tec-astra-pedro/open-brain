# Session Brain Dump: Open Brain Hardening & Protocol (2026-05-31)

## Topic 1: Interaction Protocol
- Confirmed adherence to the "Open Brain Interaction Protocol — Strict Mode, Append-Only".
- Core constraints: No simulating saves/retrievals, append-only storage, truthful reporting of connection status.

## Topic 2: Audit Review (v1 Hardening)
- Reviewed a security and performance audit of Open Brain v1.
- Key risks identified: "Ghost thoughts" (non-atomic capture), "God Mode" service roles, hard-coded secrets, and latency in embedding/metadata calls.
- Consensus: The audit is highly perceptive; priority should be on data integrity (atomicity) and security (service role mitigation).

## Topic 3: Thought Capture Strategy - Atomicity vs. Preservation
- Discussion on whether to make `capture_thought` atomic.
- Tradeoff identified: Atomic saves risk total data loss if the embedding API is down. "Safe Save" risks temporary unsearchability ("ghost thoughts").
- Decision: Prioritize data preservation. The text (the insight) is more valuable than immediate searchability.
- Proposed Design: Hybrid "Safe-Capture" Pattern.
    1. Immediate save of content to DB.
    2. Async attempt at embedding generation and storage.
    3. Implementation of a "Repair Tool" (The Janitor) to scan for `embedding IS NULL` records and backfill them in batches.

## Topic 4: Repair Tool Requirements
- Must report exact errors from the embedding provider (e.g., OpenRouter credits/billing issues).
- Must explicitly notify the owner that personal intervention is required if a critical failure occurs.
- Should avoid "loops of frustration" by being clear when a retry won't help without external action.

## Topic 5: Schema Rigidity (Input vs Output)
- Clarified the distinction between Input and Output schemas in `registerTool`.
- Design Principle:
    - **Input Schemas:** Should be rigid/mandatory for core data fields to force the AI to provide necessary information before calling the tool.
    - **Output Schemas:** Remain optional. This allows the tool to return either the requested data OR an error message and guidance, without violating a strict schema.
