# M7 — Mounted ezio REPL parity (banner · prompt · usage)

- **Status:** draft for review (2026-06-05)
- **Milestone:** M7 (follow-up to M6) — interactive mounted experience
- **Repos touched:** ai-ezio (hax emitter + protocol + docs) and ai-whisper (adapter)
- **References:** `docs/architecture.md`, `docs/protocol.md`, `UPSTREAM.md`,
  `docs/milestones.md` (M4 mount mode), the M5/M6 adapter specs.

## Problem

A mounted `ezio` pane is intentionally bare. hax runs with `--mount-mode`, which
suppresses its human REPL chrome (banner, `›` prompt, per-turn usage line, resume
hint — guarded by `if (!opts->mount_mode)` in `vendor/hax/src/agent.c`) so the
**protocol** (fd 3 events / fd 4 controls) is the clean, unscraped control path.
That is correct for workflow/programmatic use, but for a **human** sitting in the
pane it looks dead: no provider/model banner, no prompt, no token usage — unlike
running hax directly (full REPL) or mounting codex/claude (PTY passthrough of
their own TUI).

We will **not** re-enable hax's REPL in a mount: that would require running hax in
REPL mode inside a PTY and scraping its screen — exactly the codex/claude approach
ai-ezio exists to replace. Instead we **re-create the REPL's *look*** (banner,
`›` prompt, usage line) on the **adapter** side, fed entirely by protocol events.
The engine stays protocol-native; the operator just gets a readable pane.

## Decision (locked)

| Decision | Choice |
| --- | --- |
| Approach | Cosmetic re-creation from protocol data — **not** re-enabling hax's REPL (no PTY, no scraping). |
| Scope | **Banner + `›` prompt + per-turn usage line.** (Line-buffered operator input already shipped in M6 follow-up.) |
| Engine patch | Minimal, at the emitter seam: surface data hax already computes (provider/model/effort; per-turn ctx/out/cached/limit). No new top-level loops; mount-mode still suppresses the *human* rendering. |
| Protocol | Extend existing events (`status`, `assistant_turn_finished`); document in `docs/protocol.md` first. New fields are **optional** (back-compatible). |
| codex/claude | Untouched (PTY passthrough path unchanged). |

## Layer 1 — hax emitter (C, `vendor/hax/src/protocol/emit.c` + `agent.c`)

The banner/usage data already exists in hax; only the emitter surfaces it.

1. **`status` event gains `effort`.** `emit_status(es, provider, model, session_id)`
   already emits `provider` + `model`; add `effort` (from `sess.reasoning_effort`,
   possibly empty). Signature gains an `effort` param.
2. **Auto-emit `status` once right after `ready` in mount mode.** Today `status`
   is only emitted in response to an `EMIT_CTL_STATUS` control. In mount mode, emit
   one `status` immediately after `obs_on_ready` so the adapter receives
   `provider · model · effort` at startup without asking. (A couple of lines near
   the mount-init path; gated on `opts->mount_mode` + `protocol_fd >= 0`.)
3. **`assistant_turn_finished` gains an optional `usage` object.** hax already
   computes `user_turn_ctx`, `user_turn_out`, `user_turn_cached` per turn and
   `context_limit(p)` — these feed `display_usage()` which mount-mode suppresses.
   Emit them as structured data on the turn-finished event:

   ```json
   "usage": { "contextTokens": 8900, "outputTokens": 595,
              "cachedTokens": 2700, "contextLimit": 262144 }
   ```

   Omit a field (or use `null`) when hax reports `-1` (backend didn't report), so
   the adapter can skip it — mirroring `display_usage`'s per-field guards. `usage`
   itself is omitted when no field is present.

Keep the patch at the emitter seam (`UPSTREAM.md` policy); no behavior change to
the human REPL path. Update `UPSTREAM.md` to note the widened emitter surface.

## Layer 2 — protocol (TS, `packages/protocol` + `docs/protocol.md`)

Document in `docs/protocol.md` **first**, then implement the schema/codec:

- **`status` event:** add optional `effort?: string`.
- **`assistant_turn_finished` event:** add optional
  `usage?: { contextTokens?: number; outputTokens?: number; cachedTokens?: number; contextLimit?: number }`.
- Document the **auto-on-ready `status` emit** in mount mode (a `status` event now
  legitimately arrives unsolicited right after `ready`).

All additions are optional → existing consumers and the M4 `status` control are
unaffected.

## Layer 3 — adapter (TS, ai-whisper `packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts`)

Render the re-created REPL look to the pane (`input.stdout`), driven by events:

- **On `status`:** render the banner once:
  `▌ ezio › <provider> · <model>[ · <effort>]` (skip `· effort` when empty).
  Mirrors `agent_print_banner` minus the REPL-only `ctrl-d quit · try /help` line
  (those controls don't apply in a mount).
- **On `assistant_turn_finished` (or `idle`):** if `usage` is present, render the
  dim usage line `context <ctx> / <limit> (<pct>%) · out <n> · cached <m>` (same
  shape/units as `display_usage`, using a small local `formatTokens`), skipping
  absent fields; then render a `›` prompt glyph so the pane reads like a REPL.
- Existing `assistant_delta` streaming and the M6 `onTurnFinished` handback are
  unchanged; the banner/usage/prompt are additive stdout writes.

A new `status` case is added to the live-session `onEvent` switch (today it
handles `assistant_delta`/`assistant_turn_finished`/`idle`).

## Testing

- **hax (meson):** with `HAX_PROVIDER=mock`, assert the emitter produces a
  `status` event (with `provider`/`model`/`effort`) right after `ready` in
  mount mode, and that `assistant_turn_finished` carries a `usage` object when the
  (mock) backend reports counts; assert no `usage` key when counts are `-1`.
- **protocol (vitest):** codec round-trips the new optional fields; absence stays
  absent (no `usage: undefined` leakage).
- **adapter (vitest):** feeding a `status` event renders the banner; an
  `assistant_turn_finished` with `usage` renders the usage line + `›` prompt;
  empty `effort`/missing usage fields are skipped; a turn with no `usage` still
  renders the prompt.
- **e2e:** extend `e2e:ai-ezio-mount` to assert the mounted pane emits a banner
  line on ready and a `›` prompt after a driven turn (mock engine).

## Done when

Mounting ezio shows, fed entirely by protocol events (engine still
protocol-native, no REPL re-enabled, no scraping): a provider·model·effort banner
on start, and after each turn a usage line + `›` prompt — comparable in *look* to
the hax REPL. codex/claude mounts and all M6 behavior are unchanged; full
verification gate (hax `meson test`, ai-whisper build/typecheck/lint/test, both
e2e) green.

## Out of scope (YAGNI)

- Re-enabling hax's actual REPL in a mount (PTY + scraping) — explicitly rejected.
- `/help`, conversation-reset UI, live in-place repaint/cursor management, dock
  bounce/notification — REPL-only behaviors that don't fit a protocol-driven pane.
- Surfacing the banner/usage to the dashboard/operator view (separate concern).

## Risks

| Risk | Mitigation |
| --- | --- |
| Emitter patch grows beyond the seam | Only surface data hax already computes; no new loops; gate on mount-mode; document in `UPSTREAM.md`. |
| Protocol drift / breaking M4 consumers | All new fields optional; `status` control behavior unchanged; document in `docs/protocol.md` first. |
| Banner/usage clutter during workflow runs (non-interactive) | The pane is the operator's view; the same stdout rendering M5 already does. If noisy for headless runs, gate later behind an interactive flag (not in M7). |
| hax rebuild required | `meson compile -C vendor/hax/build`; pin the new emitter commit as the submodule base per `UPSTREAM.md`. |
