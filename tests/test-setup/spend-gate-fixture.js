/**
 * Spend-gate test fixture.
 *
 * The spend gate is fail-closed in production: without a governor quota file,
 * every request is denied (HTTP 402 budget_exhausted). The test suite must not
 * depend on production governor state, so this setup file writes a permissive
 * quota fixture and points GOVERNOR_QUOTA_FILE at it for every test worker.
 *
 * Individual tests can override process.env.GOVERNOR_QUOTA_FILE in their own
 * beforeEach (see tests/unit/spendGate.test.js).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-spend-fixture-"));
const quotaFile = path.join(dir, "quota.json");

// Generous caps: the fixture exists to let tests exercise normal routing.
// "default" covers requests without Heron correlation metadata.
fs.writeFileSync(
  quotaFile,
  JSON.stringify({
    version: 1,
    updated_at: new Date().toISOString(),
    consumers: {
      default: {
        daily_cap_usd: 1000,
        spent_today_usd: 0,
        tier_order: ["free", "paid"],
        max_price: { prompt: 0.05, completion: 0.4 },
      },
      "homenode-voice": {
        daily_cap_usd: 1000,
        spent_today_usd: 0,
        tier_order: ["free", "paid"],
        max_price: { prompt: 0.05, completion: 0.4 },
      },
      opencode: {
        daily_cap_usd: 1000,
        spent_today_usd: 0,
        tier_order: ["free", "paid"],
        max_price: { prompt: 0.05, completion: 0.4 },
      },
    },
  }),
  "utf8"
);

process.env.GOVERNOR_QUOTA_FILE = quotaFile;
