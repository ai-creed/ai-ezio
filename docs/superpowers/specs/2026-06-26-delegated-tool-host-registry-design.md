# Delegated-tool host registry — consolidate host wiring across run modes

- **Status:** approved (brainstorm 2026-06-26)
- **Scope:** Introduce a single `DelegatedToolProvider` interface + a
  `DelegatedToolRegistry` that owns the registration, routing, and lifecycle of
  every host-delegated-tool provider (the MCP host, the subagent host, and any
  future host). Both Session creators — the ezio standalone CLI and ai-whisper's
  mounted adapter — consume one registry instead of hand-wiring each host. This
  removes the per-host, per-creator, cross-repo duplication and makes the
  multi-provider routing fix structural rather than a per-host patch.
- **Repos touched:** **ezio** (this repo) — new harness interface + registry, a
  new `@ai-ezio/session-hosts` package, refactors of `@ai-ezio/mcp-host` and
  `@ai-ezio/subagent` to the provider interface, and the standalone-CLI migration.
  **ai-whisper** (downstream) — the `adapter-ai-ezio` package adopts the registry
  (which also finally enables the `subagent` tool in mounted mode). Delivered as
  two PRs (ezio first, ai-whisper second).
- **References:** `docs/architecture.md`, `docs/protocol.md` (§ M9 host-delegated
  tools), `docs/superpowers/specs/2026-06-26-ezio-subagent-v0-design.md`,
  `docs/superpowers/specs/2026-06-08-m9-mcp-host-ecosystem-integration-design.md`,
  `packages/mcp-host/src/host.ts`, `packages/subagent/src/host.ts`,
  `packages/cli/src/repl/standalone-runtime.ts`,
  ai-whisper `packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts`.

## Why

Host-delegated tools (the M9 seam: hax advertises a tool, emits
`tool_call_requested`, blocks on the control fd for a `tool_result`) are a generic
mechanism. Today there are two providers of such tools — the **MCP host** and the
**subagent host** — and the number will grow as the harness gains capabilities.

The problem is that **each provider is hand-wired into each Session creator**, and
there are two creators in two repos:

- ezio standalone (`packages/cli/src/repl/standalone-runtime.ts`) — `runOneShot`,
  `runStandalone`, and the resume re-wire.
- ai-whisper mounted (`adapter-ai-ezio/src/create-ai-ezio-live-session.ts`).

Each creator independently repeats the same sequence for **every** host: construct
it, fan `handleEvent` into the `onEvent` tee, `start()` it after `session.start()`
and before the first submit, re-register on resume, `stop()` on teardown, and set
the `AI_EZIO_DELEGATED_TIMEOUT` backstop. Adding the subagent host meant editing
three sites in the standalone CLI; enabling it in mounted mode means editing the
ai-whisper adapter the same way, in a separate repo that lags. The wiring is
**O(hosts × creators)** and crosses a repo boundary.

The duplication also has a correctness tail. Because each provider independently
reacted to **every** event, the MCP host replied `"unknown tool: subagent"` to the
subagent's `tool_call_requested` and — replying synchronously — won the race
against the subagent host's async reply, so the parent never received the
subagent's answer. That was fixed by a per-provider patch (`mcp-host` commit
`7642039`: "stay silent on non-owned delegated tool calls"). The patch works but
the smell remains: every **future** host must remember to self-filter, or it
re-introduces the race.

This spec consolidates both concerns: one registry owns construction wiring,
single registration, name-based routing, and lifecycle for all providers. Adding a
host becomes "add one provider to the factory"; both run modes pick it up with no
creator edits, and a provider can never see a call it does not own.

### Constraint: ai-whisper must not hard-depend on ezio

ai-whisper users may prefer Claude/Codex/another CLI and must be able to run
ai-whisper without installing ezio at all. Today only `adapter-ai-ezio` imports
`@ai-ezio/*` (verified: no other ai-whisper package does). This design keeps the
registry **entirely inside ezio**; ai-whisper consumes it **only through the
already-ezio-coupled adapter**, so no non-adapter ai-whisper code gains an ezio
dependency. (Making the adapter itself lazy-loaded with `optional`/`peer` ezio
deps — so the whisper install graph is ezio-free — is a pre-existing packaging gap
and an explicit non-goal here; see Out of scope.)

## Decisions (locked at brainstorm)

| Decision | Choice | Why |
| --- | --- | --- |
| Consolidation unit | A `DelegatedToolProvider` interface + a `DelegatedToolRegistry` | One seam for all delegated-tool hosts; the extension point for future hosts. |
| Registry depth | **Structural routing**: registry owns single merged registration + name→owner routing + lifecycle broadcast | Makes the multi-provider race impossible by construction; the `7642039` self-filter patch is subsumed/removed. |
| Interface home | `@ai-ezio/harness` | Cycle-free (needs only the interface + Session); a generic engine concept that fits harness's charter. |
| Factory home | New package `@ai-ezio/session-hosts` | The factory imports the concrete hosts, so it must sit above them; a dedicated, clearly-named extension-point home. |
| Provider↔Session coupling | Providers never touch the Session; the registry owns all Session interaction (register + reply via an injected `reply` callback) | Clean separation; providers are pure delegated-tool logic. |
| Cross-repo scope | One design, two PRs — ezio first, ai-whisper downstream | ai-whisper is downstream and needs a rebuild; phasing keeps each PR self-contained and green. |
| Adapter packaging (ezio-optional) | **Out of scope** (follow-up) | Pre-existing; orthogonal to the registry. |

## Architecture & layering

Placement is forced by the no-cycle rule: the interface must sit **below** both
hosts (so they can `implements` it); the factory must sit **above** both (so it can
construct them).

```text
@ai-ezio/protocol        leaf — DelegatedToolDef, ToolCallRequestedEvent, ProtocolEvent (existing)
@ai-ezio/harness         + DelegatedToolProvider, DelegatedReply, DelegatedToolRegistry   <-- NEW
@ai-ezio/mcp-host        McpHost implements DelegatedToolProvider (keeps callHostTool/hostToolNames)
@ai-ezio/subagent        SubagentHost implements DelegatedToolProvider
@ai-ezio/session-hosts   NEW pkg — loadSessionHosts({mode,cwd,report}) -> { registry, mcpHost }
@ai-creed/ai-ezio (cli)  consume { registry, mcpHost }
ai-whisper adapter-ai-ezio   consume { registry, mcpHost } (new dep on session-hosts)
```

The registry depends only on the interface + the protocol/Session types — it never
imports a concrete host, so it lives cleanly in harness. The factory is the only
new place that imports `mcp-host` and `subagent`.

## The interface + registry (harness)

New file `packages/harness/src/delegated-registry.ts`, exported from the harness
index.

```ts
import type { DelegatedToolDef } from "@ai-ezio/protocol";
import type { ProtocolEvent, ToolCallRequestedEvent } from "@ai-ezio/protocol";
import type { Session } from "./session.js";

/** How a provider returns a delegated tool's result. Injected by the registry so
 * providers never hold the Session themselves. */
export type DelegatedReply = (callId: string, output: string, status: "ok" | "error") => void;

/** A source of host-delegated tools (the MCP host, the subagent host, …). The
 * registry owns registration, routing, and lifecycle; a provider supplies only its
 * tool defs and the per-call/lifecycle behavior. */
export interface DelegatedToolProvider {
	/** Stable id for diagnostics + duplicate-name messages (e.g. "mcp", "subagent"). */
	readonly id: string;
	/** Async setup before tools() is collected (e.g. MCP server connect). No Session
	 * needed — the provider does not register or reply itself. Optional. */
	init?(): void | Promise<void>;
	/** Tool defs this provider advertises. Collected once by the registry, after
	 * init(). Empty array = nothing advertised (e.g. subagent with no profiles). */
	tools(): DelegatedToolDef[];
	/** Service a delegated call the registry routed here — only ever this provider's
	 * own tool names. Reply via `reply` (may be async; the registry does not await
	 * it before returning, so this can run long, e.g. a subagent dispatch). */
	handleToolCall(event: ToolCallRequestedEvent, reply: DelegatedReply): void | Promise<void>;
	/** Observe non-tool-call lifecycle events (idle/error/…). Optional — the subagent
	 * host uses it to cancel an in-flight child when the parent turn ends. */
	observe?(event: ProtocolEvent): void;
	/** Teardown (stop MCP servers, cancel in-flight subagent, …). Optional. */
	stop?(): void | Promise<void>;
}

/** Minimal Session surface the registry needs. */
export type RegistrySession = Pick<Session, "registerDelegatedTools" | "sendToolResult">;

export class DelegatedToolRegistry {
	private readonly owner = new Map<string, DelegatedToolProvider>();
	private session?: RegistrySession;

	constructor(
		private readonly providers: DelegatedToolProvider[],
		private readonly warn: (msg: string) => void = (m) => process.stderr.write(`${m}\n`),
	) {}

	/** Initialize every provider, collect their tool defs into ONE merged
	 * registration, and build the name→owner routing map. Call after session.start()
	 * and before the first submit (and again on resume — the map is rebuilt). */
	async start(session: RegistrySession): Promise<void> {
		this.session = session;
		this.owner.clear();
		for (const p of this.providers) await p.init?.();
		const defs: DelegatedToolDef[] = [];
		for (const p of this.providers) {
			for (const def of p.tools()) {
				if (this.owner.has(def.name)) {
					this.warn(`delegated tool "${def.name}" registered by "${p.id}" collides with "${this.owner.get(def.name)!.id}" — keeping the first`);
					continue;
				}
				this.owner.set(def.name, p);
				defs.push(def);
			}
		}
		if (defs.length) session.registerDelegatedTools(defs);
	}

	/** Wire this into the creator's onEvent tee (one entry). Routes a
	 * tool_call_requested to its owning provider; broadcasts everything else to
	 * observers. Non-blocking: a long handleToolCall runs detached. */
	handleEvent(event: ProtocolEvent): void {
		if (event.type === "tool_call_requested") {
			const p = this.owner.get(event.name);
			if (!p) return; // not a tool we registered — hax never emits this; ignore
			const reply: DelegatedReply = (callId, output, status) =>
				this.session?.sendToolResult(callId, output, status);
			void p.handleToolCall(event, reply);
			return;
		}
		for (const p of this.providers) p.observe?.(event);
	}

	async stop(): Promise<void> {
		for (const p of this.providers) await p.stop?.();
	}
}
```

Routing/error semantics:

- **Owned call** → the owner's `handleToolCall` replies via the injected `reply`.
- **Unknown tool name** → ignored. The owner map is built from exactly the defs the
  registry registered, so an unowned-but-registered name cannot occur; a name that
  was never registered cannot be emitted by hax. (A never-replied call is bounded by
  hax's `AI_EZIO_DELEGATED_TIMEOUT` backstop.)
- **Duplicate tool name across providers** → warn (with both ids) and keep the
  first; the duplicate def is neither registered nor routed.
- **Lifecycle events** (idle/error/ready/…) → broadcast to every `observe?`; the
  subagent host cancels its in-flight child on idle/error there.

This makes the multi-provider race impossible by construction, so the `mcp-host`
`7642039` "silent on non-owned" guard is **removed** as part of the mcp-host
refactor below.

## Host refactor — McpHost and SubagentHost become providers

### McpHost (`@ai-ezio/mcp-host`)

`implements DelegatedToolProvider` with `id = "mcp"`:

- `init()` — connect the configured stdio MCP servers, list their tools, build the
  namespaced route map. (This is the connect half of today's `start()`.)
- `tools()` — return the advertised (non-host-private) namespaced `DelegatedToolDef`s
  gathered during `init()`.
- `handleToolCall(event, reply)` — the body of today's `handleEvent` minus the
  unknown-tool branch: apply policy (allow/deny/confirm), inject cwd, call the owning
  MCP server with the per-call timeout, and `reply(callId, output, status)`. The
  `7642039` `if (!route) return` cross-provider guard is **deleted** (the registry
  guarantees only owned calls arrive).
- `observe` — not implemented (MCP host has no lifecycle reaction).
- `stop()` — disconnect servers (today's `stop()`).

**Unchanged and still public:** `callHostTool(name, args)` and `hostToolNames()` —
the **host-private** API the session recorder and the compactor call directly (e.g.
`cortex__capture_session`, rehydration). These are *not* delegated tools and are not
part of the provider interface; consumers keep a direct `McpHost` reference (the
factory returns it).

### SubagentHost (`@ai-ezio/subagent`)

`implements DelegatedToolProvider` with `id = "subagent"`:

- `init()` — no-op (the catalog is built at construction from config + the codex
  probe).
- `tools()` — `[subagentToolDef(catalog)]` when the catalog is non-empty, else `[]`.
- `handleToolCall(event, reply)` — today's `handleEvent` tool-call body (resolve
  profile, dispatch a child, track in-flight, reply with the result) but replying via
  the injected `reply` instead of `session.sendToolResult`.
- `observe(event)` — today's parent-abort logic: on `idle`/`error` while a dispatch
  is in flight, cancel it (tear down the child + its MCP host).
- `stop()` — cancel any in-flight dispatch (today's `stop()`).

The `report` callback (elapsed/token summary) is unchanged.

## Factory — `@ai-ezio/session-hosts`

New package with one public function:

```ts
import { DelegatedToolRegistry } from "@ai-ezio/harness";
import { loadMcpHost, type McpHost, type RunMode } from "@ai-ezio/mcp-host";
import { loadSubagentHost } from "@ai-ezio/subagent";
import { ensureDelegatedTimeout } from "./timeout.js"; // moved here from the CLI

/** Build the standard delegated-tool stack for a Session: the MCP host + the
 * subagent host, wrapped in one registry. Returns the registry (wired by the
 * creator) plus the McpHost for its host-private API (recorder/compactor). */
export function loadSessionHosts(opts: {
	mode: RunMode;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	report?: (line: string) => void;
	notes?: string[];
}): { registry: DelegatedToolRegistry; mcpHost: McpHost } {
	ensureDelegatedTimeout(opts.env); // raise the parent block backstop (1800s) when unset
	const mcpHost = loadMcpHost({ mode: opts.mode, cwd: opts.cwd, env: opts.env });
	const subagentHost = loadSubagentHost({
		cwd: opts.cwd,
		env: opts.env,
		report: opts.report,
		notes: opts.notes,
	});
	const registry = new DelegatedToolRegistry([mcpHost, subagentHost]);
	return { registry, mcpHost };
}
```

`ensureDelegatedTimeout` (the `"1800"`-seconds helper) moves out of the CLI into
`session-hosts` so the backstop is set once, for both run modes. (The ezio standalone
CLI keeps no copy.)

## Creator migration

Both creators collapse the per-host wiring to the registry. The only mode-specific
code that remains is the genuinely-different surface: renderer, recorder, rename
controller, compactor/auto-compact driver, input handling, and (mounted) the
turn-assembly/fidelity handlers.

### ezio standalone (`packages/cli/src/repl/standalone-runtime.ts`)

`runOneShot` and `runStandalone`:

```ts
const { registry, mcpHost } = loadSessionHosts({
	mode, cwd, report: subagentReportLine(/* err | stdout */),
});
const recorder = createRecorder({ /* … */ host: mcpHost });   // host-private API
const session = new Session({
	onEvent: (e) => {
		/* …rename / renderer / recorder / compactor… */
		registry.handleEvent(e); // replaces host.handleEvent + subagentHost.handleEvent
	},
});
// …
await session.start(/* … */);
await registry.start(session);   // replaces host.start + subagentHost.start
// teardown:
await registry.stop();           // replaces host.stop + subagentHost.stop
```

- `buildCompactor`/`createRecorder` continue to take `host: mcpHost`.
- `buildStandaloneResumeDeps` takes `registry` instead of `host` + `subagentHost`;
  the resume thunk becomes `session.resume(id)` → `registry.start(session)` (the
  registry rebuilds the routing map on the re-spawn).
- `ensureDelegatedTimeout()`/`subagentReportLine` move/are-imported per the factory;
  the `loadMcpHost`/`loadSubagentHost` direct imports are dropped from the CLI.

### ai-whisper mounted (`adapter-ai-ezio/src/create-ai-ezio-live-session.ts`)

Same shape, downstream PR:

- Add `@ai-ezio/session-hosts` (and transitively `@ai-ezio/subagent`) to
  `adapter-ai-ezio/package.json` (the only ezio-touching package).
- `const { registry, mcpHost } = loadSessionHosts({ mode: "mounted", cwd, report })`.
- Replace `host.handleEvent(event)` in the onEvent tee with `registry.handleEvent(event)`.
- Replace `host.start(session)` (initial + resume) with `registry.start(session)`.
- Replace `host.stop()` in teardown with `registry.stop()`.
- Pass `mcpHost` to `createRecorder`/the compaction driver where `host` is used.
- **Net effect:** the `subagent` tool is now advertised in mounted mode for the first
  time (it rides the same registry). Requires an ai-whisper rebuild + global whisper
  reinstall to take effect (the esbuild-bundling gotcha).

## Error handling

| Case | Behavior |
| --- | --- |
| Provider `init()` throws (e.g. an MCP server fails to connect) | The provider surfaces its own one-line warning and continues with what connected (today's McpHost behavior); `tools()` returns whatever is available. A provider whose `init` fully fails contributes no tools. |
| Duplicate tool name across providers | Registry warns (both ids) and keeps the first; duplicate is not registered/routed. |
| `tool_call_requested` for an unowned name | Ignored (cannot occur for a registered tool; never-replied calls hit hax's timeout backstop). |
| `handleToolCall` rejects/throws | The provider is responsible for replying with an error result and never throwing out (today's contract for both hosts); the registry calls it detached (`void`). |
| Parent interrupt mid-call | hax aborts the blocked delegated read; the registry broadcasts the resulting `idle`/`error` to `observe`, and the subagent host tears its child down. |

## Testing

- **harness** — `DelegatedToolRegistry` unit tests with fake providers: routes a
  `tool_call_requested` to the owning provider only; broadcasts lifecycle events to
  every `observe`; collects defs into one `registerDelegatedTools` call; warns + keeps
  first on a duplicate name; `stop()` calls every provider's `stop`; reply routes
  through the session's `sendToolResult`.
- **mcp-host** — rewrite `host.test.ts` to the provider shape (`init`/`tools`/
  `handleToolCall`); assert `callHostTool`/`hostToolNames` still work; **delete** the
  cross-provider "unknown tool" assertion (now the registry's job).
- **subagent** — rewrite `host.test.ts` to the provider shape; the existing
  token-summary, unknown/default-profile, and parent-cancel (`observe`) cases carry
  over.
- **subagent / dual-host** — move `dual-host.test.ts` to a **registry** routing test
  (real McpHost + real SubagentHost behind a `DelegatedToolRegistry`): a `subagent`
  call yields exactly the subagent's reply and never `"unknown tool: subagent"`. This
  is the structural replacement for the `7642039` patch + its test.
- **session-hosts** — `loadSessionHosts` returns a registry whose providers are the
  MCP + subagent hosts, returns the `mcpHost`, and sets `AI_EZIO_DELEGATED_TIMEOUT`
  when unset.
- **cli** — update `standalone-runtime.test.ts`: the resume-ordering test asserts
  `session.resume → registry.start`; assert the onEvent tee calls `registry.handleEvent`.
- **ai-whisper (downstream PR)** — update the adapter tests; add an assertion that the
  mounted session advertises the `subagent` tool (it did not before).

## Back-compat / breaking changes

- `McpHost` and `SubagentHost` lose their public `start`/`handleEvent` methods
  (replaced by `init`/`tools`/`handleToolCall`/`observe`); all wiring goes through the
  registry. `McpHost.callHostTool`/`hostToolNames` and `SubagentHost`'s construction
  options are unchanged.
- `loadMcpHost`/`loadSubagentHost` remain (the factory uses them); creators stop
  importing them directly in favor of `loadSessionHosts`.
- The `mcp-host` `7642039` self-filter is removed; the dual-host guarantee moves to
  the registry. No protocol or `vendor/hax` change.

## Phasing

1. **PR 1 — ezio** (this repo, branch `delegated-tool-registry`): harness interface +
   registry, `mcp-host`/`subagent` provider refactors (+ patch removal), new
   `@ai-ezio/session-hosts`, standalone-CLI migration, and all ezio tests. Green and
   shippable on its own; standalone behavior is unchanged (same tools, same surface).
2. **PR 2 — ai-whisper** (downstream): `adapter-ai-ezio` adopts `loadSessionHosts`;
   mounted gains the `subagent` tool; adapter tests updated. Requires a whisper
   rebuild/reinstall.

## Out of scope (follow-up)

- Making `adapter-ai-ezio` lazy-loaded and its `@ai-ezio/*` deps `optional`/`peer` so
  the ai-whisper install graph is ezio-free for Claude/Codex users. Pre-existing
  packaging gap; orthogonal to the registry.
- Deferring the codex probe off the mounted startup critical path (noted in the
  subagent v0 spec's risks); independent of this refactor.

## Risks / open items

- **Resume semantics.** `registry.start` must be safe to call again after a re-spawn
  (it clears and rebuilds the owner map and re-registers). Verify against the harness
  `Session.resume` flow that re-`init()`-ing the MCP host (reconnecting servers) on
  resume matches today's `host.start(session)` re-register behavior — the standalone
  resume path already re-runs `host.start`, so this preserves it, but the MCP
  reconnect cost on resume should be confirmed acceptable (it matches today).
- **`init()` ordering vs first submit.** As today, `registry.start` must complete
  before the first `submit`; the creators already gate on this for the MCP host.
- **ai-whisper bundling.** Mounted changes need the esbuild rebuild + global reinstall
  to take effect; the PR description must call this out.
