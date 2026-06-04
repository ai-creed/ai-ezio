# M5 — ai-whisper adapter design spec

- **Date:** 2026-06-04
- **Status:** approved (brainstorm), pre-implementation
- **Milestone:** M5 (ai-whisper adapter)
- **Parent spec:** `docs/superpowers/specs/2026-06-03-ai-ezio-design.md`
- **Builds on:** M3 (protocol) + M4 (mounted mode)
- **References:** `docs/milestones.md` (M5/M6), `UPSTREAM.md`; ai-whisper
  `docs/superpowers/specs/2026-04-03-ai-whisper-adapter-boundary-contract-design.md`,
  `packages/shared/src/{provider-contract,interactive-session}.ts`,
  `packages/adapter-codex/`
- **Canonical copy:** `~/.ai-pref-nsync/local-docs/ai-ezio/specs/` (this file is the synced mirror)

## Purpose

Make ai-ezio a first-class ai-whisper **provider**, driven over the explicit
protocol instead of TUI scraping, and prove it with **one relay handoff end to
end**. Where ai-whisper drives Codex/Claude by typing into a PTY and scraping
output for readiness, ai-ezio is driven by `submit()` controls and explicit
`idle`/`assistant_turn_finished` events.

The smoking gun this milestone removes: to deliver one handoff to Codex,
ai-whisper's `submitInjectedProviderInput` types the text as a keystream drip
(char-by-char, ~5 ms apart) or bracketed paste, guesses readiness from "is paste
mode on," and sends `\r` on a separate beat — all to avoid corrupting a TUI. For
ai-ezio that collapses to **`session.submit(text)`**.

## Guiding principle (locked)

**Workflow-serving glue lives in ai-whisper; standalone-agent capability lives in
ai-ezio.** ai-ezio must run independently as a drop-in coding agent (a Codex
replacement) for users who don't want ai-whisper's workflows. Therefore:

- `@ai-ezio/harness` (ai-ezio) stays **workflow-agnostic** — it never imports
  `@ai-whisper/shared`. The adapter consumes its `Session`.
- The adapter (which implements ai-whisper's contract) lives **in the ai-whisper
  repo** as `packages/adapter-ai-ezio`. ai-ezio's placeholder `packages/adapter`
  is **retired** (it is workflow glue that belongs in ai-whisper).

## Decisions (locked in brainstorm)

| Decision | Choice |
| --- | --- |
| Agent identity (role) | The workflow **role / agentType / providerId is `ezio`** (in family with `codex`/`claude`); `whisper collab mount ezio`, with `ezio` also a bin alias for the standalone agent. **`ai-ezio` remains the project / package / repo name** (`@ai-ezio/harness`, `packages/adapter-ai-ezio`, the `ai-ezio` package) |
| Adapter location | `packages/adapter-ai-ezio` **in the ai-whisper repo** (mirrors adapter-codex); imports `@ai-ezio/harness` + `@ai-whisper/shared`. ai-ezio `packages/adapter` retired |
| Harness coupling | `@ai-ezio/harness` stays workflow-agnostic (no `@ai-whisper/shared` dependency) |
| Integration depth | **Protocol-native drive path** in the ai-whisper mount layer: handoff via `submit()`, readiness/idle from the explicit `idle` event — not output quiescence; an `ezio` `submit-strategy` that bypasses keystream/paste typing |
| Operator visibility | The mounted session renders the streamed `assistant_delta` text (and tool events) to shared stdout so the dashboard shows ai-ezio working |
| `handleWork` | Implemented (direct-packet): `submitAndWait` → `ProviderReply{kind,content,transitionIntent}` (no scraping). **Empty-content rule** below guarantees a valid (`min 1`) reply even on tool-only turns |
| Session model | One **persistent** `Session` per mount (conversation continuity across handoffs) |
| Relay interception (`@@other`) | Declared `false` for M5; deferred to M6 |
| Working model | Both repos driven from one session: link local `@ai-ezio/harness` into ai-whisper; branch in ai-whisper before changes; commits land in each repo separately |

## M5 / M6 boundary

The protocol-native drive path requires ai-whisper's mount layer to **recognize
`ezio`**, so M5 needs a *minimal slice* of what was filed under M6 — the
`AgentType` must include `ezio`, and `whisper collab mount ezio` must work —
purely to run one relay handoff. The boundary:

- **M5:** the adapter + the minimum `AgentType`/mount plumbing to drive **one real
  relay handoff** protocol-natively (the provable vertical slice).
- **M6:** full workflow integration — `whisper skill install --target ezio`,
  running a complete multi-role workflow, relay interception, and polish.

## The contract (grounded in ai-whisper source)

ai-ezio's adapter implements two interfaces from `@ai-whisper/shared`:

- **`CompanionProvider`** — `getIdentity()` (`providerId`/`toolFamily`/
  `providerVersion`), `getCapabilities()`, `getHealthState()`,
  `handleWork(request, context?) → Promise<ProviderReply>`,
  `attachInteractiveSession?(session)`.
- **`InteractiveSessionController`** — `start()`/`stop()`,
  `writeUserInput(data: string)`, `sendLocalMessage(message)`, `resize?()`,
  `onExit(handler)`, `onProviderOutput?(handler: (data) => void)`.
- **`ProviderReply`** = `{ kind, content (min 1), transitionIntent | null }`;
  **`ProviderWorkRequest`** = `{ workItemId, collabId, threadId, requestedAction,
  instruction }`.

`adapter-codex` backs both with a node-pty (typing + scraping). `adapter-ai-ezio`
backs both with the protocol `Session`.

## Components

### 1. ai-ezio `@ai-ezio/harness` (standalone; minimal change)

The `Session` already exposes everything needed (`start`, `submit`,
`submitAndWait`, `onEvent`, `waitForEvent`, `status`, `close`). M5 adds only
small, **workflow-agnostic** ergonomics if needed (e.g. a typed event
subscription helper) — never an ai-whisper dependency. Retire ai-ezio's
placeholder `packages/adapter`.

### 2. ai-whisper `packages/adapter-ai-ezio`

- **`createAiEzioProvider(config) → CompanionProvider`:**
  - `getIdentity()` → `{ providerId: "ezio", toolFamily: "hax", providerVersion }`.
  - `getCapabilities()` → at minimum `supportsDirectPackets: true`,
    `supportsRelayInterception: false`, `supportsLaunchHooks: true`. The exact
    field set is taken from the live `ProviderCapabilities` type at
    implementation (mirroring adapter-codex), not invented here.
  - `getHealthState()` → derived from the `Session` (e.g. `status` / liveness).
  - `handleWork(request, context?)` → build the prompt from the request
    `instruction` (+ artifact handle when present), `submitAndWait`, and map the
    `assistant_turn_finished.content` to `ProviderReply{ kind: "answer", content,
    transitionIntent }`. No output parsing.
  - **`kind` vocabulary (live schema):** `ProviderReply.kind` must be one of the
    live `replyKinds` — `"answer" | "review" | "clarification" | "failure"`
    (`@ai-whisper/shared` `literals.ts`); there is **no** `"success"`/`"error"`
    kind. M5 uses `"answer"` for a normal handback and `"failure"` for an error
    turn (`"review"`/`"clarification"` are driven by `requestedAction` and are
    out of M5's scope). The adapter constructs replies via the live
    `mockProviderReplySchema` so an invalid `kind` cannot be emitted.
  - **Empty-content rule (required):** the protocol allows an empty
    `assistant_turn_finished.content` for a tool-only turn (see
    `docs/protocol.md` M3 decisions), but `ProviderReply.content` is
    `z.string().min(1)`. The adapter must never emit an invalid reply. Mapping:
    - non-empty `content` → `ProviderReply{ kind: "answer", content, … }`.
    - empty `content` **with** an `error` event on the turn → `kind: "failure"`
      with `content` = the error text (non-empty).
    - empty `content` with **no** error (a legitimately silent tool-only turn) →
      `kind: "answer"` with a deterministic non-empty fallback string
      (e.g. `"(no textual response; tool-only turn)"`), so a valid protocol
      event can never yield an invalid `ProviderReply`.
- **`createAiEzioLiveSession(input) → InteractiveSessionController`:**
  - `start()` spawns `ai-ezio --mount-mode` via `@ai-ezio/harness` `Session`
    (the harness resolves the ai-ezio binary).
  - Handoff delivery on the clean path is `session.submit(text)` (driven by the
    mount layer; see Component 3) — not `writeUserInput` byte typing.
  - `onProviderOutput`: render the streamed `assistant_delta` text (and tool
    events) to the handler so the operator sees ai-ezio working.
  - the `idle` event ⇒ the turn is complete (readiness signal).
  - `onExit` from `Session` child exit; `stop()` closes the session.

### 3. ai-whisper mount runtime (`packages/cli/src/runtime`)

The protocol-native drive path — the minimal slice that makes the relay handoff
work for ai-ezio:

- **`AgentType` includes `ezio`** (the minimum widening needed to mount/drive
  it; the full broker-wide widening is M6).
- **`submit-strategy` gains an `ezio` path** that delivers a handoff via
  `session.submit(text)` — no keystream/paste typing.
- **Idle/readiness for ai-ezio comes from the `idle` event**, not output
  quiescence — the mount layer treats the `idle` event as "turn complete."
- **`whisper collab mount ezio`** can mount an ai-ezio session.

## Data flow (one relay handoff)

```
broker ── relay deliver ──► mount layer (ai-ezio path)
   mount layer ── session.submit(handoff) ──fd4──► ai-ezio --mount-mode
   ai-ezio runs the turn; emits assistant_delta* (rendered for the operator)
   ai-ezio ── idle event ──fd3──► mount layer marks the turn complete
   handback = assistant_turn_finished.content (authoritative)
   broker delivers the next handoff
```

No typing, no scraping, no idle-by-quiescence guessing.

## Cross-repo working model

- Both repos are driven from one session. **Link the local `@ai-ezio/harness`
  into ai-whisper** (it is private/unpublished) via a `pnpm`/`file:` link so the
  adapter builds/tests against the real harness.
- **Branch in ai-whisper** before any change (it is the live tool running these
  workflows); commit only after its tests pass.
- Commits land in each repo separately (two repos, two histories). The M5 spec
  and the ai-ezio-side changes are in the ai-ezio repo; the adapter + mount
  changes are in the ai-whisper repo.

## Testing

- **ai-whisper unit/integration (deterministic):** the adapter's `handleWork`
  returns the protocol `content` (no scraping); `createAiEzioLiveSession`
  resolves a handoff on the `idle` event and renders the assistant stream;
  driven against `@ai-ezio/harness` with `HAX_PROVIDER=mock` (and/or the
  harness's fake-engine seam).
- **Empty-content mapping (deterministic):** a tool-only turn with empty
  `assistant_turn_finished.content` yields a reply that **passes
  `mockProviderReplySchema.parse(...)`** — i.e. both `content.length >= 1` *and*
  `kind` ∈ `replyKinds`. Covers the silent-turn fallback (`kind: "answer"`) and
  the error path (`kind: "failure"` when the turn carried an `error` event).
  Asserting only non-empty content is **insufficient** — the test must validate
  the whole reply against the live schema so an invalid `kind` cannot slip
  through.
- **End-to-end (the M5 done-when):** a real `whisper collab mount ezio` plus
  **one relay handoff** delivered via `submit()` and its response captured over
  the protocol — observed, not scraped.
- **ai-ezio:** the harness suite stays green; retiring `packages/adapter` doesn't
  break the workspace build/tests.

## Done when

A single relay handoff runs through ai-ezio **via the protocol**: the mount layer
delivers it with `session.submit()`, ai-ezio runs the turn, the response is
captured from `assistant_turn_finished.content`, and readiness is taken from the
`idle` event — no PTY, no keystream typing, no output scraping.

## Out of scope for M5 (→ M6)

- The full broker-wide `AgentType` widening beyond the minimum to mount/drive.
- `whisper skill install --target ezio`.
- Running a complete multi-role workflow with ai-ezio in a role.
- Relay interception (`@@ai-ezio …`) — declared `false` in M5.
- Non-fd transports; provider-registry external registration.

## Risks

| Risk | Mitigation |
| --- | --- |
| ai-whisper is the live tool running these workflows | Branch before changes; the `ezio` drive path is additive (existing codex/claude paths untouched); test before commit. |
| Cross-repo dependency (`@ai-ezio/harness` unpublished) | Link the local package into ai-whisper; document the link in the plan; CI/publish is a later concern. |
| Mount layer is byte/idle-quiescence oriented | The `ezio` path is a parallel, additive branch keyed on `AgentType`; it sources idle from the explicit event, leaving codex/claude behavior unchanged. |
| `AgentType` minimal-widening leaks into M6 scope | Keep M5's widening to exactly what mount/drive needs for one handoff; the broker-wide widening + workflow run is M6. |
| Operator visibility differs from codex TUI | The adapter renders a clean assistant stream to shared stdout — intentionally simpler than a full TUI, but the operator still sees progress. |
