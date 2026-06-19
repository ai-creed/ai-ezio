# ezio `/resume` and `/rename` — cross-repo delivery record

**Date:** 2026-06-19
**Spec:** `2026-06-18-ezio-resume-rename-commands-design.md` (§7 stages this work across
two repos). **Status:** delivered + green in both repos.

This feature is, by design and by the project's boundary rules, a **two-repo
deliverable**. `AGENTS.md` is explicit: the ai-whisper adapter "is **not** a package
here. It was retired at M5 and now lives in the ai-whisper repo as
`packages/adapter-ai-ezio` (it imports `@ai-ezio/harness`)." The harness stays
workflow-agnostic; mounted/adapter behavior **must** live downstream in ai-whisper.
Therefore a `git diff` of the **ai-ezio** repo alone will never show the mounted
implementation — it is correctly located in the **ai-whisper** repo. This record
exists so the complete deliverable is discoverable + verifiable from the ai-ezio HEAD.

## ai-ezio repo — standalone half + shared engine/surface (branch `docs/ezio-resume-rename-spec`)

Commits (`7bf9366..HEAD`):

| Commit | Scope |
|---|---|
| `47d9346` | harness: session title store + `RenameController` (§1A/§1C) |
| `0e965a3` | harness: `Session.resume` with generation-stamped pump (§3) |
| `28cf5b4` | surface: relocate resume picker + title merge (§1B) |
| `7b7f7e8` | surface: `/resume` + `/rename` commands + `runResumeFlow` (§2/§3) |
| `77787e2` | cli: wire `/resume` + `/rename` into the standalone runtime (Stage 2) |
| `2039f45` | fix: re-render banner on respawn + test production resume wiring |
| `18d35cf` | fix: feed standalone `/resume` picker whole chunks (arrow keys) |
| `1944332` | fix: restore standalone REPL raw mode after the `/resume` picker |
| `b9cff4e` | fix: gate-held resume is a recoverable `EngineBusyError`, not a fatal teardown (busy-guard backstop) |

Verify: `pnpm -r build && pnpm -r test` → protocol 21, harness 87, surface 128,
mcp-host 30, session-recorder 25 (+1 skip), cli 166 = **457 passed / 1 skip**. The hax
engine is built, so the real-engine `Session.resume` test (history replay + repeated
resume + stale-EOF race) and the §1C no-idle-theft test run, not skip.

## ai-whisper repo — mounted half (overlay seam + adapter) (branch `docs/ezio-resume-rename-spec`)

Located at `/Users/vuphan/Dev/ai-whisper`. Commits (`0363f5d..HEAD`):

| Commit | Files | Scope |
|---|---|---|
| `f2e52b2` | `packages/shared/src/interactive-session.ts` (+ index) | `OverlayIO` / `OverlayRunner` types (§3) |
| `375e0a9` | `packages/cli/src/runtime/live-session.ts`, `test/live-session-runtime.test.ts` | host-owned `runInteractiveOverlay` (suspend → feed raw keys → restore) + ordering test |
| `34ad658` | `packages/adapter-ai-ezio/src/ai-ezio-engine.ts` | `resume` on the engine facet |
| `739c318` | `packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts`, `packages/cli/src/runtime/providers.ts`, `test/adapter-ai-ezio-live-session.test.ts` (+215) | mounted `SlashContext` wiring (rename controller, resume thunk via the overlay, busy guard, post-respawn host re-register + banner), overlay injection, and the spec-required e2e |
| `0c12c1e` | `packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts`, `test/adapter-ai-ezio-live-session.test.ts` | fix: mark mounted session busy AT submit (close the post-submit/pre-`assistant_turn_started` `/resume` race) + regression test |

The §6 mounted e2e (`test/adapter-ai-ezio-live-session.test.ts`, the
`"persists the title, switches the live session, and re-renders the banner"` test)
drives `/rename` then `/resume` through the **real `@ai-ezio/harness` engine under
`HAX_PROVIDER=mock`** in a mounted pane and asserts: title persisted (the pre-resume
`/rename` flushes to the active id), session switched (a post-resume `/rename` lands
under the past id), and banner re-rendered (banner chrome in captured stdout after
`/resume`). It RUNS (the hax binary is present), not skipped.

Verify (from `/Users/vuphan/Dev/ai-whisper`):
```sh
git log --oneline 0363f5d..HEAD          # the 5 mounted commits above
pnpm install                              # refresh the file: ezio deps (resolves @ai-ezio/* from dist)
pnpm typecheck                            # whole-repo tsc --noEmit — clean
pnpm exec vitest run test/adapter-ai-ezio-live-session.test.ts test/live-session-runtime.test.ts
                                          # → 49 passed / 0 skipped (incl. the mounted /rename→/resume e2e)
pnpm test                                 # full suite → 257 files, 1584 passed / 3 skip
```

## Acceptance note

Acceptance of this feature requires inspecting **both** repos. A review scoped to the
ai-ezio commit range alone cannot observe the mounted half — not because it is
missing, but because the engine/harness/adapter boundary (`AGENTS.md`) places it in
ai-whisper. Both repos' full suites are green at the commits above.
