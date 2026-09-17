# Workspace rules — 9Router

The always-on invariants below supplement the guidance in `CLAUDE.md` (read it
too). Test/CI evidence machinery lives in `.opencode/skills/verify-no-regressions/`.

- **Regression proof is a failure-set diff, never a partial run.** Claim "tests
  pass / no regressions" only after comparing the full-suite failure set against
  a clean-tree run of the same suite (`NEW: 0`). A single-file or single-suite
  run masks cross-file breakage, and the committed `verify-no-regression.mjs`
  baseline is not self-contained. Full procedure: the
  `verify-no-regressions` skill.

- **Never pass an unverified HTTP-status constant.** `new Response(body,
  { status: undefined })` is a silent **200**, not an error. Confirm
  `HTTP_STATUS.*` exists in `open-sse/config/runtimeConfig.js` before using it
  (`INTERNAL_SERVER_ERROR` does not; use `BAD_GATEWAY`).

- **Assert the response status in every error-path test.** A handler that
  references a missing constant, or whose outer combo handler converts a thrown
  upstream error, will hand you a 200-with-error-body or a 5xx from a layer
  other than the one you edited. The test's `expect(res.status)` is what
  catches both.

- **After any bulk machine edit (sed/python/sed-style replaces) to code or
  tests, run `node --check` on the file and re-read the edited region.** Blind
  string replacement clobbers structural lines (closing braces, `it(` openers)
  in ways the diff does not make obvious.

## Capturing durable knowledge

When a session produces a reusable procedure or rule, follow the `learn` skill's
filter before writing it down:

- recurring in this workspace, not a one-off incident;
- not already stated by code, docs, or an existing skill (the code is the
  source of truth — do not copy it here);
- no secrets.

Procedures → `.opencode/skills/<name>/SKILL.md`. Terse always-on constraints →
this file. Durable project facts → project memory (`panoma_remember`), not a
file.