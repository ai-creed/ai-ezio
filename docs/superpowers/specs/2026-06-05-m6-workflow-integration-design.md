# M6 — Workflow integration: ezio as a first-class ai-whisper agent

- **Status:** approved (brainstorm 2026-06-05)
- **Milestone:** M6 (final) — see `docs/milestones.md`
- **Repos touched:** ai-whisper (all code changes); ai-ezio (this spec only)
- **References:** `docs/milestones.md` (M6), M5 spec
  `docs/superpowers/specs/2026-06-04-m5-adapter-design.md` (M5/M6 boundary,
  "Out of scope for M5 (→ M6)"), `UPSTREAM.md`.

## Goal

Make `ezio` a **first-class ai-whisper agent type** that completes one full
multi-role workflow as a role. M5 landed the adapter + the minimum
`AgentType`/mount slice to drive one relay handoff protocol-natively; M6 widens
that slice to the whole broker/workflow surface, adds `@@ezio` relay targeting
and full relay-interception parity, adds `whisper skill install --target ezio`,
and proves a complete `spec-driven-development` run with ezio in a role.

## Context already in place from M5

- `agentTypes = ["codex", "claude", "ezio"]` literal exists in
  `packages/shared/src/literals.ts`.
- `whisper collab mount ezio` works; a single relay handoff runs through ezio
  over the protocol (broker repos, control service, mount-session-main,
  `providers.ts`, `provider-submit-strategy.ts`, `theme.ts`, `status.ts`, and
  the `packages/adapter-ai-ezio` package are ezio-aware).
- ezio's mount routes through the **shared** `live-session.ts`, whose stdin
  `@@`-directive interception therefore already runs for ezio.

## Decisions (locked in brainstorm)

| Decision | Choice |
| --- | --- |
| Participation model | **2-agent replacement.** ezio substitutes for codex (or claude) in the existing implementer/reviewer pair; still exactly two bound agents per collab. ezio most often replaces codex (hax defaults to the OpenAI subscription, a natural codex drop-in). |
| Widening strategy | **One shared `AgentType`** (`(typeof agentTypes)[number]`) replaces every inline `"codex" \| "claude"` union, so the type system enforces ezio-awareness and prevents future drift. (Milestone says "widen … into a shared `AgentType`".) |
| Role resolution | Stop flipping codex↔claude. `otherAgent` resolves "the other role" from the **two agents actually bound** in the collab (`listSessionBindings`); literal flip remains only as a fallback when bindings are unavailable. |
| Workflow defaults | **Unchanged** (codex/claude). ezio enters a workflow via caller-derived resolution (mounted-as-ezio triggers the run) or explicit `--implementer ezio` / `--reviewer ezio`. No default role binding changes. |
| Relay interception | **Full bidirectional.** ezio becomes a valid `@@ezio` target, and its `supportsRelayInterception` flips to `true` to match the already-wired shared stdin interception. Outbound (`ezio` typing `@@codex`/`@@claude`) already works from M5. |
| Skill install target | `whisper skill install --target ezio` writes to `aiEzioGlobalSkillsDir` = `${XDG_CONFIG_HOME:-$HOME/.config}/ai-ezio/skills` — the directory the engine reads via `HAX_EXTRA_SKILLS_DIR`. |
| Done-when proof | A complete `spec-driven-development` run with ezio as implementer + claude as reviewer, end to end, real stack, mock LLM. |

## Work area 1 — shared `AgentType` widening

**Add** to `packages/shared/src/literals.ts`:

```ts
export type AgentType = (typeof agentTypes)[number]; // "codex" | "claude" | "ezio"
```

### The contract (precise)

`AgentType` is the **single canonical** agent-type union. No active module may
inline-declare an agent-type union — neither the two-agent `"codex" | "claude"`
(in any spacing/order) **nor** the already-widened three-agent
`"codex" | "claude" | "ezio"` (in any order). Every such occurrence imports and
uses `AgentType`. Exactly two exceptions:

1. `packages/shared/src/literals.ts` — the `agentTypes` literal array and the
   `AgentType` definition itself.
2. Sentinel-augmented unions keep their sentinel: write `AgentType | "none"` or
   `AgentType | null` (e.g. dashboard turn-state `owner`/`waiting`), never a
   re-spelled member list.

**Excluded from the sweep:** `packages/cli/deprecated/**` (dead code — left
as-is), `**/dist/**` (build output), and `**/*.test.ts` fixtures that
intentionally exercise a literal.

### Discovery method (do not rely on a hand-enumerated list)

The implementer must **find every occurrence by grep**, not trust the
illustrative list below — a hand list drifts. A **single order-independent
pattern** covers the whole contract: any two adjacent agent-type string literals
joined by `|` is a violation, regardless of order or how many members follow
(`"codex" | "claude"`, the reverse `"claude" | "codex"`, and the leading pair of
any three-member `… | … | …` triple all match). Run, against active source only
(also excluding the canonical definition file):

```sh
rg -n '"(codex|claude|ezio)"\s*\|\s*"(codex|claude|ezio)"' packages \
  --glob '!**/dist/**' --glob '!**/deprecated/**' --glob '!**/*.test.ts' \
  --glob '!**/shared/src/literals.ts'
```

At spec time this matches the remaining two-agent unions (both orders) **and** the
~59 already-widened three-agent triples — all of which must collapse to
`AgentType`.

Convert **all** hits to `AgentType` (member-only declarations) or
`AgentType | <sentinel>` (sentinel-augmented). The illustrative
not-exhaustive surface map:

- **Broker runtime:** `broker-event-bus.ts` (`phase-started`
  implementer/reviewer; `round-started` sender/target); `workflow-registry.ts`
  (`WorkflowDefinition` `defaultImplementer`/`defaultReviewer` types — defaults
  **stay** literal `"claude"`/`"codex"`); `workflow-driver.ts` (`roleBindings`,
  `isAgentBound`, `sender`/`target`).
- **Broker control:** `workflow-control.ts` (`createWorkflow` roleBindings,
  `beginPhaseRun` sender/target); `create-control-service.ts` (`beginPhaseRun`
  sender/target **and** `recordCaptureDiagnostic` `targetProvider` at ~`:1218`,
  which M5 deliberately kept narrow — M6 widens it).
- **Broker repositories:** `workflow-repository.ts` (`roleBindings` value type +
  SQL parse); `dashboard-repository.ts` (`owner`/`waiting` → `AgentType |
  "none"` / `AgentType | null`); `session-repository.ts` (`agent_type`);
  `attach-claim-repository.ts` (`agent_type`);
  `relay-capture-diagnostics-repository.ts` (`targetProvider`, both type and the
  `as` cast — see Work area 3); `relay-handoff-repository.ts` (any re-declared
  triple).
- **CLI:** `runtime/companion-agent-loop.ts` (fallback mapping: `toolFamily ===
  "hax"` → `"ezio"`; codex/claude unchanged); `bin/companion-agent.ts` (accept
  `"ezio"` arg + message); `commands/workflow/start.ts` (see Work area 2);
  `commands/workflow/list.ts` and `commands/workflow/inspect.ts` (any
  re-declared union); `create-cli.ts` — the **`workflow start` action opts**
  (`implementer`/`reviewer`, ~`:429-430`) and the **`skill install` action
  opts** + `.choices` (see Work area 4).

Rule: import `AgentType` from `@ai-whisper/shared`; do not re-declare the union.
A passing typecheck is necessary but **not sufficient** — the drift-prevention
guard (see Testing) is the proof the contract holds.

## Work area 2 — role resolution (replacement model)

`packages/cli/src/commands/workflow/start.ts`:

- `type Agent = AgentType`; `explicitImplementer`/`explicitReviewer`/
  `callerAgent` use `AgentType`.
- `parseCallerAgent` accepts `"ezio"` (use `agentTypes.includes(raw)` rather than
  a literal `===` chain so it tracks the literal).
- Replace the pure `otherAgent(a)` flip with bound-aware resolution. Thread the
  collab's bound agents into `resolveRoleBindings`:
  - `runWorkflowStart` reads `boundAgents` via
    `deps.broker.control.listSessionBindings(deps.collabId)` (filter to
    `bindingState === "bound"`), and passes the `AgentType[]` in.
  - `otherAgent(a, boundAgents)` returns the bound agent ≠ `a`; if `boundAgents`
    lacks a distinct partner, fall back to the literal codex↔claude flip (only
    defined for codex/claude) so existing two-agent behavior and tests are
    preserved.
- Extend `WorkflowStartDeps.broker.control` to declare
  `listSessionBindings(collabId): Array<{ agentType: string; bindingState: string }>`.
- Workflow **defaults remain** codex/claude; the default-only path (no caller,
  no flags) is unchanged except its types widen to `AgentType`.

The same-agent guard (`implementer === reviewer` rejected) is retained.

## Work area 3 — relay interception (full bidirectional)

**Target widening (inbound — others address ezio):**

- `packages/shared/src/relay-host.ts` — `relayTargets = ["codex", "claude",
  "ezio", "pull"]`.
- `packages/cli/src/runtime/relay-directive.ts` — `relayPattern` target
  alternation `codex|claude|ezio|pull`; `unsupportedRelayPrefix` alternation
  `codex|claude|ezio|pull`; error text in `getRelayDirectiveError` updated to
  list `@@ezio …`.
- `packages/broker/src/storage/repositories/relay-capture-diagnostics-repository.ts`
  — `targetProvider` type widens to `AgentType`.

**Capability flip:**

- `packages/adapter-ai-ezio/src/create-ai-ezio-provider.ts` —
  `supportsRelayInterception: true`.

**Outbound (ezio typing `@@codex`/`@@claude`):** already functional via the
shared `live-session.ts` stdin interception + `onRelay` →
`createRelayHandoff(senderAgent: "ezio", …)` (M5 widened the broker side).
Covered by a regression test; no new code.

## Work area 4 — skill install

Two files — the helper **and** the user-visible CLI parser. Widening only the
helper leaves `whisper skill install --target ezio` rejected at the command
boundary, so both are mandatory.

`packages/cli/src/create-cli.ts` (the actual command — the gate users hit):

- The `skill install` `--target` option `.choices([...])` adds `"ezio"`:
  `.choices(["claude", "codex", "ezio", "all"])` (~`:563`). Without this,
  Commander rejects `--target ezio` before `runSkillInstall` is ever called.
- The action opts type widens: `target: "claude" | "codex" | "ezio" | "all"`.

`packages/cli/src/commands/skill/install.ts` (the helper):

- `SkillInstallTarget = "claude" | "codex" | "ezio" | "all"`.
- `VALID_TARGETS` adds `"ezio"`; the `"all"` fan-out becomes
  `["claude", "codex", "ezio"]`.
- `homeForTarget(target)` handles `"ezio"`:

```ts
// ai-ezio engine reads this dir via HAX_EXTRA_SKILLS_DIR (see ai-ezio
// packages/harness/src/skills-dir.ts). Replicated locally to avoid a
// cross-repo import from the ai-whisper CLI.
function aiEzioSkillsDir(home: string, env = process.env): string {
	const base =
		env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME !== ""
			? env.XDG_CONFIG_HOME
			: path.join(home, ".config");
	return path.join(base, "ai-ezio", "skills");
}
```

  For `"claude"`/`"codex"` the existing `~/.claude/skills` / `~/.codex/skills`
  mapping is unchanged.

## Testing

**Drift-prevention guard (the proof for the `AgentType` contract):** a test that
greps the active source tree (excluding `**/dist/**`, `**/deprecated/**`,
`**/*.test.ts`, and `packages/shared/src/literals.ts`) and **fails if any inline
agent-type union remains**. It uses the **single order-independent pattern** from
Work area 1 — `"(codex|claude|ezio)"\s*\|\s*"(codex|claude|ezio)"` — which an
order-specific `"codex" | "claude"` regex would not: that pattern matches both
two-agent orders (`"codex" | "claude"` **and** `"claude" | "codex"`) and the
leading pair of any three-agent triple, so a reversed-order re-declaration cannot
slip through green. The guard asserts **zero hits**. This is what makes the
"every inline union is gone / no future drift" requirement verifiable; a green
typecheck alone does not prove it (a re-declared union typechecks fine).

**Unit (vitest):**

- `AgentType` is exported and equals the `agentTypes` element union (a
  type-level + runtime assertion).
- `resolveRoleBindings`: with `boundAgents = ["ezio", "claude"]` and
  `callerAgent = "ezio"`, yields `implementer: "ezio", reviewer: "claude"`;
  with no bindings it still flips codex→claude (fallback preserved); same-agent
  still rejected.
- `parseCallerAgent("ezio")` → `"ezio"`; unknown → `null`.
- `parseRelayDirective("@@ezio do x")` → target `"ezio"`; `@@ezio[bad]` rejected;
  `getRelayDirectiveError` mentions ezio.
- **Skill install helper:** `runSkillInstall({ target: "ezio" })` writes a skill
  under the ai-ezio dir (fake `XDG_CONFIG_HOME`/`HOME`); `--target all` writes to
  all three (claude, codex, ezio).
- **Skill install CLI boundary** (the gap the helper test misses): the parser
  built by `createCli()` **accepts** `skill install --target ezio` and routes it
  to `runSkillInstall` with `target: "ezio"` — i.e. `"ezio"` is in the
  Commander `.choices`, so the command is not rejected before the helper runs.
- ezio provider `getCapabilities().supportsRelayInterception === true`.

**Integration (real stack, mock LLM):** extend the M5 e2e
(`scripts/ai-ezio-mount-relay-e2e.mjs` pattern) into a full-workflow script:
spawn `whisper collab mount ezio` (+ a claude session), start a
`spec-driven-development` workflow with ezio as implementer and claude as
reviewer, drive it to a terminal completed state, asserting the role bindings
resolved to ezio/claude and that handoffs flowed in both directions. `HAX_PROVIDER=mock`;
only the LLM is mocked.

## Done when

`ezio` is a first-class ai-whisper agent type: every `AgentType` surface accepts
it, `@@ezio` targets and ezio-originated `@@` directives both work,
`whisper skill install --target ezio` installs into the engine-visible dir, and
a complete `spec-driven-development` workflow runs to completion with ezio in a
role — full ai-whisper verification gate (build, typecheck, lint, complete test
suite, the full-workflow e2e) green before merge.

## Out of scope (YAGNI)

- Three simultaneously-mounted agents / arbitrary role counts (replacement
  model only).
- Changing any workflow's default role binding.
- A protocol-native rewrite of operator char-by-char stdin into a mounted ezio
  session (see Risks); workflow-driven submission is the supported path.
- Provider-registry external registration; non-fd transports.
- ai-ezio C-engine changes (the emitter seam is untouched).

## Risks

| Risk | Mitigation |
| --- | --- |
| ai-whisper is the live tool running these workflows | All changes additive and gated on `AgentType`; existing codex/claude paths unchanged; branch before changes; full suite + e2e before commit (M5 discipline). |
| `AgentType` widening cascade breaks unrelated narrow types | Union `AgentType` with sentinels (`"none"`/`null`) rather than replacing them; let `tsc` drive the cascade to completion before committing. |
| `otherAgent` fallback masks a misconfigured collab | When bound agents don't yield a distinct partner, the literal fallback is codex/claude only; a collab with ezio + no second bound agent surfaces via the existing `isAgentBound` driver check, not a silent wrong pairing. |
| Operator typing char-by-char into a mounted ezio session calls `session.submit` per chunk | Known edge; mounted ezio is workflow-driven in practice. Flagged here; not fixed in M6. |
| Skill-dir helper drifts from the ai-ezio source of truth | Helper mirrors `aiEzioGlobalSkillsDir`; a comment points back to the canonical ai-ezio file so a future change is traceable. |
