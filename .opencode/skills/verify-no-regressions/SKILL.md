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
# 1. Capture the CURRENT full-suite result first (before touching the tree).
cd tests && npx vitest run --reporter=json --outputFile=/tmp/vitest-current.json

# 2. Stash everything including untracked, run the same suite on the clean tree.
git stash --include-untracked
npx vitest run --reporter=json --outputFile=/tmp/vitest-clean.json
git stash pop   # see B2 — this can fail

# 3. Diff the failure SETS (ignore counts that shift by +new tests).
node -e '
const fs=require("fs");
function fails(p){const r=JSON.parse(fs.readFileSync(p,"utf8"));const s=new Set();
for(const f of r.testResults)for(const a of f.assertionResults)if(a.status==="failed"){
  const i=f.name.indexOf("/tests/");const rel=i>=0?f.name.slice(i+7):f.name; s.add(rel+" :: "+a.fullName);}return s;}
const c=fails("/tmp/vitest-clean.json"),n=fails("/tmp/vitest-current.json");
console.log("clean",c.size,"current",n.size,"NEW",[...n].filter(x=>!c.has(x)).length);'
```

`NEW: 0` (current ⊇ clean's failure set) is the pass condition. Presence of the
115 baseline failures is normal — identical sets on both sides is the verdict.
Regenerate `/tmp/vitest-clean.json` whenever the upstream baseline might have
moved; it is a snapshot, not an eternal truth.

Never substitute a partial run (single file, one suite) as regression evidence —
a partial run masks cross-file breakage.

### B2 — After `git stash --include-untracked`, expect a pop collision

Running the suite on the stashed tree regenerates untracked artifacts (snapshot
files, DB dumps) that then collide with the stash on `pop`:

```
error: could not restore untracked files from stash
```

Recover: inspect what the stash actually holds, then drop it only when
everything is on disk.

```bash
git stash show --include-untracked --name-only   # compare against git status
# every file you created must appear BOTH here and on disk
git stash drop
```

Do not `pop --force` or guess; a kept stash that was actually applied is safe
to drop once the file lists match. Also: if a generated snapshot is not part of
your slice, gitignore it (`docs/*` whitelist style) or delete it — otherwise
`git status` never shows only your changes after the next suite run.

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