// v2: execution receipts. Adds indexed execution/trace lookup columns to
// usageHistory so a receipt can be found by execution_id or Heron trace_id
// even when conversation observability (requestDetails) is disabled.
//
// On a fresh DB, 001-initial already creates the table with these columns, so
// the ALTERs below are wrapped to stay idempotent. On a v1 database this is the
// migration that introduces them ahead of the additive syncSchemaFromTables()
// pass.
export default {
  version: 2,
  name: "execution-receipts",
  up(db) {
    const existing = new Set(db.all(`PRAGMA table_info(usageHistory)`).map((r) => r.name));
    for (const [col, def] of [["executionId", "TEXT"], ["traceId", "TEXT"]]) {
      if (!existing.has(col)) {
        try { db.exec(`ALTER TABLE usageHistory ADD COLUMN ${col} ${def}`); } catch {}
      }
    }
    for (const idx of [
      "CREATE INDEX IF NOT EXISTS idx_uh_execution ON usageHistory(executionId)",
      "CREATE INDEX IF NOT EXISTS idx_uh_trace ON usageHistory(traceId)",
    ]) {
      try { db.exec(idx); } catch {}
    }
  },
};
