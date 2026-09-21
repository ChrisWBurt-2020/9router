/**
 * seed-free-combos.mjs
 *
 * Re-points the governor combos (gov-build / gov-reason / gov-review /
 * gov-fast / gov-emergency) to free-tier model chains and marks them
 * kind = "free-tier".
 *
 * A free-tier combo lets the engine's handleComboChat enforce the
 * EMERGENCY_FREE_MODE invariant: only price 0/0 models (OpenRouter `:free`
 * variants or the `openrouter/free` catch-all) are used, and a paid candidate
 * is refused (503) rather than silently substituted.
 *
 * Every model written here is validated against the engine's own
 * isFreeModelId predicate, so the seed can never write a chain the engine
 * will reject at request time.
 *
 * Idempotent — existing combos are updated in place (id preserved, only kind
 * + models + updatedAt change), missing ones inserted. Run with --dry to
 * preview without writing. Back up the DB before a live run.
 *
 * Run: node scripts/seed-free-combos.mjs [--dry]
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isFreeModelId } from "../open-sse/config/freeModels.js";

const DRY = process.argv.includes("--dry");

const DATA_DIR = process.env.DATA_DIR || path.join(homedir(), ".9router");
const DB_PATH = path.join(DATA_DIR, "db", "data.sqlite");

// Heavy chain — reasoning-grade open source models. Uses the :free variants
// with the openrouter/free catch-all as the last resort.
const HEAVY = [
  "openrouter/qwen/qwen3.6-plus:free",
  "openrouter/nex-agi/nex-n2.5-pro:free",
  "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
  "openrouter/moonshotai/kimi-k2.6:free",
  "openrouter/qwen/qwen3-coder:free",
  "openrouter/free",
];

// Cheap / emergency chain — fast code-adjacent models, same free-tier rules.
const CHEAP = [
  "openrouter/cohere/north-mini-code:free",
  "openrouter/mistralai/devstral-2512:free",
  "openrouter/nvidia/nemotron-3.5-lightning:free",
  "openrouter/poolside/laguna-s-2.1:free",
  "openrouter/free",
];

const COMBOS = [
  { name: "gov-build", models: HEAVY },
  { name: "gov-reason", models: HEAVY },
  { name: "gov-review", models: HEAVY },
  { name: "gov-fast", models: CHEAP },
  { name: "gov-emergency", models: CHEAP },
];

function main() {
  // Validate the chains against the engine predicate before touching anything.
  const bad = [];
  for (const c of COMBOS) {
    for (const m of c.models) {
      if (!isFreeModelId(m)) bad.push(`${c.name} → ${m}`);
    }
  }
  if (bad.length > 0) {
    console.error(`SEED FAIL: non-free model in seed chain (EMERGENCY_FREE_MODE would refuse it):`);
    for (const b of bad) console.error(`  - ${b}`);
    process.exit(1);
  }

  if (DRY) {
    // Never open (or create) the DB on a dry run. A missing file means every
    // combo would be inserted; an existing one is opened read-only to report
    // insert-vs-update accurately.
    console.log(`[DRY] DB: ${DB_PATH}`);
    if (!existsSync(DB_PATH)) {
      for (const c of COMBOS) console.log(`[DRY] would INSERT ${c.name} → free-tier chain`);
    } else {
      // immutable=1 + readOnly: SQLite refuses to create -wal/-shm sidecars,
      // so a dry run really touches nothing on disk (plain readOnly still
      // creates them when the DB is in WAL mode).
      const uri = `file:${DB_PATH.replace(/[%?#]/g, encodeURIComponent).replace(/ /g, "%20")}?immutable=1`;
      const db = new DatabaseSync(uri, { readOnly: true });
      const findName = db.prepare(`SELECT id FROM combos WHERE name = ?`);
      for (const c of COMBOS) {
        const existing = findName.get(c.name);
        console.log(`[DRY] would ${existing ? "UPDATE" : "INSERT"} ${c.name} → free-tier chain`);
      }
      db.close();
    }
    console.log(`[DRY] no changes written`);
    return;
  }

  const db = new DatabaseSync(DB_PATH);

  let updated = 0;
  let inserted = 0;

  const findName = db.prepare(`SELECT id FROM combos WHERE name = ?`);
  const insert = db.prepare(
    `INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const update = db.prepare(
    `UPDATE combos SET kind = ?, models = ?, updatedAt = ? WHERE id = ?`
  );

  const now = new Date().toISOString();

  const apply = (c) => {
    const existing = findName.get(c.name);
    const json = JSON.stringify(c.models);
    if (existing) {
      update.run("free-tier", json, now, existing.id);
      updated++;
      console.log(`UPDATE ${c.name} (kind=free-tier, ${c.models.length} models, id preserved)`);
    } else {
      insert.run(randomUUID(), c.name, "free-tier", json, now, now);
      inserted++;
      console.log(`INSERT ${c.name} (kind=free-tier, ${c.models.length} models)`);
    }
  };

  db.exec(`BEGIN`);
  try {
    for (const c of COMBOS) apply(c);
    db.exec(`COMMIT`);
  } catch (err) {
    db.exec(`ROLLBACK`);
    console.error(`SEED FAIL: ${err.message}`);
    process.exit(1);
  }

  console.log(`SEED OK: ${updated} updated, ${inserted} inserted (${COMBOS.length} gov-* combos, kind=free-tier)`);
}

main();