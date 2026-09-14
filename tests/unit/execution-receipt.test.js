import { describe, it, expect } from "vitest";
import {
  RECEIPT_SCHEMA_VERSION,
  createExecution,
  extractHeronCorrelation,
  stripHeronMetadata,
  validateCorrelationId,
  snapshotParams,
  diffParameterSnapshots,
  recordEffectiveParams,
  recordSeedApplication,
  beginAttempt,
  endAttempt,
  recordActual,
  setRouting,
  setStreaming,
  recordUsage,
  recordCost,
  finalizeExecutionState,
  buildExecutionReceipt,
  buildUsageMeta,
  attachExecutionHeaders,
  sanitizeConnectionIdentity,
} from "../../open-sse/services/executionReceipt.js";

describe("execution receipt contract", () => {
  describe("Heron correlation (headers + metadata)", () => {
    it("extracts correlation from headers", () => {
      const r = extractHeronCorrelation({
        headers: { "X-Heron-Trace-Id": "tr-123", "x-heron-world-id": "world-9" },
      });
      expect(r.present).toBe(true);
      expect(r.values).toEqual({ trace_id: "tr-123", world_id: "world-9" });
    });

    it("extracts correlation from OpenAI metadata (snake and camel)", () => {
      const r = extractHeronCorrelation({
        body: { metadata: { heron_trace_id: "tr-1", heronIntentId: "int-2" } },
      });
      expect(r.values).toEqual({ trace_id: "tr-1", intent_id: "int-2" });
    });

    it("headers win over metadata", () => {
      const r = extractHeronCorrelation({
        headers: { "x-heron-trace-id": "from-header" },
        body: { metadata: { heron_trace_id: "from-body" } },
      });
      expect(r.values.trace_id).toBe("from-header");
    });

    it("rejects malformed values and reports them invalid", () => {
      expect(validateCorrelationId("ok-id-1")).toBe("ok-id-1");
      expect(validateCorrelationId("a\nb")).toBeNull(); // control char
      expect(validateCorrelationId("x".repeat(300))).toBeNull(); // too long
      expect(validateCorrelationId("   ")).toBeNull();
      expect(validateCorrelationId(123)).toBeNull();

      const r = extractHeronCorrelation({
        headers: { "x-heron-trace-id": "bad\nid" },
      });
      expect(r.values.trace_id).toBeUndefined();
      expect(r.invalid).toContain("trace_id");
    });
  });

  describe("stripHeronMetadata (never forwarded upstream)", () => {
    it("removes heron keys from metadata and drops empty metadata", () => {
      const { body, stripped } = stripHeronMetadata({ model: "x", metadata: { heron_trace_id: "t", user: "keep" } });
      expect(stripped).toContain("heron_trace_id");
      expect(body.metadata).toEqual({ user: "keep" });
    });

    it("deletes metadata entirely when only heron keys remain", () => {
      const { body } = stripHeronMetadata({ model: "x", metadata: { heron_trace_id: "t" } });
      expect(body.metadata).toBeUndefined();
    });
  });

  describe("parameter snapshot / diff (compatibility truth)", () => {
    it("captures bounded scalar params, never prompt/messages", () => {
      const snap = snapshotParams({
        model: "m", stream: true, seed: 1234, temperature: 0.7,
        messages: [{ role: "user", content: "secret" }],
        tools: [{ type: "function", function: { name: "f" } }],
        response_format: { type: "json_object" },
      });
      expect(snap.model).toBe("m");
      expect(snap.seed).toBe(1234);
      expect(snap.tool_count).toBe(1);
      expect(snap.response_format).toEqual({ type: "json_object" });
      expect(snap.messages).toBeUndefined();
    });

    it("records a dropped seed as a truthful compatibility mutation", () => {
      const execution = createExecution({ requestedModel: "m", requestedParams: { model: "m", seed: 1234 } });
      recordEffectiveParams(execution, { model: "m" }); // translator dropped seed
      const receipt = buildExecutionReceipt(execution);
      expect(receipt.compatibility_mutations).toContainEqual(expect.objectContaining({ field: "seed", action: "removed" }));
      expect(receipt.determinism).toEqual({ seed_requested: 1234, seed_applied: false, determinism_honored: false });
    });

    it("records an honored seed as seed_applied=true", () => {
      const execution = createExecution({ requestedModel: "m", requestedParams: { model: "m", seed: 1234 } });
      recordEffectiveParams(execution, { model: "m", seed: 1234 });
      const receipt = buildExecutionReceipt(execution);
      expect(receipt.determinism).toEqual({ seed_requested: 1234, seed_applied: true, determinism_honored: true });
      expect(receipt.compatibility_mutations).toEqual([]);
    });

    it("records a changed seed as determinism_honored=false", () => {
      const execution = createExecution({ requestedModel: "m", requestedParams: { model: "m", seed: 1234 } });
      recordEffectiveParams(execution, { model: "m", seed: 9999 });
      const receipt = buildExecutionReceipt(execution);
      expect(receipt.determinism.seed_applied).toBe(false);
      expect(receipt.determinism.determinism_honored).toBe(false);
      expect(receipt.compatibility_mutations).toContainEqual(expect.objectContaining({ field: "seed", action: "changed" }));
    });
  });

  describe("ordered attempts / fallback chain", () => {
    it("preserves attempts in order with candidate + reason", () => {
      const execution = createExecution({ requestedModel: "comboA" });
      setRouting(execution, { reason: "combo_fallback", requestedCombo: "comboA", candidates: ["a", "b"] });
      const a1 = beginAttempt(execution, { candidate: "a", provider: "p1", model: "m1", reason: "primary" });
      endAttempt(execution, a1, { success: false, status: 429, error: "rate limited" });
      const a2 = beginAttempt(execution, { candidate: "b", provider: "p2", model: "m2", reason: "combo_fallback" });
      endAttempt(execution, a2, { success: true, status: 200 });
      recordActual(execution, { provider: "p2", model: "m2", connectionId: "conn-2" });
      finalizeExecutionState(execution, { status: "success" });

      const receipt = buildExecutionReceipt(execution);
      expect(receipt.routing.requested_combo).toBe("comboA");
      expect(receipt.routing.reason).toBe("combo_fallback");
      expect(receipt.routing.fallback_count).toBe(1);
      expect(receipt.attempts.map((a) => a.candidate)).toEqual(["a", "b"]);
      expect(receipt.attempts[0].status).toBe("error");
      expect(receipt.attempts[1].status).toBe("success");
      expect(receipt.actual).toEqual({ provider: "p2", model: "m2", connection: { id: "conn-2", label: null, auth_type: null } });
    });
  });

  describe("secrets never persisted", () => {
    it("receipt and usage meta contain no tokens/keys/headers", () => {
      const execution = createExecution({ requestedModel: "m" });
      recordActual(execution, {
        provider: "p",
        model: "m",
        connectionId: "conn-1",
        connectionLabel: "My Account",
        authType: "oauth",
      });
      recordUsage(execution, { prompt_tokens: 10, completion_tokens: 5 });
      recordCost(execution, 0.001, "estimated");
      finalizeExecutionState(execution, { status: "success" });

      const receipt = buildExecutionReceipt(execution);
      const meta = buildUsageMeta(execution);
      const json = JSON.stringify(receipt) + JSON.stringify(meta);
      expect(json).not.toContain("supersecret");
      expect(json).not.toContain("refreshToken");
      expect(receipt.actual.connection).toEqual({ id: "conn-1", label: "My Account", auth_type: "oauth" });
    });

    it("sanitizeConnectionIdentity drops secret fields", () => {
      const identity = sanitizeConnectionIdentity({ connectionId: "c", accessToken: "tok", apiKey: "k", refreshToken: "r" });
      expect(identity).toEqual({ id: "c", label: null, auth_type: null });
      expect(JSON.stringify(identity)).not.toContain("tok");
    });
  });

  describe("cost truth", () => {
    it("unknown cost is not reported as free", () => {
      const execution = createExecution({ requestedModel: "m" });
      recordCost(execution, 0, "unknown");
      finalizeExecutionState(execution, { status: "success" });
      const receipt = buildExecutionReceipt(execution);
      expect(receipt.cost).toEqual({ amount: 0, currency: "USD", state: "unknown" });
      // And the compact meta carries the state so a 0 is never read as free.
      expect(buildUsageMeta(execution).cost_state).toBe("unknown");
    });

    it("records estimated/zero/known states", () => {
      const e = createExecution({ requestedModel: "m" });
      recordCost(e, 0.01, "estimated");
      expect(buildExecutionReceipt(e).cost.state).toBe("estimated");
      recordCost(e, 0, "zero");
      expect(buildExecutionReceipt(e).cost.state).toBe("zero");
      recordCost(e, 0.05, "known");
      expect(buildExecutionReceipt(e).cost.state).toBe("known");
    });
  });

  describe("response headers", () => {
    it("adds execution id + echoes trace, preserves body/headers (binary/SSE safe)", async () => {
      const execution = createExecution({ heron: { present: true, values: { trace_id: "tr-9" }, invalid: [] } });
      const original = new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "Content-Type": "image/png", "Content-Disposition": "inline; filename=\"x.png\"" },
      });
      const wrapped = attachExecutionHeaders(original, execution);
      expect(wrapped.headers.get("X-9Router-Execution-Id")).toBe(execution.executionId);
      expect(wrapped.headers.get("X-Heron-Trace-Id")).toBe("tr-9");
      expect(wrapped.headers.get("Content-Type")).toBe("image/png");
      expect(wrapped.headers.get("Access-Control-Expose-Headers")).toContain("X-9Router-Execution-Id");
      const buf = Buffer.from(await wrapped.arrayBuffer());
      expect(buf[0]).toBe(0x89);
      expect(buf[1]).toBe(0x50);
    });
  });

  describe("schema shape", () => {
    it("emits a versioned receipt with all required fields", () => {
      const execution = createExecution({ requestedModel: "m", endpoint: "/v1/chat/completions", capability: "chat" });
      setStreaming(execution, true);
      recordUsage(execution, { prompt_tokens: 1, completion_tokens: 2 });
      recordCost(execution, 0.001, "estimated");
      finalizeExecutionState(execution, { status: "success" });
      const receipt = buildExecutionReceipt(execution);
      expect(receipt.schema_version).toBe(RECEIPT_SCHEMA_VERSION);
      expect(receipt.execution_id).toMatch(/^9r_exec_/);
      expect(receipt.endpoint).toBe("/v1/chat/completions");
      expect(receipt.capability).toBe("chat");
      expect(receipt.started_at).toBeTruthy();
      expect(receipt.ended_at).toBeTruthy();
      expect(receipt.request.model).toBe("m");
      expect(receipt.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, cached_tokens: 0 });
    });
  });
});
