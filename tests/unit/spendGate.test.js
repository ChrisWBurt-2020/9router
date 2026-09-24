import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BUDGET_EXHAUSTED_CODE,
  DEFAULT_PAID_MAX_PRICE,
  checkSpendGate,
  resolveConsumer,
  resolveTier,
  maxPriceForTier,
  pricePolicyFor,
  withMaxPrice,
  budgetExhaustedResponse,
  isBudgetExhaustedResponse,
  spendReportFromExecution,
  reportSpendToGovernor,
  selectOutboundCredentials,
  resetVoiceKeyWarning,
  VOICE_CONSUMER,
  VOICE_KEY_ENV_VAR,
  HARNESS_CONSUMER,
  CONSUMER_ATTESTATION_HEADER,
  PROXY_HMAC_SECRET_ENV,
  verifyConsumerAttestation,
  signConsumerAttestation,
  isFreeOnlyConsumer,
  consumerAllowsModel,
} from "../../src/lib/spendGate.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "spend-gate-test-"));
const QUOTA_FILE = path.join(TMP, "quota.json");
const OLD_ENV = process.env.GOVERNOR_QUOTA_FILE;

function writeQuota(consumers) {
  fs.writeFileSync(QUOTA_FILE, JSON.stringify({ version: 1, consumers }), "utf8");
}

beforeEach(() => {
  process.env.GOVERNOR_QUOTA_FILE = QUOTA_FILE;
  try { fs.unlinkSync(QUOTA_FILE); } catch {}
});

afterEach(() => {
  if (OLD_ENV === undefined) delete process.env.GOVERNOR_QUOTA_FILE;
  else process.env.GOVERNOR_QUOTA_FILE = OLD_ENV;
});

describe("resolveConsumer", () => {
  it("prefers the explicit x-heron-consumer value", () => {
    expect(resolveConsumer({ consumer: "homenode-voice", work_id: "w1" })).toBe("homenode-voice");
  });
  it("does not treat a work id as a billing identity", () => {
    expect(resolveConsumer({ work_id: "work-42" })).toBeNull();
  });
  it("falls back to \"default\" with no correlation", () => {
    expect(resolveConsumer(null)).toBe("default");
    expect(resolveConsumer({})).toBe("default");
  });
});

describe("checkSpendGate", () => {
  it("fails closed when the quota file is absent", () => {
    const d = checkSpendGate({ heron: { consumer: "homenode-voice" } });
    expect(d.decision).toBe("deny");
    expect(d.reason).toBe("quota_state_missing");
  });

  it("fails closed on unreadable quota state", () => {
    fs.writeFileSync(QUOTA_FILE, "{not json", "utf8");
    const d = checkSpendGate({ heron: { consumer: "homenode-voice" } });
    expect(d.decision).toBe("deny");
    expect(d.reason).toBe("quota_state_unreadable");
  });

  it("fails closed when the quota file has no consumers map", () => {
    fs.writeFileSync(QUOTA_FILE, JSON.stringify({ version: 1 }), "utf8");
    const d = checkSpendGate({ heron: { consumer: "homenode-voice" } });
    expect(d.decision).toBe("deny");
    expect(d.reason).toBe("quota_state_invalid");
  });

  it("allows a listed consumer under its daily cap", () => {
    writeQuota({
      "homenode-voice": { daily_cap_usd: 1.0, spent_today_usd: 0.2, tier_order: ["free", "paid"] },
    });
    const d = checkSpendGate({ heron: { consumer: "homenode-voice" } });
    expect(d.decision).toBe("allow");
    expect(d.unmanaged).toBe(false);
    expect(d.consumer).toBe("homenode-voice");
  });

  it("denies a listed consumer at or over its daily cap", () => {
    writeQuota({
      "homenode-voice": { daily_cap_usd: 1.0, spent_today_usd: 1.0, tier_order: ["free", "paid"] },
    });
    const d = checkSpendGate({ heron: { consumer: "homenode-voice" } });
    expect(d.decision).toBe("deny");
    expect(d.reason).toBe("budget_exhausted");
    expect(d.message).toContain("homenode-voice");
  });

  it("denies a Heron-controlled request for an unregistered consumer", () => {
    writeQuota({
      "homenode-voice": { daily_cap_usd: 1.0, spent_today_usd: 0.0 },
    });
    const d = checkSpendGate({ heron: { consumer: "opencode" } });
    expect(d.decision).toBe("deny");
    expect(d.reason).toBe("consumer_unregistered");
  });
});

describe("budget denial is terminal and machine-readable", () => {
  it("returns HTTP 402 with code budget_exhausted, never 503", async () => {
    writeQuota({
      "homenode-voice": { daily_cap_usd: 1.0, spent_today_usd: 2.5 },
    });
    const gate = checkSpendGate({ heron: { consumer: "homenode-voice" } });
    const res = budgetExhaustedResponse(gate);
    expect(res.status).toBe(402);
    expect(res.status).not.toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe(BUDGET_EXHAUSTED_CODE);
    expect(body.error.code).toBe("budget_exhausted");
    expect(body.error.retryable).toBe(false);
    expect(body.error.consumer).toBe("homenode-voice");
    expect(body.error.reason).toBe("budget_exhausted");
    expect(typeof body.error.message).toBe("string");
  });

  it("isBudgetExhaustedResponse distinguishes denial from 503", () => {
    writeQuota({ "homenode-voice": { daily_cap_usd: 1.0, spent_today_usd: 9 } });
    const denied = budgetExhaustedResponse(checkSpendGate({ heron: { consumer: "homenode-voice" } }));
    expect(isBudgetExhaustedResponse(denied)).toBe(true);
    expect(isBudgetExhaustedResponse(new Response("{}", { status: 503 }))).toBe(false);
    expect(isBudgetExhaustedResponse(new Response("{}", { status: 200 }))).toBe(false);
  });
});

describe("price policy", () => {
  const entry = {
    daily_cap_usd: 1.0,
    spent_today_usd: 0.1,
    tier_order: ["free", "paid"],
    max_price: { prompt: 0.05, completion: 0.4 },
  };

  it("resolves free tier from the combo flag or a free model id", () => {
    writeQuota({ "homenode-voice": entry });
    const gate = checkSpendGate({ heron: { consumer: "homenode-voice" } });
    expect(resolveTier(gate, { model: "openrouter/deepseek-v4-flash", freeTierOnly: true })).toBe("free");
    expect(resolveTier(gate, { model: "openrouter/qwen/qwen3-coder:free" })).toBe("free");
    expect(resolveTier(gate, { model: "openrouter/deepseek/deepseek-v4-flash" })).toBe("paid");
  });

  it("free tier pins max_price to 0/0", () => {
    writeQuota({ "homenode-voice": entry });
    const gate = checkSpendGate({ heron: { consumer: "homenode-voice" } });
    expect(maxPriceForTier(gate, "free")).toEqual({ prompt: 0, completion: 0 });
  });

  it("paid tier uses the consumer policy max_price", () => {
    writeQuota({ "homenode-voice": entry });
    const gate = checkSpendGate({ heron: { consumer: "homenode-voice" } });
    expect(pricePolicyFor(gate, { model: "openrouter/deepseek/deepseek-v4-flash" })).toEqual({
      tier: "paid",
      maxPrice: { prompt: 0.05, completion: 0.4 },
    });
  });

  it("paid tier falls back to the conservative ceiling without policy", () => {
    writeQuota({ "homenode-voice": { daily_cap_usd: 1.0, spent_today_usd: 0 } });
    const gate = checkSpendGate({ heron: { consumer: "homenode-voice" } });
    expect(maxPriceForTier(gate, "paid")).toEqual(DEFAULT_PAID_MAX_PRICE);
  });

  it("unmanaged traffic without Heron identity keeps existing behavior", () => {
    writeQuota({ "homenode-voice": entry });
    const gate = checkSpendGate({ heron: null });
    expect(gate.unmanaged).toBe(true);
    expect(maxPriceForTier(gate, "paid")).toBeNull();
    expect(pricePolicyFor(gate, { model: "openrouter/deepseek/deepseek-v4-flash" }).maxPrice).toBeNull();
  });
});

describe("withMaxPrice", () => {
  it("injects provider.max_price on a copy, preserving other provider keys", () => {
    const body = { model: "m", provider: { sort: "throughput" }, stream: true };
    const out = withMaxPrice(body, { prompt: 0.05, completion: 0.4 });
    expect(out.provider).toEqual({ sort: "throughput", max_price: { prompt: 0.05, completion: 0.4 } });
    expect(body.provider).toEqual({ sort: "throughput" }); // input untouched
    expect(out.stream).toBe(true);
  });

  it("the gate wins over a client-supplied max_price", () => {
    const body = { model: "m", provider: { max_price: { prompt: 999, completion: 999 } } };
    const out = withMaxPrice(body, { prompt: 0.05, completion: 0.4 });
    expect(out.provider.max_price).toEqual({ prompt: 0.05, completion: 0.4 });
  });

  it("is a no-op without a maxPrice", () => {
    const body = { model: "m" };
    expect(withMaxPrice(body, null)).toBe(body);
  });
});

describe("spendReportFromExecution", () => {
  it("builds a key-safe payload for governor's ledger hook", () => {
    const execution = {
      executionId: "9r_exec_1",
      endpoint: "/v1/chat/completions",
      requestedModel: "openrouter/deepseek/deepseek-v4-flash",
      actual: { provider: "openrouter", model: "deepseek/deepseek-v4-flash" },
      heron: { trace_id: "t1", consumer: "homenode-voice" },
      spendGate: { consumer: "homenode-voice", decision: "allow", reason: "budget_available", tier: "paid" },
    };
    const payload = spendReportFromExecution(execution, {
      status: "success",
      tokens: { prompt: 100, completion: 20 },
      costUsd: 0.0001,
    });
    expect(payload.consumer).toBe("homenode-voice");
    expect(payload.execution_id).toBe("9r_exec_1");
    expect(payload.cost_usd).toBe(0.0001);
    expect(payload.tier).toBe("paid");
    expect(payload.trace_id).toBe("t1");
    expect(JSON.stringify(payload)).not.toContain("sk-or-");
  });
});

describe("reportSpendToGovernor", () => {
  const OLD_BASE = process.env.GOVERNOR_BASE_URL;
  const OLD_FETCH = global.fetch;
  afterEach(() => {
    if (OLD_BASE === undefined) delete process.env.GOVERNOR_BASE_URL;
    else process.env.GOVERNOR_BASE_URL = OLD_BASE;
    global.fetch = OLD_FETCH;
  });

  it("marks missing cost or usage unverified without sending a record", async () => {
    process.env.GOVERNOR_BASE_URL = "http://127.0.0.1:9";
    global.fetch = vi.fn();
    const result = await reportSpendToGovernor({ execution_id: "e1", request_id: "e1", input_tokens: 10, output_tokens: 2, cost_usd: null });
    expect(result.status).toBe("unverified");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("surfaces rejected spend reports to the caller", async () => {
    process.env.GOVERNOR_BASE_URL = "http://127.0.0.1:9";
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "consumer_unknown" }), { status: 422 }));
    const result = await reportSpendToGovernor({ execution_id: "e2", request_id: "e2", input_tokens: 10, output_tokens: 2, cost_usd: 0.01 });
    expect(result).toMatchObject({ status: "rejected", httpStatus: 422, code: "consumer_unknown" });
  });
});


describe("selectOutboundCredentials", () => {
  const OLD_VOICE_KEY = process.env[VOICE_KEY_ENV_VAR];
  const SENTINEL = "sk-or-voice-TESTKEY-NEVER-REAL-abc123";

  beforeEach(() => {
    resetVoiceKeyWarning();
    delete process.env[VOICE_KEY_ENV_VAR];
  });

  afterEach(() => {
    resetVoiceKeyWarning();
    if (OLD_VOICE_KEY === undefined) delete process.env[VOICE_KEY_ENV_VAR];
    else process.env[VOICE_KEY_ENV_VAR] = OLD_VOICE_KEY;
  });

  it("swaps to the voice key for the voice consumer on openrouter", () => {
    process.env[VOICE_KEY_ENV_VAR] = SENTINEL;
    const orig = { apiKey: "default-key", connectionId: "c1" };
    const out = selectOutboundCredentials(orig, {
      provider: "openrouter",
      heron: { consumer: VOICE_CONSUMER },
    });
    expect(out.apiKey).toBe(SENTINEL);
    expect(out).not.toBe(orig);
    // original stored-connection object is never mutated
    expect(orig.apiKey).toBe("default-key");
    expect(out.connectionId).toBe("c1");
  });

  it("falls back to the default key with a one-line warning when the voice key is missing", () => {
    const warnings = [];
    const orig = { apiKey: "default-key" };
    const out1 = selectOutboundCredentials(orig, {
      provider: "openrouter",
      heron: { consumer: VOICE_CONSUMER },
      onWarn: (m) => warnings.push(m),
    });
    expect(out1).toBe(orig);
    expect(out1.apiKey).toBe("default-key");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(VOICE_KEY_ENV_VAR);
    // warning is once per process
    const out2 = selectOutboundCredentials(orig, {
      provider: "openrouter",
      heron: { consumer: VOICE_CONSUMER },
      onWarn: (m) => warnings.push(m),
    });
    expect(out2).toBe(orig);
    expect(warnings).toHaveLength(1);
  });

  it("never emits the key value through the warning path", () => {
    // Key set: swap is silent, no warning at all.
    process.env[VOICE_KEY_ENV_VAR] = SENTINEL;
    const warnings = [];
    const out = selectOutboundCredentials(
      { apiKey: "default-key" },
      {
        provider: "openrouter",
        heron: { consumer: VOICE_CONSUMER },
        onWarn: (m) => warnings.push(m),
      },
    );
    expect(warnings).toHaveLength(0);
    expect(out.apiKey).toBe(SENTINEL); // the value itself travels to the provider, never logged

    // Key missing: the warning names the env var but carries no key material.
    resetVoiceKeyWarning();
    delete process.env[VOICE_KEY_ENV_VAR];
    const warnings2 = [];
    selectOutboundCredentials(
      { apiKey: "default-key" },
      {
        provider: "openrouter",
        heron: { consumer: VOICE_CONSUMER },
        onWarn: (m) => warnings2.push(m),
      },
    );
    expect(warnings2).toHaveLength(1);
    expect(warnings2[0]).toContain(VOICE_KEY_ENV_VAR);
    expect(warnings2[0]).not.toMatch(/sk-/);
    expect(warnings2.join(" ")).not.toContain(SENTINEL);
  });

  it("keeps the default key for other consumers", () => {
    process.env[VOICE_KEY_ENV_VAR] = SENTINEL;
    const orig = { apiKey: "default-key" };
    for (const heron of [{ consumer: "9router-coding" }, { consumer: "default" }, null, {}]) {
      const out = selectOutboundCredentials(orig, { provider: "openrouter", heron });
      expect(out).toBe(orig);
    }
  });

  it("keeps the default key for non-openrouter providers even for the voice consumer", () => {
    process.env[VOICE_KEY_ENV_VAR] = SENTINEL;
    const orig = { apiKey: "default-key" };
    for (const provider of ["anthropic", "google", null]) {
      const out = selectOutboundCredentials(orig, {
        provider,
        heron: { consumer: VOICE_CONSUMER },
      });
      expect(out).toBe(orig);
    }
  });

  it("passes through null credentials", () => {
    process.env[VOICE_KEY_ENV_VAR] = SENTINEL;
    expect(
      selectOutboundCredentials(null, { provider: "openrouter", heron: { consumer: VOICE_CONSUMER } }),
    ).toBeNull();
  });

  it("trims whitespace-only voice key as missing", () => {
    process.env[VOICE_KEY_ENV_VAR] = "   ";
    const warnings = [];
    const orig = { apiKey: "default-key" };
    const out = selectOutboundCredentials(orig, {
      provider: "openrouter",
      heron: { consumer: VOICE_CONSUMER },
      onWarn: (m) => warnings.push(m),
    });
    expect(out).toBe(orig);
    expect(warnings).toHaveLength(1);
  });
});

describe("heron-harness-opencode consumer (Phase-1 production grant)", () => {
  const CONSUMER = "heron-harness-opencode";
  const FREE_MODEL = "qwen/qwen3.8-27b:free";
  const PAID_MODEL = "deepseek/deepseek-v4-flash";
  const SECRET = "test-only-proxy-secret-0123456789abcdef";
  const OLD_SECRET = process.env[PROXY_HMAC_SECRET_ENV];

  function harnessQuota(overrides = {}) {
    return {
      [CONSUMER]: {
        daily_cap_usd: 0.5,
        spent_today_usd: 0,
        tier_order: ["free"],
        paid_tier_allowed: false,
        allowed_models: [FREE_MODEL, "nvidia/nemotron-3-super-120b-a12b:free", "openrouter/free"],
        attested: true,
        ...overrides,
      },
    };
  }
  function heronClaim(overrides = {}) {
    return { consumer: CONSUMER, trace_id: "trace-1", work_id: "task-abc123", ...overrides };
  }
  function goodAttestation(overrides = {}) {
    return signConsumerAttestation({ consumer: CONSUMER, traceId: "trace-1", workId: "task-abc123", secret: SECRET, ...overrides });
  }

  beforeEach(() => {
    process.env[PROXY_HMAC_SECRET_ENV] = SECRET;
  });
  afterEach(() => {
    if (OLD_SECRET === undefined) delete process.env[PROXY_HMAC_SECRET_ENV];
    else process.env[PROXY_HMAC_SECRET_ENV] = OLD_SECRET;
  });

  it("allows an attested free-model claim from the task proxy path", () => {
    writeQuota(harnessQuota());
    const gate = checkSpendGate({ heron: heronClaim(), model: FREE_MODEL, attestation: goodAttestation() });
    expect(gate.decision).toBe("allow");
    expect(gate.consumer).toBe(CONSUMER);
    const { tier, maxPrice } = pricePolicyFor(gate, { model: FREE_MODEL });
    expect(tier).toBe("free");
    expect(maxPrice).toEqual({ prompt: 0, completion: 0 });
  });

  it("rejects a spoofed consumer claim with no attestation", () => {
    writeQuota(harnessQuota());
    const gate = checkSpendGate({ heron: heronClaim(), model: FREE_MODEL, attestation: null });
    expect(gate.decision).toBe("deny");
    expect(gate.reason).toBe("consumer_attestation_failed");
    expect(isBudgetExhaustedResponse(budgetExhaustedResponse(gate))).toBe(true);
  });

  it("rejects an attestation signed for a different consumer", () => {
    writeQuota(harnessQuota());
    const forged = signConsumerAttestation({ consumer: "homenode-voice", traceId: "trace-1", workId: "task-abc123", secret: SECRET });
    const gate = checkSpendGate({ heron: heronClaim(), model: FREE_MODEL, attestation: forged });
    expect(gate.decision).toBe("deny");
    expect(gate.reason).toBe("consumer_attestation_failed");
  });

  it("rejects an attestation bound to a different trace/work identity", () => {
    writeQuota(harnessQuota());
    const replay = signConsumerAttestation({ consumer: CONSUMER, traceId: "trace-OTHER", workId: "task-OTHER", secret: SECRET });
    const gate = checkSpendGate({ heron: heronClaim(), model: FREE_MODEL, attestation: replay });
    expect(gate.decision).toBe("deny");
    expect(gate.reason).toBe("consumer_attestation_failed");
  });

  it("rejects an expired attestation", () => {
    writeQuota(harnessQuota());
    const stale = goodAttestation({ nowMs: Date.now() - 3600_000 });
    const gate = checkSpendGate({ heron: heronClaim(), model: FREE_MODEL, attestation: stale });
    expect(gate.decision).toBe("deny");
    expect(gate.reason).toBe("consumer_attestation_failed");
  });

  it("fails closed when the shared secret is not configured", () => {
    writeQuota(harnessQuota());
    delete process.env[PROXY_HMAC_SECRET_ENV];
    const gate = checkSpendGate({ heron: heronClaim(), model: FREE_MODEL, attestation: goodAttestation() });
    expect(gate.decision).toBe("deny");
    expect(gate.reason).toBe("consumer_attestation_unverifiable");
  });

  it("denies a registered consumer with no approved budget (fail closed)", () => {
    writeQuota(harnessQuota({ daily_cap_usd: null }));
    const gate = checkSpendGate({ heron: heronClaim(), model: FREE_MODEL, attestation: goodAttestation() });
    expect(gate.decision).toBe("deny");
    expect(gate.reason).toBe("consumer_budget_unset");
  });

  it("denies a model outside the consumer allowlist", () => {
    writeQuota(harnessQuota());
    const gate = checkSpendGate({ heron: heronClaim(), model: PAID_MODEL, attestation: goodAttestation() });
    expect(gate.decision).toBe("deny");
    expect(gate.reason).toBe("model_not_permitted");
  });

  it("denies a paid model for a free-only consumer even without an allowlist", () => {
    writeQuota({ [CONSUMER]: { daily_cap_usd: 0.5, spent_today_usd: 0, paid_tier_allowed: false, attested: false } });
    const gate = checkSpendGate({ heron: heronClaim(), model: PAID_MODEL });
    expect(gate.decision).toBe("deny");
    expect(gate.reason).toBe("paid_tier_not_permitted");
  });

  it("leaves legacy unattested consumers untouched", () => {
    writeQuota({ "homenode-voice": { daily_cap_usd: 1.0, spent_today_usd: 0.0 } });
    const gate = checkSpendGate({ heron: { consumer: "homenode-voice", trace_id: "t" }, model: "qwen/qwen3.8-27b:free" });
    expect(gate.decision).toBe("allow");
  });

  it("keeps work_id as provenance and consumer as billing identity on receipts", () => {
    const execution = {
      executionId: "9r_exec_receipt_test",
      heron: { consumer: CONSUMER, work_id: "task-abc123", trace_id: "trace-1" },
      spendGate: { consumer: CONSUMER, decision: "allow", reason: "budget_available" },
      actual: { provider: "openrouter", model: FREE_MODEL },
      requestedModel: FREE_MODEL,
      endpoint: "/v1/chat/completions",
    };
    const report = spendReportFromExecution(execution, {
      status: "success",
      tokens: { input_tokens: 120, output_tokens: 45 },
      costUsd: 0,
    });
    expect(report.consumer).toBe(CONSUMER);            // billing identity
    expect(report.consumer).not.toBe("task-abc123");  // work_id never becomes billing
    expect(report.trace_id).toBe("trace-1");          // correlation preserved
    expect(report.request_id).toBe("9r_exec_receipt_test");
    expect(report.model).toBe(FREE_MODEL);
    expect(report.provider).toBe("openrouter");
    expect(report.input_tokens).toBe(120);
    expect(report.output_tokens).toBe(45);
    expect(report.cost_usd).toBe(0);
  });
});

describe("verifyConsumerAttestation", () => {
  const SECRET = "test-only-proxy-secret-0123456789abcdef";
  it("round-trips a signed attestation", () => {
    const a = signConsumerAttestation({ consumer: "c", traceId: "t", workId: "w", secret: SECRET });
    expect(verifyConsumerAttestation({ consumer: "c", traceId: "t", workId: "w", attestation: a, secret: SECRET })).toEqual({ ok: true });
  });
  it("rejects tampered mac", () => {
    const a = signConsumerAttestation({ consumer: "c", traceId: "t", workId: "w", secret: SECRET });
    const tampered = a.slice(0, -1) + (a.endsWith("0") ? "1" : "0");
    expect(verifyConsumerAttestation({ consumer: "c", traceId: "t", workId: "w", attestation: tampered, secret: SECRET }).ok).toBe(false);
  });
  it("rejects malformed input", () => {
    expect(verifyConsumerAttestation({ consumer: "c", attestation: "bogus", secret: SECRET }).reason).toBe("attestation_malformed");
    expect(verifyConsumerAttestation({ consumer: "c", attestation: null, secret: SECRET }).reason).toBe("attestation_missing");
    expect(verifyConsumerAttestation({ consumer: "c", attestation: "v1,1,abc", secret: null }).reason).toBe("secret_unconfigured");
  });
});

describe("isFreeOnlyConsumer / consumerAllowsModel", () => {
  it("detects free-only entries", () => {
    expect(isFreeOnlyConsumer({ paid_tier_allowed: false })).toBe(true);
    expect(isFreeOnlyConsumer({ tier_order: ["free"] })).toBe(true);
    expect(isFreeOnlyConsumer({ tier_order: ["free", "paid"] })).toBe(false);
    expect(isFreeOnlyConsumer({ daily_cap_usd: 1 })).toBe(false);
    expect(isFreeOnlyConsumer(null)).toBe(false);
  });
  it("enforces exact allowlist membership", () => {
    const entry = { allowed_models: ["qwen/qwen3.8-27b:free"] };
    expect(consumerAllowsModel(entry, "qwen/qwen3.8-27b:free")).toBe(true);
    expect(consumerAllowsModel(entry, "deepseek/deepseek-v4-flash")).toBe(false);
    expect(consumerAllowsModel({}, "anything")).toBe(true);
    expect(consumerAllowsModel(entry, null)).toBe(true);
  });
});
