# Execution Receipts

9Router answers **what AI execution actually occurred** — it does not decide
whether a Heron action was authorized. Every request that reaches the routing
plane is captured as a single **execution receipt**: a versioned, causal record
of the requested vs effective execution, including the full retry/fallback chain
and every compatibility mutation.

The end-state contract is:

> **Heron intent/trace → 9Router execution → actual provider/model/effective parameters → durable execution receipt**

Receipts are correlation metadata only. Heron trace/intent/work/world ids never
grant privileges and never bypass 9Router authentication.

## The receipt (`schema_version: 1`)

```jsonc
{
  "schema_version": 1,
  "execution_id": "9r_exec_<uuid>",
  "started_at": "ISO-8601",
  "ended_at": "ISO-8601",
  "endpoint": "/v1/chat/completions",
  "capability": "chat | responses | image | tts | stt",
  "status": "success | error | streaming | aborted",
  "error": { "message": null, "status_code": 401 },
  "heron": { "trace_id": null, "intent_id": null, "work_id": null, "world_id": null },
  "heron_invalid": ["trace_id"],   // malformed correlation ids that were dropped
  "request": {
    "model": "combo-a",            // exactly what the client asked for
    "alias_or_combo": "combo-a",   // combo or alias name, when applicable
    "provider": "openrouter",      // explicit provider if the client selected one
    "params": { "seed": 1234, "temperature": 0.7, ... },   // bounded scalar params
    "effective_params": { "seed": null, ... }              // what actually went upstream
  },
  "routing": {
    "reason": "combo_fallback | combo_round_robin | fusion_panel | capacity_adapter | direct | credentials_unavailable",
    "requested_combo": "combo-a",
    "candidates": ["openai/gpt-4o", "openrouter/meta-llama/llama-3.3-70b"],
    "selected": { "provider": "...", "model": "...", "connection": {...} },
    "fallback_count": 1
  },
  "attempts": [
    {
      "n": 1, "candidate": "openai/gpt-4o",
      "provider": "openai", "model": "gpt-4o",
      "connection": { "id": "conn-1", "label": "Primary", "auth_type": "apikey" },
      "reason": "primary | account_fallback | combo_fallback | token_refresh_retry | credentials_unavailable",
      "status": "error", "status_code": 429, "error": "rate limited",
      "latency_ms": 812, "upstream_ms": 800,
      "compatibility_mutations": []
    }
  ],
  "attempts_truncated": 0,
  "actual": { "provider": "openrouter", "model": "meta-llama/llama-3.3-70b", "connection": { "id": "...", "label": "...", "auth_type": "..." } },
  "latency": { "total_ms": 1200, "routing_ms": null, "upstream_ms": 1180, "ttft_ms": null },
  "usage": { "prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18, "cached_tokens": 0 },
  "cost": { "amount": 0.000123, "currency": "USD", "state": "known | estimated | zero | unknown" },
  "compatibility_mutations": [
    { "field": "seed", "action": "removed", "reason": "upstream_rejected_parameter",
      "attempt": 1, "requested_value": 1234, "effective_value": null,
      "determinism_honored": false, "detail": "provider returned 400 mentioning seed" }
  ],
  "optimizations": [{ "name": "rtk", "detail": "tool_results=2" }],
  "determinism": { "seed_requested": 1234, "seed_applied": false, "determinism_honored": false }
}
```

### Cost truth
`cost.state` disambiguates what a stored `amount` means:

- `known` — the provider returned the exact cost.
- `estimated` — computed from the local pricing table.
- `zero` — genuinely free (caller asserts).
- `unknown` — no pricing / no usage basis. **A stored `0` with state `unknown`
  must never be read as "free".** This is mirrored into
  `usageHistory.meta.cost_state` so the dashboard never misreports.

## What is NOT in a receipt

- Never secrets: no access/refresh/API tokens, no cookies, no full
  Authorization headers. Connection identity is `{ id, label, auth_type }` only.
- Never prompt/message/image bodies. The receipt is provenance, not
  conversation content. Body retention is still governed by the existing
  observability policy (`enableObservability`).

## Correlation (Heron)

Accepted from request **headers** and OpenAI-compatible `metadata`:

| Receipt field | Header | `metadata` keys |
|---|---|---|
| `trace_id` | `X-Heron-Trace-Id` | `heron_trace_id`, `heronTraceId` |
| `intent_id` | `X-Heron-Intent-Id` | `heron_intent_id`, `heronIntentId` |
| `work_id` | `X-Heron-Work-Id` | `heron_work_id`, `heronWorkId` |
| `world_id` | `X-Heron-World-Id` | `heron_world_id`, `heronWorldId` |

- Values are validated (string, ≤256 chars, no control characters). Malformed
  values are dropped and reported under `heron_invalid`.
- Headers win over body metadata.
- Heron keys are **stripped** from `metadata` before the body is translated or
  forwarded upstream — correlation is recorded locally, never blindly forwarded.
- These ids are never consulted for authorization. A request carrying them still
  fails with 401/403 exactly as it would without them.

## Storage (reusing the existing observability DB)

Two pre-existing surfaces, no second telemetry system:

- **`usageHistory`** (always on): compact summary in the `meta` JSON column
  (`execution_id`, `heron`, requested/actual, routing reason, attempts,
  fallbacks, compatibility mutations, determinism, `cost_state`) plus new
  indexed `executionId` / `traceId` columns (schema v2). This is the durable
  lookup surface even when conversation observability is disabled.
- **`requestDetails`**: the full receipt under `data.receipt`, keyed by the
  `execution_id` itself. Receipt-only records are persisted even when body
  observability is off (they contain no prompts/responses).

`usageHistory.meta` previously always wrote `{}` — the supplied meta is now
meaningfully persisted.

### Retention semantics (durability contract)

- **`usageHistory`** is never pruned. Every routed request — success **or
  failure** — writes a compact summary (execution_id, heron, requested/actual,
  determinism, compatibility mutations, `cost_state`, status) plus the indexed
  `executionId`/`traceId` columns. This is the **durable identity surface**: an
  execution can always be found by id or trace, forever, including failed
  executions that never produced token usage.
- **`requestDetails`** is a bounded store (`observabilityMaxRecords`; default
  1000 in settings, 200 in the repo constant, FIFO). When a detailed receipt is
  pruned, lookup transparently falls back to the durable summary in
  `usageHistory` and reports `receipt_source: "usage_history"`. Detail is
  best-effort; identity is durable.

## Compatibility mutations

Every requested → effective difference (model rewrite, dropped/changed seed,
size/aspect mapping, streaming policy, ...) is recorded as a compatibility
mutation. The image `seed` path is the canonical case:

- seed accepted upstream → `seed_applied: true`, `determinism_honored: true`;
- provider 400 mentioning `seed` → retried without it → the receipt truthfully
  records `seed_requested: 1234`, `seed_applied: false`, mutation
  `{ field: "seed", action: "removed", reason: "upstream_rejected_parameter" }`,
  `determinism_honored: false`. The original request object is never mutated —
  the adapter-built request body is what gets mutated for the retry.

Token-saver transforms (RTK, headroom, caveman, ponytail, pxpipe) are recorded
under `optimizations`, distinct from compatibility mutations.

## Routing / fallback

Combo and account fallback share **one** execution context, so a request that
tries `gpt-4o` → `llama-3.3-70b` (and accounts A → B) yields one causal receipt
with ordered `attempts`, one `actual`, and a truthful `fallback_count` — never
disconnected per-attempt records. Provider fallback behavior is unchanged.

## Response headers & lookup

- `X-9Router-Execution-Id` on every compatible response (JSON, SSE, binary
  image/audio). `X-Heron-Trace-Id` echoes the accepted trace id. Both are added
  to `Access-Control-Expose-Headers`.
- The response body stays OpenAI-compatible; no arbitrary fields are injected.

Read-only observability API (auth: dashboard session, CLI token, or API key):

```
GET /api/executions?execution_id=<id>      # one receipt (detailed, else summary)
GET /api/executions?trace_id=<id>          # executions by Heron trace, newest first
GET /api/executions                        # recent executions
GET /api/executions/<id>                   # one receipt by path
```

### Known nuance: HTTP-level status governs `receipt.status`

`status` reflects the HTTP exchange 9Router had with the upstream (2xx → success).
An upstream that answers HTTP 200 with an OpenAI-style error payload (app-level
"Service temporarily overloaded") is recorded as success at the HTTP layer;
the app-level error is visible in `attempts[].error`/`response` when captured.
A transport failure (5xx), auth rejection (401/403), abort, or routing error is
recorded as `error`/`aborted` with a durable summary row.

## Capability coverage

| Capability | Endpoint | Receipt | Notes |
|---|---|---|---|
| chat | `/v1/chat/completions` | full | streaming finalizes via stream completion |
| responses | `/v1/responses` | full | routed through the chat plane |
| image | `/v1/images/generations` | full | seed truth included |
| tts | `/v1/audio/speech` | full | usage row (no token basis → cost `unknown`) |
| stt | `/v1/audio/transcriptions` | full | header-only correlation (multipart) |

Embeddings, videos and search do not carry receipts yet; that is an explicit,
documented gap, not fabricated telemetry.

## Files

- `open-sse/services/executionReceipt.js` — pure receipt contract (schema,
  correlation, attempts, mutations, headers).
- `src/lib/execution/receiptStore.js` — persistence + lookup.
- `src/lib/db/migrations/002-execution-receipts.js`, `schema.js` (v2).
- `src/app/api/executions/*` — read-only lookup API.
- `src/sse/handlers/{chat,imageGeneration,tts,stt}.js`,
  `open-sse/handlers/chatCore.js`, `chatCore/{streaming,nonStreaming,requestDetail}.js`,
  `open-sse/handlers/imageGenerationCore.js` — execution threading.
