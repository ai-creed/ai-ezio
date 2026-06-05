# M6 — Workflow integration (ezio as a first-class ai-whisper agent) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ezio` a first-class ai-whisper agent type — every `AgentType`
surface accepts it, `@@ezio` relay targeting + capability parity work,
`whisper skill install --target ezio` installs into the engine-visible dir, and a
complete `spec-driven-development` workflow runs with ezio in a role.

**Architecture:** All code changes land in **ai-whisper** (the `@ai-ezio/harness`
adapter from M5 is untouched; no ai-ezio C-engine changes). The spine is one
shared `AgentType` (`(typeof agentTypes)[number]`) that replaces every inline
`"codex" | "claude"` / `"codex" | "claude" | "ezio"` union; a drift-prevention
guard test proves no inline union survives. Role resolution becomes bound-agent
aware (replacement model: exactly two bound agents, ezio usually replacing
codex). Relay interception gets full bidirectional ezio parity. Skill install is
widened at both the helper and the real CLI parser boundary.

**Tech Stack:** TypeScript, pnpm workspace, vitest, Commander, better-sqlite3,
node-pty (e2e). ai-whisper baseline: tabs, double quotes, semicolons, trailing
commas.

**Spec:** `/Users/vuphan/Dev/ai-ezio/docs/superpowers/specs/2026-06-05-m6-workflow-integration-design.md`

**Working dir for all tasks:** `/Users/vuphan/Dev/ai-whisper` (the build/test
commands below assume this cwd).

**Verification gate (run before the final commit):**
`pnpm -r build && pnpm typecheck && pnpm lint && pnpm test && pnpm run e2e:ai-ezio-mount && pnpm run e2e:ai-ezio-workflow`

---

### Task 0: Branch + baseline green

**Files:** none (git + sanity only)

- [ ] **Step 1: Branch off master**

```sh
cd /Users/vuphan/Dev/ai-whisper
git checkout master && git pull --ff-only
git checkout -b m6-workflow-integration
```

- [ ] **Step 2: Confirm a clean baseline**

Run: `pnpm -r build && pnpm typecheck && pnpm test`
Expected: build + typecheck clean; full vitest suite PASS (this is the M5 green
baseline). If anything fails here, STOP — the tree is not clean to start from.

---

### Task 1: Export the shared `AgentType`

**Files:**
- Modify: `packages/shared/src/literals.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `test/agent-type-shared.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/agent-type-shared.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { agentTypes, type AgentType } from "@ai-whisper/shared";

describe("AgentType (shared canonical union)", () => {
	it("is assignable from every agentTypes member and includes ezio", () => {
		const all: AgentType[] = [...agentTypes];
		expect(all).toContain("ezio");
		expect(all).toEqual(["codex", "claude", "ezio"]);
	});

	it("rejects a non-member at the type level (compile-time guard)", () => {
		// @ts-expect-error "gpt" is not an AgentType
		const bad: AgentType = "gpt";
		expect(bad).toBe("gpt");
	});
});
```

- [ ] **Step 2: Run it — expect a TYPE error (AgentType not exported yet)**

Run: `pnpm vitest run test/agent-type-shared.test.ts`
Expected: FAIL — `AgentType` has no exported member / type import unresolved.

- [ ] **Step 3: Add the type to literals.ts**

In `packages/shared/src/literals.ts`, immediately after the `agentTypes` line
(`export const agentTypes = ["codex", "claude", "ezio"] as const;`) add:

```ts
export type AgentType = (typeof agentTypes)[number];
```

- [ ] **Step 4: Re-export it from the shared barrel**

In `packages/shared/src/index.ts`, the export block from `"./literals.js"`
currently lists `agentTypes,` first. Add a `type AgentType,` entry to that same
block:

```ts
export {
	agentTypes,
	type AgentType,
	artifactCategories,
	// …unchanged…
} from "./literals.js";
```

- [ ] **Step 5: Build shared, run the test**

Run: `pnpm --filter @ai-whisper/shared build && pnpm vitest run test/agent-type-shared.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```sh
git add packages/shared/src/literals.ts packages/shared/src/index.ts test/agent-type-shared.test.ts
git commit -m "M6: export shared AgentType from @ai-whisper/shared"
```

---

### Task 2: Drift-prevention guard (red first)

This test encodes the contract: no active-source module may inline-declare an
agent-type union. It will FAIL now (the tree is full of them) and go green only
after the Task 3 sweep. Keep it red until then — do not skip it.

**Files:**
- Test: `test/agent-type-drift-guard.test.ts` (create)

- [ ] **Step 1: Write the guard**

Create `test/agent-type-drift-guard.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// The contract (see the M6 spec, Work area 1): AgentType is the single canonical
// agent-type union. No active-source module may inline-declare an agent-type
// union — neither the two-agent "codex" | "claude" (any order) nor the
// three-agent "codex" | "claude" | "ezio" (any order). Sentinel forms
// (AgentType | "none" | null | "all") are allowed because the sentinel is not an
// agent literal, so this pattern — two ADJACENT agent literals joined by | —
// never matches them.
const INLINE_AGENT_UNION = /"(codex|claude|ezio)"\s*\|\s*"(codex|claude|ezio)"/;

const PKG_ROOT = path.resolve(__dirname, "..", "packages");

// Excluded: dist (build output), deprecated (dead code), node_modules, *.test.ts
// fixtures, and the canonical definition file itself.
function isExcluded(abs: string): boolean {
	return (
		abs.includes(`${path.sep}dist${path.sep}`) ||
		abs.includes(`${path.sep}deprecated${path.sep}`) ||
		abs.includes(`${path.sep}node_modules${path.sep}`) ||
		abs.endsWith(".test.ts") ||
		abs.endsWith(path.join("shared", "src", "literals.ts"))
	);
}

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const abs = path.join(dir, entry);
		if (statSync(abs).isDirectory()) {
			if (entry === "node_modules" || entry === "dist" || entry === "deprecated") continue;
			out.push(...walk(abs));
		} else if (abs.endsWith(".ts") && !isExcluded(abs)) {
			out.push(abs);
		}
	}
	return out;
}

describe("AgentType drift guard", () => {
	it("no active-source .ts file inline-declares an agent-type union", () => {
		const offenders: string[] = [];
		for (const file of walk(PKG_ROOT)) {
			const text = readFileSync(file, "utf8");
			text.split("\n").forEach((line, i) => {
				if (INLINE_AGENT_UNION.test(line)) {
					offenders.push(`${path.relative(PKG_ROOT, file)}:${i + 1}  ${line.trim()}`);
				}
			});
		}
		expect(offenders, `inline agent-type unions must use AgentType:\n${offenders.join("\n")}`).toEqual([]);
	});
});
```

- [ ] **Step 2: Run it — expect RED**

Run: `pnpm vitest run test/agent-type-drift-guard.test.ts`
Expected: FAIL — the failure message lists ~32 files (broker repos, control,
runtime, cli commands). This confirms the guard detects both orders.

- [ ] **Step 3: Commit the red guard**

```sh
git add test/agent-type-drift-guard.test.ts
git commit -m "M6: add AgentType drift-prevention guard (red until sweep)"
```

---

### Task 3: AgentType widening sweep (make the guard green)

Mechanical type-rename — **no behavior change**. Replace every inline agent-type
union with `AgentType` (member-only) or `AgentType | <sentinel>` (sentinel
forms). Driven by `tsc` + the guard; this task is large by nature (one rename
across the tree) but each file is a trivial substitution.

**Discovery (authoritative — do not trust the list below):**

```sh
# from /Users/vuphan/Dev/ai-whisper
grep -rnE '"(codex|claude|ezio)" *\| *"(codex|claude|ezio)"' packages \
  --include='*.ts' | grep -vE '/(dist|deprecated|node_modules)/' | grep -v '\.test\.ts' \
  | grep -v 'shared/src/literals.ts'
```

**Files (illustrative surface map — convert every hit the grep finds):**
- `packages/broker/src/runtime/broker-event-bus.ts` — `phase-started`
  implementer/reviewer; `round-started` sender/target → `AgentType`.
- `packages/broker/src/runtime/workflow-registry.ts` — `WorkflowDefinition`
  `defaultImplementer`/`defaultReviewer` field **types** → `AgentType`. The
  literal default **values** (`"claude"`/`"codex"`) stay as written.
- `packages/broker/src/runtime/workflow-driver.ts` — `WorkflowRecordLike.roleBindings`
  (`Record<string, AgentType>`); `beginPhaseRun` `sender`/`target` param types;
  `isAgentBound(agent: AgentType)`; the `sender`/`target` local annotations.
- `packages/broker/src/control/workflow-control.ts` — `createWorkflow`
  roleBindings; `beginPhaseRun` sender/target.
- `packages/broker/src/control/create-control-service.ts` — `beginPhaseRun`
  sender/target; **and** `recordCaptureDiagnostic` `targetProvider` (~line 1218,
  M5 kept it narrow — widen to `AgentType`).
- `packages/broker/src/storage/repositories/workflow-repository.ts` —
  `roleBindings` record value type (declaration + the `as` cast in SQL parse).
- `packages/broker/src/storage/repositories/dashboard-repository.ts` —
  `owner: AgentType | "none"`, `waiting: AgentType | null` (both the type and the
  inline annotation ~line 191).
- `packages/broker/src/storage/repositories/session-repository.ts` — `agent_type`.
- `packages/broker/src/storage/repositories/attach-claim-repository.ts` — `agent_type`.
- `packages/broker/src/storage/repositories/relay-capture-diagnostics-repository.ts`
  — `RelayCaptureDiagnosticRecord.targetProvider` type **and** the
  `row.target_provider as "codex" | "claude"` cast → `as AgentType`.
- `packages/broker/src/storage/repositories/relay-handoff-repository.ts` — any
  re-declared agent union the grep flags.
- `packages/cli/src/runtime/companion-agent-loop.ts` — fallback mapping; see
  Step 3 below (logic change, not just a type).
- `packages/cli/src/commands/workflow/list.ts`,
  `packages/cli/src/commands/workflow/inspect.ts` — any re-declared union.
- (CLI `create-cli.ts`, `workflow/start.ts`, `bin/companion-agent.ts`,
  `skill/install.ts` are handled in their dedicated tasks below — but if the grep
  flags them with a pure type union here, convert it now; the behavior tasks
  layer on top.)

Each file: add `import { type AgentType } from "@ai-whisper/shared";` (or extend
an existing import) and substitute. Where a repository imports nothing from
shared yet, add the import.

- [ ] **Step 1: Sweep broker types**

Convert every grep hit under `packages/broker/src` to `AgentType` /
`AgentType | <sentinel>`. Re-run the discovery grep scoped to `packages/broker`
until it returns nothing.

Run: `pnpm --filter @ai-whisper/broker typecheck` (or `pnpm typecheck`)
Expected: no new errors from the broker package.

- [ ] **Step 2: Sweep CLI types (non-behavioral hits)**

Convert remaining grep hits under `packages/cli/src` that are pure type unions
(`list.ts`, `inspect.ts`, and any others), excluding the four files owned by
later tasks if their change is behavioral.

- [ ] **Step 3: Fix the companion-agent-loop fallback mapping**

`packages/cli/src/runtime/companion-agent-loop.ts` currently does:
`input.provider.getIdentity().toolFamily === "codex" ? "codex" : "claude"`.
ezio's `toolFamily` is `"hax"`. Map it explicitly:

```ts
const fallbackAgent: AgentType = (() => {
	const family = input.provider.getIdentity().toolFamily;
	if (family === "codex") return "codex";
	if (family === "hax") return "ezio";
	return "claude";
})();
```

(Use the existing variable name/site; the point is `toolFamily === "hax"` → `"ezio"`.)

- [ ] **Step 4: Typecheck the whole tree, drive remaining errors to zero**

Run: `pnpm typecheck`
Expected: PASS. Fix any cascade (a widened return type feeding a narrow
consumer) by widening the consumer to `AgentType`, never by re-narrowing.

- [ ] **Step 5: Guard green**

Run: `pnpm vitest run test/agent-type-drift-guard.test.ts`
Expected: PASS (zero offenders).

- [ ] **Step 6: Full suite still green (no behavior changed)**

Run: `pnpm test`
Expected: PASS. If a test asserted a narrow type via a fixture, it should be
unaffected (fixtures are excluded from the guard and runtime values are unchanged).

- [ ] **Step 7: Commit**

```sh
git add -A
git commit -m "M6: widen all inline agent unions to shared AgentType (guard green)"
```

---

### Task 4: Bound-agent-aware role resolution

**Files:**
- Modify: `packages/cli/src/commands/workflow/start.ts`
- Test: `test/workflow-role-resolution.test.ts` (extend existing)

- [ ] **Step 1: Write the failing tests**

Append to `test/workflow-role-resolution.test.ts` (import `resolveRoleBindings`
already present there):

```ts
describe("resolveRoleBindings — bound-agent aware (M6)", () => {
	it("ezio caller in an ezio+claude collab → implementer ezio, reviewer claude", () => {
		const r = resolveRoleBindings({
			callerAgent: "ezio",
			boundAgents: ["ezio", "claude"],
		});
		expect(r).toMatchObject({ implementer: "ezio", reviewer: "claude", source: "caller" });
	});

	it("explicit --implementer ezio fills reviewer from the other bound agent", () => {
		const r = resolveRoleBindings({
			explicitImplementer: "ezio",
			boundAgents: ["claude", "ezio"],
		});
		expect(r).toMatchObject({ implementer: "ezio", reviewer: "claude", source: "explicit" });
	});

	it("codex/claude with no bindings still flips (fallback preserved)", () => {
		expect(resolveRoleBindings({ callerAgent: "codex" })).toMatchObject({
			implementer: "codex",
			reviewer: "claude",
		});
	});

	it("ezio with no bindings and no explicit partner throws (ambiguous)", () => {
		expect(() => resolveRoleBindings({ callerAgent: "ezio" })).toThrow(/partner/i);
	});

	it("same agent for both roles is still rejected", () => {
		expect(() =>
			resolveRoleBindings({ explicitImplementer: "ezio", explicitReviewer: "ezio" }),
		).toThrow(/cannot be the same/i);
	});
});
```

- [ ] **Step 2: Run — expect FAIL (boundAgents param unknown / ezio throws not yet)**

Run: `pnpm vitest run test/workflow-role-resolution.test.ts`
Expected: FAIL.

- [ ] **Step 3: Make `otherAgent` bound-aware and widen the types**

In `packages/cli/src/commands/workflow/start.ts`:

Replace the top-of-file agent type + `otherAgent`:

```ts
import { agentTypes, type AgentType } from "@ai-whisper/shared";

type Agent = AgentType;

// Resolve "the other role's agent" from the agents actually bound in the collab.
// Falls back to the literal codex<->claude flip ONLY when bindings don't yield a
// distinct partner — preserving existing two-agent behavior and tests. ezio has
// no literal partner, so an ezio role with no second bound agent is surfaced as
// an explicit error rather than guessed.
function otherAgent(a: Agent, boundAgents?: readonly Agent[]): Agent {
	if (boundAgents) {
		const partner = boundAgents.find((b) => b !== a);
		if (partner) return partner;
	}
	if (a === "claude") return "codex";
	if (a === "codex") return "claude";
	throw new Error(
		`Cannot infer the partner agent for "${a}" without a second bound agent; ` +
			"pass --implementer and --reviewer explicitly.",
	);
}
```

Widen `resolveRoleBindings`'s input to accept `boundAgents` and thread it into
every `otherAgent(...)` call:

```ts
export function resolveRoleBindings(input: {
	explicitImplementer?: Agent | undefined;
	explicitReviewer?: Agent | undefined;
	callerAgent?: Agent | null | undefined;
	boundAgents?: readonly Agent[] | undefined;
	def?: { defaultImplementer?: Agent; defaultReviewer?: Agent } | undefined;
}): { implementer: Agent; reviewer: Agent; source: "explicit" | "caller" | "default"; warning?: string } {
	const { explicitImplementer, explicitReviewer, callerAgent, boundAgents, def } = input;

	if (explicitImplementer || explicitReviewer) {
		const implementer = explicitImplementer ?? (explicitReviewer ? otherAgent(explicitReviewer, boundAgents) : undefined);
		const reviewer = explicitReviewer ?? (explicitImplementer ? otherAgent(explicitImplementer, boundAgents) : undefined);
		if (implementer && reviewer) {
			if (implementer === reviewer) {
				throw new Error("implementer and reviewer cannot be the same agent");
			}
			return { implementer, reviewer, source: "explicit" };
		}
	}

	if (callerAgent) {
		return { implementer: callerAgent, reviewer: otherAgent(callerAgent, boundAgents), source: "caller" };
	}

	const implementer = def?.defaultImplementer;
	const reviewer = def?.defaultReviewer;
	if (!implementer || !reviewer) {
		throw new Error("no default role bindings");
	}
	return {
		implementer,
		reviewer,
		source: "default",
		warning:
			`No triggering agent detected; defaulted to implementer=${implementer} / reviewer=${reviewer}. ` +
			"Pass --implementer / --reviewer to choose explicitly.",
	};
}
```

Update `parseCallerAgent` to accept any agent type:

```ts
export function parseCallerAgent(raw: string | undefined): Agent | null {
	return raw !== undefined && (agentTypes as readonly string[]).includes(raw) ? (raw as Agent) : null;
}
```

- [ ] **Step 4: Thread bound agents from the collab into `runWorkflowStart`**

In `WorkflowStartDeps.broker.control`, add the binding reader and widen
`createWorkflow.roleBindings` to `AgentType`:

```ts
control: {
	createWorkflow: (input: {
		collabId: string;
		workflowType: string;
		name?: string;
		specPath: string;
		roleBindings: { implementer: AgentType; reviewer: AgentType };
		now: string;
	}) => { workflowId: string };
	listSessionBindings: (collabId: string) => Array<{ agentType: string; bindingState: string }>;
};
```

Also widen `implementer?`, `reviewer?`, `callerAgent?` on `WorkflowStartDeps` to
`AgentType`. In `runWorkflowStart`, compute `boundAgents` before calling
`resolveRoleBindings` and pass it in:

```ts
const boundAgents = deps.broker.control
	.listSessionBindings(deps.collabId)
	.filter((b) => b.bindingState === "bound")
	.map((b) => b.agentType)
	.filter((t): t is AgentType => (agentTypes as readonly string[]).includes(t));

resolved = resolveRoleBindings({
	explicitImplementer: deps.implementer,
	explicitReviewer: deps.reviewer,
	callerAgent: deps.callerAgent ?? null,
	boundAgents,
	def,
});
```

- [ ] **Step 5: Run the role-resolution tests + existing caller/defaults tests**

Run: `pnpm vitest run test/workflow-role-resolution.test.ts test/workflow-start-defaults.test.ts test/cli-workflow-start-caller.test.ts`
Expected: PASS. If a pre-existing test constructs `deps.broker.control` without
`listSessionBindings`, add a stub returning `[]` (no bindings → fallback path).

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck`

```sh
git add packages/cli/src/commands/workflow/start.ts test/workflow-role-resolution.test.ts
git commit -m "M6: resolve workflow roles from bound agents (ezio replacement model)"
```

---

### Task 5: companion-agent binary accepts ezio

**Files:**
- Modify: `packages/cli/src/bin/companion-agent.ts`
- Test: `test/companion-agent-arg.test.ts` (create, if the arg parser is testable) — otherwise fold into a typecheck-only change and skip the unit test (see Step 1).

- [ ] **Step 1: Inspect the validation site**

Read `packages/cli/src/bin/companion-agent.ts:25-32`. It throws unless the arg is
`"codex"` or `"claude"`. If the parse is inline in `main()` (not exported), a unit
test is impractical; widen it and rely on the e2e + typecheck. If a helper is
exported, write the failing test first.

- [ ] **Step 2: Widen the guard**

Replace the validation with an `agentTypes` membership check:

```ts
import { agentTypes } from "@ai-whisper/shared";
// …
if (!(agentTypes as readonly string[]).includes(agentArg)) {
	throw new Error(
		"companion-agent requires a target argument: codex, claude, or ezio",
	);
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```sh
# add the test file only if you created one in Step 1
git add packages/cli/src/bin/companion-agent.ts
git commit -m "M6: companion-agent binary accepts the ezio target"
```

---

### Task 6: Relay `@@ezio` targeting (inbound)

**Files:**
- Modify: `packages/shared/src/relay-host.ts`
- Modify: `packages/cli/src/runtime/relay-directive.ts`
- Test: `test/relay-directive.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `test/relay-directive.test.ts`:

```ts
describe("relay directive — @@ezio (M6)", () => {
	it("parses @@ezio with an instruction", () => {
		const d = parseRelayDirective("@@ezio summarize the spec");
		expect(d).toMatchObject({ target: "ezio", instruction: "summarize the spec", forceNewThread: false });
	});

	it("parses @@ezio[new] force-new-thread", () => {
		const d = parseRelayDirective("@@ezio[new] do the thing");
		expect(d).toMatchObject({ target: "ezio", forceNewThread: true });
	});

	it("rejects @@ezio with no instruction", () => {
		expect(parseRelayDirective("@@ezio")).toBeNull();
	});

	it("rejects unsupported @@ezio[bad] bracket", () => {
		expect(parseRelayDirective("@@ezio[bad] x")).toBeNull();
		expect(getRelayDirectiveError("@@ezio[bad] x")).toMatch(/ezio/);
	});
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm vitest run test/relay-directive.test.ts`
Expected: FAIL (ezio not in the pattern).

- [ ] **Step 3: Add ezio to relay targets + parser**

`packages/shared/src/relay-host.ts`:

```ts
export const relayTargets = ["codex", "claude", "ezio", "pull"] as const;
```

`packages/cli/src/runtime/relay-directive.ts` — extend both regexes and the
error text:

```ts
const relayPattern =
	/^@@(?<target>codex|claude|ezio|pull)(?<force>\[new\])?\s*(?<instruction>.*)$/;
const unsupportedRelayPrefix = /^@@(?:codex|claude|ezio|pull)\[(?!new\])/;
```

and in `getRelayDirectiveError`:

```ts
return "[ai-whisper] Unsupported relay syntax. Phase 6 supports only @@codex ..., @@claude ..., @@ezio ..., and [new].";
```

- [ ] **Step 4: Build shared, run tests**

Run: `pnpm --filter @ai-whisper/shared build && pnpm vitest run test/relay-directive.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/shared/src/relay-host.ts packages/cli/src/runtime/relay-directive.ts test/relay-directive.test.ts
git commit -m "M6: recognize @@ezio relay target (inbound directive parity)"
```

---

### Task 7: ezio provider relay-interception capability → true

**Files:**
- Modify: `packages/adapter-ai-ezio/src/create-ai-ezio-provider.ts`
- Test: `test/adapter-ai-ezio-provider.test.ts` (update the existing assertion)

- [ ] **Step 1: Flip the existing test to expect true**

In `test/adapter-ai-ezio-provider.test.ts`, change the capability assertion
(currently `expect(caps.supportsRelayInterception).toBe(false);` at line 55) to:

```ts
expect(caps.supportsRelayInterception).toBe(true);
```

and update that test's title to "…with direct packets, **relay interception**,
and extensions".

- [ ] **Step 2: Run — expect FAIL (provider still declares false)**

Run: `pnpm vitest run test/adapter-ai-ezio-provider.test.ts`
Expected: FAIL.

- [ ] **Step 3: Flip the capability**

In `packages/adapter-ai-ezio/src/create-ai-ezio-provider.ts`, set
`supportsRelayInterception: true` and update the adjacent comment to note ezio's
mount routes through the shared `live-session.ts` stdin interception (already
wired in M5), so the declaration now matches reality.

- [ ] **Step 4: Build adapter, run tests**

Run: `pnpm --filter @ai-whisper/adapter-ai-ezio build && pnpm vitest run test/adapter-ai-ezio-provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/adapter-ai-ezio/src/create-ai-ezio-provider.ts test/adapter-ai-ezio-provider.test.ts
git commit -m "M6: ezio provider declares supportsRelayInterception true (parity)"
```

---

### Task 8: Outbound `@@` from ezio — regression test only

The shared `live-session.ts` already intercepts operator stdin `@@` directives
for any mounted target (M5 wired ezio through it), and `onRelay` creates a
handoff with `senderAgent = input.target`. This task pins that ezio-originated
directives produce an ezio-sender handoff — **no new production code**.

**Files:**
- Test: `test/ai-ezio-outbound-relay.test.ts` (create)

- [ ] **Step 1: Write the test**

Model it on the existing relay-integration test
(`test/ai-ezio-relay-integration.test.ts`): construct the `onRelay` path used by
`mount-session-main.ts` (or call `createRelayHandoff` through a fake broker the
way live-session does) with `input.target = "ezio"` and a parsed `@@claude …`
directive, and assert the recorded handoff has `senderAgent: "ezio",
targetAgent: "claude"`. Reuse the fake-broker helper pattern already in
`test/ai-ezio-relay-integration.test.ts`. If the `onRelay` closure is not
exported, assert at the unit boundary that `parseRelayDirective("@@claude x")`
yields `target: "claude"` and document (code comment) that delivery uses the
shared path proven by the Task 11 e2e.

- [ ] **Step 2: Run + commit**

Run: `pnpm vitest run test/ai-ezio-outbound-relay.test.ts`
Expected: PASS.

```sh
git add test/ai-ezio-outbound-relay.test.ts
git commit -m "M6: regression — ezio-originated @@ directive yields ezio-sender handoff"
```

---

### Task 9: Skill install — helper supports ezio

**Files:**
- Modify: `packages/cli/src/commands/skill/install.ts`
- Test: `test/skill-install.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `test/skill-install.test.ts` (it already exercises `runSkillInstall`
with a `fakeHome` + `bundledSkillsDir`; reuse those helpers/fixtures):

```ts
describe("runSkillInstall — ezio target (M6)", () => {
	it("installs into ${XDG_CONFIG_HOME or ~/.config}/ai-ezio/skills", async () => {
		const prevXdg = process.env.XDG_CONFIG_HOME;
		delete process.env.XDG_CONFIG_HOME; // force the $HOME/.config fallback for determinism
		try {
			const home = await mkdtemp(path.join(tmpdir(), "ezio-skill-"));
			const res = await runSkillInstall({
				target: "ezio",
				fakeHome: home,
				bundledSkillsDir: FIXTURE_SKILLS_DIR, // the same fixture the existing tests use
			});
			expect(res.installedAt.every((p) => p.includes(path.join(".config", "ai-ezio", "skills")))).toBe(true);
		} finally {
			if (prevXdg !== undefined) process.env.XDG_CONFIG_HOME = prevXdg;
		}
	});

	it("--target all installs to claude, codex, AND ezio", async () => {
		const home = await mkdtemp(path.join(tmpdir(), "all-skill-"));
		delete process.env.XDG_CONFIG_HOME;
		const res = await runSkillInstall({ target: "all", fakeHome: home, bundledSkillsDir: FIXTURE_SKILLS_DIR });
		const joined = res.installedAt.join("\n");
		expect(joined).toMatch(/[/\\]\.claude[/\\]skills/);
		expect(joined).toMatch(/[/\\]\.codex[/\\]skills/);
		expect(joined).toMatch(/ai-ezio[/\\]skills/);
	});
});
```

(Use the existing test file's import names for `mkdtemp`, `tmpdir`, `path`, and
the bundled-skills fixture constant; match them rather than introducing new ones.)

- [ ] **Step 2: Run — expect FAIL**

Run: `pnpm vitest run test/skill-install.test.ts`
Expected: FAIL (ezio rejected by `VALID_TARGETS`; `homeForTarget` ternary routes
ezio into `.codex`).

- [ ] **Step 3: Widen the helper**

In `packages/cli/src/commands/skill/install.ts`:

```ts
import { type AgentType } from "@ai-whisper/shared";

export type SkillInstallTarget = AgentType | "all";
```

Replace `homeForTarget`:

```ts
function homeForTarget(target: AgentType, fakeHome?: string): string {
	const home = fakeHome ?? process.env.HOME ?? process.env.USERPROFILE ?? "";
	if (!home) throw new Error("Could not determine $HOME for skill install destination");
	if (target === "ezio") {
		// Mirrors ai-ezio's aiEzioGlobalSkillsDir (ai-ezio
		// packages/harness/src/skills-dir.ts): ${XDG_CONFIG_HOME:-$HOME/.config}/ai-ezio/skills,
		// the dir the engine reads via HAX_EXTRA_SKILLS_DIR. Replicated locally to
		// avoid a cross-repo import from the ai-whisper CLI.
		const xdg = process.env.XDG_CONFIG_HOME;
		const base = xdg && xdg !== "" ? xdg : path.join(home, ".config");
		return path.join(base, "ai-ezio", "skills");
	}
	return path.join(home, target === "claude" ? ".claude" : ".codex", "skills");
}
```

Widen `VALID_TARGETS`, its error message, and the `all` fan-out:

```ts
const VALID_TARGETS: ReadonlySet<SkillInstallTarget> = new Set(["claude", "codex", "ezio", "all"]);
// …error message…: "Expected one of: claude, codex, ezio, all."
const targets: AgentType[] =
	input.target === "all" ? ["claude", "codex", "ezio"] : [input.target];
```

- [ ] **Step 4: Build cli, run tests**

Run: `pnpm --filter @ai-whisper/cli build && pnpm vitest run test/skill-install.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm the guard is still green**

Run: `pnpm vitest run test/agent-type-drift-guard.test.ts`
Expected: PASS (`SkillInstallTarget = AgentType | "all"` has no inline agent
union; `VALID_TARGETS`/fan-out are comma-separated arrays, not `|`-joined).

- [ ] **Step 6: Commit**

```sh
git add packages/cli/src/commands/skill/install.ts test/skill-install.test.ts
git commit -m "M6: skill install helper installs --target ezio to the engine-visible dir"
```

---

### Task 10: Skill install — CLI parser boundary

**Files:**
- Modify: `packages/cli/src/create-cli.ts`
- Test: `test/skill-install-cli.test.ts` (create)

- [ ] **Step 1: Write the failing CLI-boundary test**

Create `test/skill-install-cli.test.ts`. Build the program via `createCli` and
assert the parser ACCEPTS `--target ezio` (i.e. ezio is in `.choices`). Mirror
the deps-injection style used by existing `create-cli` tests; if `runSkillInstall`
is not injectable, intercept it via a `vi.mock` of the install module so the test
asserts routing without touching the filesystem:

```ts
import { describe, expect, it, vi } from "vitest";

const runSkillInstall = vi.fn(async () => ({ installedAt: [] as string[] }));
vi.mock("../packages/cli/src/commands/skill/install.ts", () => ({ runSkillInstall }));

import { createCli } from "../packages/cli/src/create-cli.ts";

describe("whisper skill install --target ezio (CLI boundary)", () => {
	it("Commander accepts ezio and routes it to runSkillInstall", async () => {
		const cli = createCli(/* existing test deps shape */);
		await cli.parseAsync(["node", "whisper", "skill", "install", "--target", "ezio"]);
		expect(runSkillInstall).toHaveBeenCalledWith(expect.objectContaining({ target: "ezio" }));
	});

	it("rejects an unknown target (choices still enforced)", async () => {
		const cli = createCli(/* … */);
		await expect(
			cli.parseAsync(["node", "whisper", "skill", "install", "--target", "gpt"]),
		).rejects.toBeTruthy();
	});
});
```

(Match the real `createCli` signature/deps from an existing create-cli test in
`test/`. If none injects deps, construct the minimal deps the skill-install
branch needs — it does not touch the broker, so a thin stub suffices.)

- [ ] **Step 2: Run — expect FAIL (ezio not in choices)**

Run: `pnpm vitest run test/skill-install-cli.test.ts`
Expected: FAIL — Commander rejects `gpt` AND `ezio` (ezio not yet allowed), so
the accept-case fails.

- [ ] **Step 3: Add ezio to the parser**

In `packages/cli/src/create-cli.ts`, the `skill install` command:

```ts
import { type SkillInstallTarget } from "./commands/skill/install.js";
// …
.addOption(
	new Option("--target <target>", "Agent install target")
		.choices(["claude", "codex", "ezio", "all"])
		.default("all"),
)
// …
.action(
	async (opts: { target: SkillInstallTarget; force?: boolean }) => {
		// unchanged body
	},
);
```

Also widen the `workflow start` action opts in the same file from
`implementer?: "claude" | "codex"` / `reviewer?: "claude" | "codex"` to
`implementer?: AgentType` / `reviewer?: AgentType` (import `AgentType`), and
update the two `--implementer`/`--reviewer` option help strings to read
"claude, codex, or ezio".

- [ ] **Step 4: Build cli, run tests + guard**

Run: `pnpm --filter @ai-whisper/cli build && pnpm vitest run test/skill-install-cli.test.ts test/agent-type-drift-guard.test.ts`
Expected: PASS for both.

- [ ] **Step 5: Commit**

```sh
git add packages/cli/src/create-cli.ts test/skill-install-cli.test.ts
git commit -m "M6: accept --target ezio at the skill-install CLI boundary"
```

---

### Task 11: Full-workflow e2e (real stack, mock LLM)

Proves the M6 done-when: a complete `spec-driven-development` run with ezio as
implementer and claude as reviewer over the real broker/protocol, only the LLM
mocked. Models the M5 e2e (`scripts/ai-ezio-mount-relay-e2e.mjs`).

**Files:**
- Create: `scripts/ai-ezio-full-workflow-e2e.mjs`
- Modify: `package.json` (add `e2e:ai-ezio-workflow` script)

- [ ] **Step 1: Add the npm script**

In `package.json` scripts, after `"e2e:ai-ezio-mount"`, add:

```json
"e2e:ai-ezio-workflow": "node scripts/ai-ezio-full-workflow-e2e.mjs",
```

- [ ] **Step 2: Write the e2e driver**

Create `scripts/ai-ezio-full-workflow-e2e.mjs`. Reuse the M5 script's scaffolding
(temp state root = workspace, `AI_WHISPER_STATE_ROOT`, `HAX_PROVIDER=mock`,
`AI_EZIO_HAX_BIN`, the observer `createBrokerRuntime` on the daemon's port). The
new shape:

1. Spawn `whisper collab mount ezio` in a pty (as in M5).
2. Spawn `whisper collab mount claude` in a second pty (claude reviewer). If the
   environment lacks a real claude CLI, fall back to mounting a second mock-backed
   agent the same way ezio is mounted — the assertion target is the role
   resolution + handoff flow, not claude's content; document this in a comment.
3. Wait until BOTH `ezio` and `claude` bindings report `bound` via
   `broker.control.listSessionBindings(collabId)`.
4. Write a tiny spec file under the temp workspace (a 3-line markdown plan is
   enough for the mock provider).
5. Start the workflow with explicit roles:
   `sh(["workflow", "start", "--type=spec-driven-development", "--spec", specPath, "--implementer", "ezio", "--reviewer", "claude"])`.
   Assert stdout matches `Workflow started: wf_...` and capture the id.
6. Assert the persisted role bindings resolved to ezio/claude:
   `broker.control.getWorkflow(workflowId).roleBindings` →
   `{ implementer: "ezio", reviewer: "claude" }`.
7. Drive to a terminal state: poll `broker.control.getWorkflow(workflowId).status`
   (and/or `listRelayHandoffs`) for up to ~90s. Assert at least one handoff with
   `senderAgent === "ezio"` AND one with `targetAgent === "ezio"` were recorded
   (both directions), and that the workflow reaches a non-error terminal/progress
   state (`running` past round 1, `done`, or a clean phase transition — not
   `halted`). On `halted`, FAIL and print `haltReason` + the last ~2500 chars of
   the mount logs.
8. `cleanup()` (kill ptys, `collab stop`, rm temp) on every exit path; `exit(0)`
   on success with an `OK:` line, `exit(1)` with a `FAIL:` line + log tail.

Follow the M5 script's helpers verbatim (`sh`, `sleep`, `now`, `cleanup`,
deadline loops) so behavior and timeouts match the proven pattern.

- [ ] **Step 3: Build, then run the e2e**

Run: `pnpm -r build && pnpm run e2e:ai-ezio-workflow`
Expected: prints `OK:` lines and exits 0. If it halts on a missing claude CLI,
apply the Step-2 fallback (second mock-backed mount) and re-run.

- [ ] **Step 4: Commit**

```sh
git add scripts/ai-ezio-full-workflow-e2e.mjs package.json
git commit -m "M6: full spec-driven-development e2e with ezio implementer + claude reviewer"
```

---

### Task 12: Full verification gate + finish

**Files:** none (verification + branch completion)

- [ ] **Step 1: Run the complete gate**

Run (from `/Users/vuphan/Dev/ai-whisper`):

```sh
pnpm -r build && pnpm typecheck && pnpm lint && pnpm test && pnpm run e2e:ai-ezio-mount && pnpm run e2e:ai-ezio-workflow
```

Expected: build clean; typecheck clean; **eslint clean** (the enforced style
gate — Prettier `--check` repo-wide drift is pre-existing and NOT a gate); full
vitest suite PASS including the drift guard; both e2e scripts exit 0.

- [ ] **Step 2: Fix any lint findings inline**

If eslint flags require-await / unbound-method on new sync methods or vitest mock
assertions, resolve with a scoped `// eslint-disable-next-line <rule> -- <reason>`
exactly as the M5 code did. Re-run `pnpm lint` to confirm clean.

- [ ] **Step 3: Finish the development branch**

Announce: "I'm using the finishing-a-development-branch skill to complete this
work." Then follow superpowers:finishing-a-development-branch — present the
verified-green summary and the merge options (the M5 precedent was: verify on the
branch, then `git checkout master && git merge --ff-only m6-workflow-integration`,
then push). Do not merge to master without the gate fully green.

---

## Edge cases & test coverage summary

- **ezio with no second bound agent** → `otherAgent` throws an actionable error
  (Task 4) rather than silently pairing wrong.
- **Reversed-order inline unions** (`"claude" | "codex"`) → caught by the
  order-independent guard regex (Task 2/3).
- **Sentinel unions** (`AgentType | "none" | null | "all"`) → guard-safe by
  construction; covered implicitly by the green guard after Task 3/9.
- **Skill install bypassing the CLI** (programmatic caller passing a bad target)
  → `VALID_TARGETS` runtime check still throws (Task 9).
- **`--target ezio` rejected at the parser** (the gap a helper-only test misses)
  → explicit CLI-boundary test (Task 10).
- **ezio `toolFamily` is `"hax"`** (not `"ezio"`) → companion-agent-loop fallback
  maps `"hax"` → `"ezio"` (Task 3, Step 3).
- **Missing claude CLI in CI** → e2e falls back to a second mock-backed mount,
  documented, since the assertion target is role/handoff flow (Task 11).
- **Workflow halts** → e2e fails loudly with `haltReason` + log tail (Task 11).

## Out of scope (per spec — do not implement)

Three simultaneously-mounted agents / arbitrary role counts; changing any
workflow's default role binding; a protocol-native rewrite of operator
char-by-char stdin into a mounted ezio session; provider-registry external
registration; non-fd transports; any ai-ezio C-engine change.
