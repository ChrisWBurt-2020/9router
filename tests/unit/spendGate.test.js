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
  selectOutboundCredentials,
  resetVoiceKeyWarning,
  VOICE_CONSUMER,
  VOICE_KEY_ENV_VAR,
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
  it("falls back to work_id", () => {
    expect(resolveConsumer({ work_id: "work-42" })).toBe("work-42");
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

  it("allows an unlisted consumer (governor claims jurisdiction by listing)", () => {
    writeQuota({
      "homenode-voice": { daily_cap_usd: 1.0, spent_today_usd: 0.0 },
    });
    const d = checkSpendGate({ heron: { consumer: "opencode" } });
    expect(d.decision).toBe("allow");
    expect(d.unmanaged).toBe(true);
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

  it("unmanaged consumers get no max_price (existing behavior preserved)", () => {
    writeQuota({ "homenode-voice": entry });
    const gate = checkSpendGate({ heron: { consumer: "opencode" } });
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
