---
name: verify-no-regressions
description: Prove a large change introduced zero test regressions in this repo, and debug the two ways test evidence lies (stale vitest transforms, swallowed exceptions converted to error responses). Use when finishing a slice, after any multi-file change, before claiming "tests pass", when a test's behaviour contradicts source you just edited, or when a thrown error surfaces as a 5xx/200 Response from an unexpected layer.
---

# Verify no regressions (and trust the verdict)

Claiming "tests pass" from a single `vitest run` is not evidence in this repo.
This suite is not all-green on a clean checkout (~115 pre-existing failures,
network/env-dependent), and the committed `tests/__baseline__/verify-no-regression.mjs`
is **not self-contained**: it splits result paths on `/app/` and compares only a
62-file baseline, so a full local run cannot reproduce its gate. The reliable
proof is a **failure-set diff** between your working tree and a clean-tree run
of the same suite.

## Branches

### B1 — Prove zero new failures

```bash
npm run verify:no-regressions
```

`NEW: 0` (current ⊇ clean's failure set) is the pass condition. Presence of the
115 baseline failures is normal — identical sets on both sides is the verdict.
Regenerate `/tmp/vitest-clean.json` whenever the upstream baseline might have
moved; it is a snapshot, not an eternal truth.

Never substitute a partial run (single file, one suite) as regression evidence —
a partial run masks cross-file breakage.

### B2 — Preserve the dirty worktree

The repository script creates a detached linked worktree at the current HEAD,
shares installed dependencies when available, runs the same full suite there,
compares failure sets, and removes only that temporary worktree. Do not use
stash/pop for this gate: untracked artifacts can collide with restoration and
the user's dirty tree must remain untouched.

### B3 — Test behaviour contradicts source you just edited: stale cache, not your bug

Vitest can serve a stale transform after rapid source edits, making the test
run OLD code while you debug NEW code (symptom: the failure contradicts what
you can see in the file). Do this before touching the app:

```bash
npx vitest --clearCache
npx vitest run <file>          # still contradictory? → probe the mock
```

Probe the mock/function directly in the test to learn what actually happens:

```js
await mocks.handleChatCore({});            // does it reject or resolve?
console.log(await res.text());             // what BODY really came back
```

Then trace which layer produced that response. This repo's outer handlers
**swallow throws and convert them**: `handleComboChat`'s catch-all turns a
thrown model error into `{ error: { message: <error.message> } }` at 5xx —
so a response body containing your exact error message does not mean your
wrapper produced it. The wrapper's own catch, if any, never ran.

### B4 — Status constants: a missing constant is a silent 200

`new Response(body, { status: undefined })` is a **200**, not an error. A
handler that references a non-existent `HTTP_STATUS.*` constant therefore
returns 200 with an error body — the silent failure mode. Check the constant
exists (`grep HTTP_STATUS.NAME open-sse/config/runtimeConfig.js`) and assert
`res.status` in the test; `INTERNAL_SERVER_ERROR` does not exist — use
`BAD_GATEWAY`/`SERVICE_UNAVAILABLE`/`UNAUTHORIZED` which do.

### B5 — Async coordination machinery: test the leaf, not the race

Code behind timers/grace windows (`collectPanel`, stream controllers) is
flaky to exercise through the machinery — panel order, quorum timers, and
straggler windows make assertions timing-dependent. Export the leaf function
(`export function finalizeForkedExecution …`) and unit-test it directly with a
fake context. Deterministic beats end-to-end here.

### B6 — Live acceptance: prefix provider model ids correctly

An un-prefixed model slug routes to whichever provider owns the prefix
(`qwen/…` → provider `qwen`), not the one you meant. For OpenRouter, ask the
provider first: `curl https://openrouter.ai/api/v1/models`, filter `:free`,
and use the candidate as `openrouter/<slug>`. Free-tier models are
rate-limited and can 404 as "unavailable for free" per-account — try several,
and verify with `stream:false` so usage surfaces.

## Outcome

State the verdict as: `NEW failures: N (current vs clean-tree, full suite,
same runner)`. If N ≠ 0, list the new failures and their source before
claiming completion.
