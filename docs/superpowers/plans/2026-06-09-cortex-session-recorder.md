# Cortex Session Recorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture ezio coding sessions into ai-cortex with no scraping, by assembling turns from the fd-3 protocol event stream and feeding cortex a Claude-format transcript via a host-private MCP call.

**Architecture:** A new `packages/session-recorder` package observes the harness event stream (`Session.onEvent`), assembles a neutral per-turn model, persists ezio's own durable record (with token usage), and projects each turn into cortex's Claude-format transcript. A generic `SessionSink` is the seam; `CortexSessionSink` is the only cortex-aware adapter and triggers capture through a new **host-private** `McpHost.callHostTool` path (added to `mcp-host`) so capture never enters hax's advertised tool table. cortex gains one small host-agnostic `capture_session` MCP tool wrapping its existing `captureSession()`.

**Tech Stack:** TypeScript (NodeNext ESM), pnpm workspace, vitest, tabs + double quotes. Reference spec: `docs/superpowers/specs/2026-06-09-cortex-session-recorder-design.md`.

---

## File Structure

New package `packages/session-recorder/`:

- `src/types.ts` — neutral model + seam interfaces (`RecordedTurn`, `SessionSink`, `DurableStore`, `HostToolCaller`, …).
- `src/cortex-projection.ts` — pure `renderCortexLines(turn, startTurnNo)` → the two Claude-format JSONL lines cortex parses.
- `src/recorder.ts` — `SessionRecorder`: event→turn assembly + trigger policy (debounce / every-K / boundary / close).
- `src/durable-store.ts` — `JsonlDurableStore`: ezio's durable per-turn record (carries usage).
- `src/cortex-sink.ts` — `CortexSessionSink`: writes the projection file + triggers `capture_session` via `callHostTool`.
- `src/recovery.ts` — `recoverUncaptured()`: startup sweep re-triggering capture for on-disk projections.
- `src/paths.ts` — `ezioStateDir(env)`, `repoKeyForPath(cwd)` helpers.
- `src/factory.ts` — `createRecorder(opts)` wiring store + sink + recorder; plus the CLI wiring snippet.
- `src/index.ts` — barrel.

Modified:

- `packages/mcp-host/src/host.ts` — add `hostPrivateTools` filtering + `callHostTool()` (spec §4.1).
- `tsconfig.json` (root) — add the new package reference.
- `/Users/vuphan/Dev/ai-cortex/src/mcp/server.ts` — add the `capture_session` MCP tool (cross-repo; spec §4).

---

## Task 1: Scaffold the `session-recorder` package

**Files:**
- Create: `packages/session-recorder/package.json`
- Create: `packages/session-recorder/tsconfig.json`
- Create: `packages/session-recorder/src/index.ts`
- Modify: `tsconfig.json` (root) — add the reference

- [ ] **Step 1: Create `package.json`**

```json
{
	"name": "@ai-ezio/session-recorder",
	"version": "0.1.0",
	"description": "ai-ezio session recorder: assemble turns from the protocol stream and feed cortex a Claude-format transcript",
	"license": "MIT",
	"type": "module",
	"exports": {
		".": {
			"types": "./dist/index.d.ts",
			"import": "./dist/index.js"
		}
	},
	"files": [
		"dist"
	],
	"dependencies": {
		"@ai-ezio/protocol": "workspace:*"
	},
	"scripts": {
		"build": "tsc --build",
		"test": "vitest run"
	}
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
	"extends": "../../tsconfig.base.json",
	"compilerOptions": {
		"rootDir": "src",
		"outDir": "dist"
	},
	"references": [{ "path": "../protocol" }],
	"include": ["src/**/*.ts"],
	"exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 3: Create a placeholder `src/index.ts`** (replaced as tasks land)

```typescript
/** ai-ezio session recorder: protocol stream → cortex capture. */
export const SESSION_RECORDER_PLACEHOLDER = true;
```

- [ ] **Step 4: Add the package to the root `tsconfig.json` references**

Modify `tsconfig.json` (root) — add the new reference to the `references` array:

```json
{
	"files": [],
	"references": [
		{ "path": "packages/protocol" },
		{ "path": "packages/surface" },
		{ "path": "packages/harness" },
		{ "path": "packages/mcp-host" },
		{ "path": "packages/session-recorder" },
		{ "path": "packages/cli" }
	]
}
```

- [ ] **Step 5: Install + build to verify the scaffold**

Run: `pnpm install && pnpm -F @ai-ezio/session-recorder build`
Expected: install links the workspace package; build succeeds and emits `dist/index.js`.

- [ ] **Step 6: Commit**

```bash
git add packages/session-recorder tsconfig.json pnpm-lock.yaml
git commit -m "feat(session-recorder): scaffold package"
```

---

## Task 2: Define the neutral model + seam interfaces

**Files:**
- Create: `packages/session-recorder/src/types.ts`

- [ ] **Step 1: Write `types.ts`** (pure types — verified by the build)

```typescript
/** Neutral, host-agnostic session model + the generic seams the recorder fans out to. */

/** Per-turn token usage (ezio telemetry — kept in the durable record, NOT in the
 * cortex projection). Mirrors the protocol's assistant_turn_finished.usage. */
export interface TokenUsage {
	contextTokens?: number;
	outputTokens?: number;
	cachedTokens?: number;
	contextLimit?: number;
}

/** Identifies one conversation. `conversationId` is the cortex sessionId (unique per
 * /new), sanitized to cortex's `^[\w-]+$`. */
export interface ConversationRef {
	sessionId: string;
	conversationId: string;
	worktreePath: string;
}

export interface RecordedToolCall {
	name: string;
	/** One-line summary string for native hax tools (tool_call_started.args); the full
	 * args object for delegated/MCP tools (tool_call_requested.args); undefined if neither. */
	input: string | Record<string, unknown> | undefined;
	status: "ok" | "error" | "pending";
	output?: string;
	isDiff?: boolean;
}

export interface RecordedTurn {
	ref: ConversationRef;
	index: number;
	userText: string;
	assistantText: string;
	toolCalls: RecordedToolCall[];
	usage?: TokenUsage;
}

export type FlushReason = "debounce" | "everyK" | "new" | "close";

/** The generic session-sink seam. The recorder appends completed turns (`onTurnComplete`)
 * and asks the sink to trigger capture (`flush`) per the recorder's policy. Knows nothing
 * about cortex. */
export interface SessionSink {
	onTurnComplete(turn: RecordedTurn): void | Promise<void>;
	flush(ref: ConversationRef, reason: FlushReason): void | Promise<void>;
}

/** ezio's durable per-turn record (source of truth; carries usage). */
export interface DurableStore {
	append(turn: RecordedTurn): void | Promise<void>;
}

/** Minimal surface the cortex sink needs from the MCP host — a host-private tool call
 * (NOT advertised to the model). Implemented by mcp-host's `McpHost.callHostTool`. */
export interface HostToolCaller {
	callHostTool(
		name: string,
		args: Record<string, unknown>,
	): Promise<{ output: string; status: "ok" | "error" }>;
}
```

- [ ] **Step 2: Build to verify the types compile**

Run: `pnpm -F @ai-ezio/session-recorder build`
Expected: PASS (no emit errors).

- [ ] **Step 3: Commit**

```bash
git add packages/session-recorder/src/types.ts
git commit -m "feat(session-recorder): neutral model + seam interfaces"
```

---

## Task 3: Cortex transcript projection (pure)

**Files:**
- Create: `packages/session-recorder/src/cortex-projection.ts`
- Test: `packages/session-recorder/src/cortex-projection.test.ts`

This is the format contract. The shape was validated against cortex's parser
(`ai-cortex/src/lib/history/compact.ts` — `type: user|assistant`, `message.content[]`
with `text` and `tool_use` blocks; `tool_use` carries `name` + `input`).

- [ ] **Step 1: Write the failing test**

```typescript
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCortexLines } from "./cortex-projection.js";
import type { RecordedTurn } from "./types.js";

const ref = { sessionId: "s1", conversationId: "s1-0", worktreePath: "/repo" };

describe("renderCortexLines", () => {
	it("emits a user line then an assistant line with text + tool_use blocks", () => {
		const turn: RecordedTurn = {
			ref,
			index: 0,
			userText: "look at foo.ts",
			assistantText: "Reading it.",
			toolCalls: [
				{ name: "Read", input: { file_path: "src/foo.ts" }, status: "ok" },
				{ name: "bash", input: "grep -n TODO", status: "ok" },
			],
		};
		const [userLine, asstLine] = renderCortexLines(turn, 0).map((l) => JSON.parse(l));

		expect(userLine).toEqual({
			type: "user",
			turn: 0,
			message: { content: [{ type: "text", text: "look at foo.ts" }] },
		});
		expect(asstLine.type).toBe("assistant");
		expect(asstLine.turn).toBe(1);
		expect(asstLine.message.content[0]).toEqual({ type: "text", text: "Reading it." });
		expect(asstLine.message.content[1]).toEqual({
			type: "tool_use",
			name: "Read",
			input: { file_path: "src/foo.ts" },
		});
		expect(asstLine.message.content[2]).toEqual({
			type: "tool_use",
			name: "bash",
			input: "grep -n TODO",
		});
	});

	it("uses the running line counter so turn numbers stay monotonic", () => {
		const turn: RecordedTurn = { ref, index: 3, userText: "u", assistantText: "a", toolCalls: [] };
		const [u, a] = renderCortexLines(turn, 6).map((l) => JSON.parse(l));
		expect(u.turn).toBe(6);
		expect(a.turn).toBe(7);
	});

	it("omits tool_use input gracefully when undefined", () => {
		const turn: RecordedTurn = {
			ref,
			index: 0,
			userText: "u",
			assistantText: "a",
			toolCalls: [{ name: "noop", input: undefined, status: "ok" }],
		};
		const a = JSON.parse(renderCortexLines(turn, 0)[1]);
		expect(a.message.content[1]).toEqual({ type: "tool_use", name: "noop", input: {} });
	});
});

// Real round-trip through cortex's parser+evidence (spec §6). Runs only when the sibling
// ai-cortex build is present; set AI_CORTEX_DIST to its `dist` root to enable it locally
// and in the workflow. Skipped (not failed) otherwise so ezio CI stays decoupled from cortex.
const cortexDist = process.env.AI_CORTEX_DIST;
const compactPath = cortexDist ? join(cortexDist, "lib/history/compact.js") : "";
describe.skipIf(!cortexDist || !existsSync(compactPath))("renderCortexLines × cortex real parser", () => {
	it("yields user prompts, tool calls, and file paths via cortex's parseTranscript+extractEvidence", async () => {
		const { parseTranscript, extractEvidence } = (await import(compactPath)) as {
			parseTranscript: (p: string) => unknown[];
			extractEvidence: (t: unknown[]) => {
				userPrompts: { text: string }[];
				toolCalls: { name: string }[];
				filePaths: { path: string }[];
			};
		};
		const turn: RecordedTurn = {
			ref,
			index: 0,
			userText: "analyze the auth module",
			assistantText: "reading",
			toolCalls: [{ name: "Read", input: { file_path: "src/auth.ts" }, status: "ok" }],
		};
		const dir = mkdtempSync(join(tmpdir(), "ezio-rt-"));
		const file = join(dir, "t.jsonl");
		writeFileSync(file, `${renderCortexLines(turn, 0).join("\n")}\n`);
		const ev = extractEvidence(parseTranscript(file));
		expect(ev.userPrompts.map((u) => u.text)).toContain("analyze the auth module");
		expect(ev.toolCalls.map((t) => t.name)).toContain("Read");
		expect(ev.filePaths.map((f) => f.path)).toContain("src/auth.ts");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F @ai-ezio/session-recorder test`
Expected: FAIL — `renderCortexLines` not found. (The guarded round-trip is skipped unless `AI_CORTEX_DIST` is set.)

- [ ] **Step 3: Write `cortex-projection.ts`**

```typescript
/** Project a neutral turn into the two Claude-format JSONL lines cortex's parser
 * consumes (ai-cortex/src/lib/history/compact.ts). `startTurnNo` is the running line
 * counter; each turn consumes two line numbers (user, assistant). */
import type { RecordedTurn } from "./types.js";

export function renderCortexLines(turn: RecordedTurn, startTurnNo: number): string[] {
	const userLine = {
		type: "user",
		turn: startTurnNo,
		message: { content: [{ type: "text", text: turn.userText }] },
	};

	const assistantContent: Array<Record<string, unknown>> = [
		{ type: "text", text: turn.assistantText },
	];
	for (const tc of turn.toolCalls) {
		assistantContent.push({ type: "tool_use", name: tc.name, input: tc.input ?? {} });
	}
	const assistantLine = {
		type: "assistant",
		turn: startTurnNo + 1,
		message: { content: assistantContent },
	};

	return [JSON.stringify(userLine), JSON.stringify(assistantLine)];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -F @ai-ezio/session-recorder test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/session-recorder/src/cortex-projection.ts packages/session-recorder/src/cortex-projection.test.ts
git commit -m "feat(session-recorder): cortex-format transcript projection"
```

---

## Task 4: `SessionRecorder` — event→turn assembly

**Files:**
- Create: `packages/session-recorder/src/recorder.ts`
- Test: `packages/session-recorder/src/recorder.test.ts`

- [ ] **Step 1: Write the failing test** (assembly only; trigger policy is Task 5)

```typescript
import { describe, expect, it, vi } from "vitest";
import { SessionRecorder } from "./recorder.js";
import type { RecordedTurn, SessionSink } from "./types.js";
import type { ProtocolEvent } from "@ai-ezio/protocol";

function fakeSink() {
	const turns: RecordedTurn[] = [];
	const sink: SessionSink = {
		onTurnComplete: (t) => void turns.push(t),
		flush: vi.fn(),
	};
	return { sink, turns };
}

function feed(rec: SessionRecorder, events: ProtocolEvent[]) {
	for (const e of events) rec.handleEvent(e);
}

describe("SessionRecorder assembly", () => {
	it("assembles a turn: user text echo, tool calls, final content + usage", () => {
		const { sink, turns } = fakeSink();
		const store = { append: vi.fn() };
		const rec = new SessionRecorder({ worktreePath: "/repo", store, sink, idleDebounceMs: 9_999, everyKTurns: 999 });

		rec.noteSubmit("look at foo.ts"); // authoritative source: the text ezio itself sent
		feed(rec, [
			{ type: "ready", sessionId: "s1", protocol: "0.1.0", haxBaseCommit: "abc" },
			{ type: "user_turn_started", turnId: "t1" }, // NOTE: no `text` echo — correlation must come from noteSubmit
			{ type: "assistant_turn_started", turnId: "t1" },
			{ type: "tool_call_started", turnId: "t1", name: "Read", callId: "c1", args: "src/foo.ts" },
			{ type: "tool_call_finished", turnId: "t1", name: "Read", callId: "c1", status: "ok", output: "…", isDiff: false },
			{ type: "assistant_turn_finished", turnId: "t1", content: "Done.", usage: { outputTokens: 12, contextTokens: 400 } },
			{ type: "idle" },
		]);

		expect(turns).toHaveLength(1);
		const turn = turns[0]!;
		expect(turn.ref).toEqual({ sessionId: "s1", conversationId: "s1-0", worktreePath: "/repo" });
		expect(turn.userText).toBe("look at foo.ts");
		expect(turn.assistantText).toBe("Done.");
		expect(turn.usage).toEqual({ outputTokens: 12, contextTokens: 400 });
		expect(turn.toolCalls).toEqual([
			{ name: "Read", input: "src/foo.ts", status: "ok", output: "…", isDiff: false },
		]);
		expect(store.append).toHaveBeenCalledWith(turn);
	});

	it("prefers the stashed submit text over the protocol echo", () => {
		const { sink, turns } = fakeSink();
		const rec = new SessionRecorder({ worktreePath: "/repo", store: { append: vi.fn() }, sink, idleDebounceMs: 9_999, everyKTurns: 999 });
		rec.noteSubmit("authoritative");
		feed(rec, [
			{ type: "ready", sessionId: "s1", protocol: "0.1.0", haxBaseCommit: "abc" },
			{ type: "user_turn_started", turnId: "t1", text: "echo-only" },
			{ type: "assistant_turn_finished", turnId: "t1", content: "" },
			{ type: "idle" },
		]);
		expect(turns[0]!.userText).toBe("authoritative");
	});

	it("falls back to the protocol echo when no submit was stashed", () => {
		const { sink, turns } = fakeSink();
		const rec = new SessionRecorder({ worktreePath: "/repo", store: { append: vi.fn() }, sink, idleDebounceMs: 9_999, everyKTurns: 999 });
		feed(rec, [
			{ type: "ready", sessionId: "s1", protocol: "0.1.0", haxBaseCommit: "abc" },
			{ type: "user_turn_started", turnId: "t1", text: "echo-fallback" },
			{ type: "assistant_turn_finished", turnId: "t1", content: "" },
			{ type: "idle" },
		]);
		expect(turns[0]!.userText).toBe("echo-fallback");
	});

	it("upgrades a delegated tool's input from the requested args object", () => {
		const { sink, turns } = fakeSink();
		const rec = new SessionRecorder({ worktreePath: "/repo", store: { append: vi.fn() }, sink, idleDebounceMs: 9_999, everyKTurns: 999 });
		feed(rec, [
			{ type: "ready", sessionId: "s1", protocol: "0.1.0", haxBaseCommit: "abc" },
			{ type: "user_turn_started", turnId: "t1", text: "recall" },
			{ type: "tool_call_started", turnId: "t1", name: "cortex__recall_memory", callId: "c1", args: "query=x" },
			{ type: "tool_call_requested", turnId: "t1", name: "cortex__recall_memory", callId: "c1", args: { query: "x" } },
			{ type: "tool_call_finished", turnId: "t1", name: "cortex__recall_memory", callId: "c1", status: "ok" },
			{ type: "assistant_turn_finished", turnId: "t1", content: "" },
			{ type: "idle" },
		]);
		expect(turns[0]!.toolCalls[0]!.input).toEqual({ query: "x" });
	});

	it("finalizes a partial turn at idle even with no assistant content (interrupt/error)", () => {
		const { sink, turns } = fakeSink();
		const rec = new SessionRecorder({ worktreePath: "/repo", store: { append: vi.fn() }, sink, idleDebounceMs: 9_999, everyKTurns: 999 });
		feed(rec, [
			{ type: "ready", sessionId: "s1", protocol: "0.1.0", haxBaseCommit: "abc" },
			{ type: "user_turn_started", turnId: "t1", text: "do a thing" },
			{ type: "error", message: "boom", turnId: "t1" },
			{ type: "idle" },
		]);
		expect(turns).toHaveLength(1);
		expect(turns[0]!.assistantText).toBe("");
	});

	it("ignores a stray idle with no open turn", () => {
		const { sink, turns } = fakeSink();
		const rec = new SessionRecorder({ worktreePath: "/repo", store: { append: vi.fn() }, sink, idleDebounceMs: 9_999, everyKTurns: 999 });
		feed(rec, [
			{ type: "ready", sessionId: "s1", protocol: "0.1.0", haxBaseCommit: "abc" },
			{ type: "idle" },
		]);
		expect(turns).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F @ai-ezio/session-recorder test`
Expected: FAIL — `SessionRecorder` not found.

- [ ] **Step 3: Write `recorder.ts`** (assembly + the policy used in Task 5)

```typescript
/** Assembles turns from the protocol event stream and drives the durable store + sink.
 * Wire `handleEvent` to `Session.onEvent`, and call `noteSubmit(text)` wherever the host
 * sends a `submit` so the next turn's user text is the authoritative submit text (spec §2;
 * the optional `user_turn_started.text` echo is only a fallback). Boundaries that have no
 * event (/new, shutdown) are signalled via `noteNewConversation()` / `close()`. */
import type { ProtocolEvent } from "@ai-ezio/protocol";
import type {
	ConversationRef,
	DurableStore,
	FlushReason,
	RecordedToolCall,
	RecordedTurn,
	SessionSink,
} from "./types.js";

export interface RecorderOptions {
	worktreePath: string;
	store: DurableStore;
	sink: SessionSink;
	/** Quiet period after a turn before a debounced capture fires. Default 10_000ms. */
	idleDebounceMs?: number;
	/** Force a capture every K turns even if the debounce never fires. Default 10. */
	everyKTurns?: number;
}

/** Sanitize to cortex's `^[\w-]+$` (anything else → "-"). */
export function sanitizeId(s: string): string {
	return s.replace(/[^\w-]/g, "-");
}

export class SessionRecorder {
	private readonly idleDebounceMs: number;
	private readonly everyKTurns: number;

	private sessionId = "";
	private convCounter = 0;
	private conversationId = "";
	private turnIndex = 0;
	private turnsSinceFlush = 0;

	private current?: RecordedTurn;
	private readonly callsById = new Map<string, RecordedToolCall>();
	private readonly pendingSubmits: string[] = [];
	private debounce?: ReturnType<typeof setTimeout>;

	constructor(private readonly opts: RecorderOptions) {
		this.idleDebounceMs = opts.idleDebounceMs ?? 10_000;
		this.everyKTurns = opts.everyKTurns ?? 10;
	}

	private ref(): ConversationRef {
		return {
			sessionId: this.sessionId,
			conversationId: this.conversationId,
			worktreePath: this.opts.worktreePath,
		};
	}

	handleEvent(event: ProtocolEvent): void {
		switch (event.type) {
			case "ready":
				this.sessionId = event.sessionId;
				this.conversationId = sanitizeId(`${event.sessionId}-${this.convCounter}`);
				break;
			case "user_turn_started":
				this.current = {
					ref: this.ref(),
					index: this.turnIndex++,
					userText: this.pendingSubmits.shift() ?? event.text ?? "",
					assistantText: "",
					toolCalls: [],
				};
				this.callsById.clear();
				break;
			case "tool_call_started": {
				if (!this.current) break;
				const tc: RecordedToolCall = { name: event.name, input: event.args, status: "pending" };
				this.callsById.set(event.callId, tc);
				this.current.toolCalls.push(tc);
				break;
			}
			case "tool_call_requested": {
				if (!this.current) break;
				const existing = this.callsById.get(event.callId);
				if (existing) {
					existing.input = event.args;
				} else {
					const tc: RecordedToolCall = { name: event.name, input: event.args, status: "pending" };
					this.callsById.set(event.callId, tc);
					this.current.toolCalls.push(tc);
				}
				break;
			}
			case "tool_call_finished": {
				const tc = this.callsById.get(event.callId);
				if (tc) {
					tc.status = event.status;
					tc.output = event.output;
					tc.isDiff = event.isDiff;
				}
				break;
			}
			case "assistant_turn_finished":
				if (this.current) {
					this.current.assistantText = event.content;
					this.current.usage = event.usage;
				}
				break;
			case "idle":
				this.finalizeTurn();
				break;
			default:
				break;
		}
	}

	/** Record the text of a `submit` control the host just sent, so the next
	 * `user_turn_started` is attributed to it (authoritative source per spec §2). FIFO:
	 * supports queued submits; the protocol echo `user_turn_started.text` is the fallback. */
	noteSubmit(text: string): void {
		this.pendingSubmits.push(text);
	}

	/** Boundary with no protocol event: the host is about to send `new_conversation`. */
	noteNewConversation(): void {
		this.triggerFlush("new");
		this.convCounter++;
		this.conversationId = sanitizeId(`${this.sessionId}-${this.convCounter}`);
		this.turnIndex = 0;
	}

	/** Session shutdown / fd-3 EOF. */
	close(): void {
		this.triggerFlush("close");
	}

	private finalizeTurn(): void {
		const turn = this.current;
		if (!turn) return;
		this.current = undefined;
		void Promise.resolve(this.opts.store.append(turn));
		void Promise.resolve(this.opts.sink.onTurnComplete(turn));
		this.turnsSinceFlush++;
		if (this.turnsSinceFlush >= this.everyKTurns) {
			this.triggerFlush("everyK");
		} else {
			this.armDebounce();
		}
	}

	private armDebounce(): void {
		if (this.debounce) clearTimeout(this.debounce);
		this.debounce = setTimeout(() => this.triggerFlush("debounce"), this.idleDebounceMs);
	}

	private triggerFlush(reason: FlushReason): void {
		if (this.debounce) {
			clearTimeout(this.debounce);
			this.debounce = undefined;
		}
		this.turnsSinceFlush = 0;
		if (!this.conversationId) return; // nothing captured yet
		void Promise.resolve(this.opts.sink.flush(this.ref(), reason));
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -F @ai-ezio/session-recorder test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/session-recorder/src/recorder.ts packages/session-recorder/src/recorder.test.ts
git commit -m "feat(session-recorder): assemble turns from the protocol stream"
```

---

## Task 5: `SessionRecorder` — trigger policy (debounce / every-K / boundaries)

**Files:**
- Modify: `packages/session-recorder/src/recorder.test.ts` (add a `describe` block)

The policy code already lives in `recorder.ts` (Task 4). This task pins it with fake timers.

- [ ] **Step 1: Write the failing tests** — append to `recorder.test.ts`

```typescript
describe("SessionRecorder trigger policy", () => {
	function ready(rec: SessionRecorder) {
		rec.handleEvent({ type: "ready", sessionId: "s1", protocol: "0.1.0", haxBaseCommit: "abc" });
	}
	function oneTurn(rec: SessionRecorder, n: number) {
		rec.handleEvent({ type: "user_turn_started", turnId: `t${n}`, text: `u${n}` });
		rec.handleEvent({ type: "assistant_turn_finished", turnId: `t${n}`, content: `a${n}` });
		rec.handleEvent({ type: "idle" });
	}

	it("does NOT flush on every turn; flushes after the idle debounce", () => {
		vi.useFakeTimers();
		const flush = vi.fn();
		const rec = new SessionRecorder({
			worktreePath: "/repo",
			store: { append: vi.fn() },
			sink: { onTurnComplete: vi.fn(), flush },
			idleDebounceMs: 10_000,
			everyKTurns: 100,
		});
		ready(rec);
		oneTurn(rec, 1);
		oneTurn(rec, 2);
		expect(flush).not.toHaveBeenCalled();
		vi.advanceTimersByTime(10_000);
		expect(flush).toHaveBeenCalledTimes(1);
		expect(flush).toHaveBeenLastCalledWith(
			{ sessionId: "s1", conversationId: "s1-0", worktreePath: "/repo" },
			"debounce",
		);
		vi.useRealTimers();
	});

	it("force-flushes every K turns", () => {
		vi.useFakeTimers();
		const flush = vi.fn();
		const rec = new SessionRecorder({
			worktreePath: "/repo",
			store: { append: vi.fn() },
			sink: { onTurnComplete: vi.fn(), flush },
			idleDebounceMs: 10_000,
			everyKTurns: 3,
		});
		ready(rec);
		oneTurn(rec, 1);
		oneTurn(rec, 2);
		oneTurn(rec, 3);
		expect(flush).toHaveBeenCalledTimes(1);
		expect(flush).toHaveBeenLastCalledWith(expect.anything(), "everyK");
		vi.useRealTimers();
	});

	it("flushes and rotates the conversation id on new_conversation", () => {
		const flush = vi.fn();
		const rec = new SessionRecorder({
			worktreePath: "/repo",
			store: { append: vi.fn() },
			sink: { onTurnComplete: vi.fn(), flush },
		});
		ready(rec);
		oneTurn(rec, 1);
		rec.noteNewConversation();
		expect(flush).toHaveBeenLastCalledWith(
			{ sessionId: "s1", conversationId: "s1-0", worktreePath: "/repo" },
			"new",
		);
		oneTurn(rec, 2);
		rec.close();
		expect(flush).toHaveBeenLastCalledWith(
			{ sessionId: "s1", conversationId: "s1-1", worktreePath: "/repo" },
			"close",
		);
	});

	it("rapid overlapping boundary triggers never throw or block (fire-and-forget; cortex's lock dedupes)", () => {
		const flush = vi.fn();
		const rec = new SessionRecorder({
			worktreePath: "/repo",
			store: { append: vi.fn() },
			sink: { onTurnComplete: vi.fn(), flush },
		});
		ready(rec);
		oneTurn(rec, 1);
		// Boundaries fire back-to-back with no awaiting between them. triggerFlush is
		// fire-and-forget (returns void), so the turn loop is never blocked; cortex's
		// per-session lock turns the redundant captures into `skipped-locked` no-ops.
		expect(() => {
			rec.noteNewConversation();
			rec.noteNewConversation();
			rec.close();
		}).not.toThrow();
		expect(flush.mock.calls.map((c) => c[1])).toEqual(["new", "new", "close"]);
	});
});
```

- [ ] **Step 2: Run the tests to verify they pass** (code already implemented in Task 4)

Run: `pnpm -F @ai-ezio/session-recorder test`
Expected: PASS. If the every-K test fails because a debounce timer also fired, confirm `triggerFlush` clears `this.debounce` (it does) — the every-K path must not also arm a debounce.

- [ ] **Step 3: Commit**

```bash
git add packages/session-recorder/src/recorder.test.ts
git commit -m "test(session-recorder): pin trigger policy (debounce/every-K/boundaries)"
```

---

## Task 6: `JsonlDurableStore` — ezio's durable record (with usage)

**Files:**
- Create: `packages/session-recorder/src/paths.ts`
- Create: `packages/session-recorder/src/durable-store.ts`
- Test: `packages/session-recorder/src/durable-store.test.ts`

- [ ] **Step 1: Write `paths.ts`** (helpers used here and in later tasks)

```typescript
/** Filesystem layout helpers for ezio-owned session artifacts. */
import { join } from "node:path";

/** `$XDG_STATE_HOME/ezio` or `$HOME/.local/state/ezio`. */
export function ezioStateDir(env: NodeJS.ProcessEnv = process.env): string {
	const base = env.XDG_STATE_HOME?.trim() || join(env.HOME ?? "", ".local", "state");
	return join(base, "ezio");
}

/** A stable, fs-safe grouping key for a repo path (ezio file grouping only; cortex
 * derives its own repoKey internally from worktreePath). */
export function repoKeyForPath(cwd: string): string {
	return cwd.replace(/[^\w-]/g, "-").replace(/^-+/, "").slice(0, 200) || "root";
}
```

- [ ] **Step 2: Write the failing test**

```typescript
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlDurableStore } from "./durable-store.js";
import type { RecordedTurn } from "./types.js";

describe("JsonlDurableStore", () => {
	it("appends one JSON line per turn including usage", () => {
		const dir = mkdtempSync(join(tmpdir(), "ezio-rec-"));
		const store = new JsonlDurableStore({ stateDir: dir, repoKey: "repo" });
		const ref = { sessionId: "s1", conversationId: "s1-0", worktreePath: "/repo" };
		const turn: RecordedTurn = {
			ref,
			index: 0,
			userText: "u",
			assistantText: "a",
			toolCalls: [{ name: "Read", input: "x", status: "ok" }],
			usage: { outputTokens: 5 },
		};
		store.append(turn);
		store.append({ ...turn, index: 1, usage: { outputTokens: 7 } });

		const file = join(dir, "sessions", "repo", "s1-0.record.jsonl");
		const lines = readFileSync(file, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		const first = JSON.parse(lines[0]!);
		expect(first.usage).toEqual({ outputTokens: 5 });
		expect(first.toolCalls[0]).toEqual({ name: "Read", input: "x", status: "ok" });
		expect(JSON.parse(lines[1]!).usage).toEqual({ outputTokens: 7 });
	});
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm -F @ai-ezio/session-recorder test`
Expected: FAIL — `JsonlDurableStore` not found.

- [ ] **Step 4: Write `durable-store.ts`**

```typescript
/** ezio's durable per-turn record — the source of truth (carries token usage).
 * Append-only JSONL at `<stateDir>/sessions/<repoKey>/<conversationId>.record.jsonl`. */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DurableStore, RecordedTurn } from "./types.js";

export interface JsonlDurableStoreOptions {
	stateDir: string;
	repoKey: string;
}

export class JsonlDurableStore implements DurableStore {
	constructor(private readonly opts: JsonlDurableStoreOptions) {}

	private path(turn: RecordedTurn): string {
		return join(
			this.opts.stateDir,
			"sessions",
			this.opts.repoKey,
			`${turn.ref.conversationId}.record.jsonl`,
		);
	}

	append(turn: RecordedTurn): void {
		const p = this.path(turn);
		mkdirSync(dirname(p), { recursive: true });
		const row = {
			index: turn.index,
			userText: turn.userText,
			assistantText: turn.assistantText,
			toolCalls: turn.toolCalls,
			usage: turn.usage,
		};
		appendFileSync(p, `${JSON.stringify(row)}\n`);
	}
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm -F @ai-ezio/session-recorder test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/session-recorder/src/paths.ts packages/session-recorder/src/durable-store.ts packages/session-recorder/src/durable-store.test.ts
git commit -m "feat(session-recorder): durable per-turn record with usage"
```

---

## Task 7: `CortexSessionSink` — projection file + capture trigger

**Files:**
- Create: `packages/session-recorder/src/cortex-sink.ts`
- Test: `packages/session-recorder/src/cortex-sink.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CortexSessionSink } from "./cortex-sink.js";
import type { RecordedTurn } from "./types.js";

const ref = { sessionId: "s1", conversationId: "s1-0", worktreePath: "/repo" };

function turn(i: number, tools: RecordedTurn["toolCalls"] = []): RecordedTurn {
	return { ref, index: i, userText: `u${i}`, assistantText: `a${i}`, toolCalls: tools };
}

describe("CortexSessionSink", () => {
	it("appends two projection lines per turn with monotonic turn numbers", () => {
		const dir = mkdtempSync(join(tmpdir(), "ezio-cortex-"));
		const sink = new CortexSessionSink({ host: { callHostTool: vi.fn() }, stateDir: dir, repoKey: "repo" });
		sink.onTurnComplete(turn(0));
		sink.onTurnComplete(turn(1));

		const file = join(dir, "sessions", "repo", "s1-0.cortex.jsonl");
		const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		expect(lines.map((l) => l.turn)).toEqual([0, 1, 2, 3]);
		expect(lines[0]).toEqual({ type: "user", turn: 0, message: { content: [{ type: "text", text: "u0" }] } });
	});

	it("flush calls capture_session via the host with the projection path", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ezio-cortex-"));
		const callHostTool = vi.fn().mockResolvedValue({ output: '{"status":"captured"}', status: "ok" });
		const sink = new CortexSessionSink({ host: { callHostTool }, stateDir: dir, repoKey: "repo" });
		sink.onTurnComplete(turn(0));
		await sink.flush(ref, "debounce");

		expect(callHostTool).toHaveBeenCalledWith("cortex__capture_session", {
			worktreePath: "/repo",
			sessionId: "s1-0",
			transcriptPath: join(dir, "sessions", "repo", "s1-0.cortex.jsonl"),
			embed: true,
		});
	});

	it("swallows a capture failure (fire-and-forget) and warns", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ezio-cortex-"));
		const warn = vi.fn();
		const sink = new CortexSessionSink({
			host: { callHostTool: vi.fn().mockRejectedValue(new Error("down")) },
			stateDir: dir,
			repoKey: "repo",
			warn,
		});
		await expect(sink.flush(ref, "close")).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("capture failed"));
	});

	it("tolerates overlapping flushes + a skipped-locked result (no throw, no block, no warn)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ezio-cortex-"));
		const warn = vi.fn();
		// cortex's per-session lock: the first capture runs; a racing second returns
		// `skipped-locked` (a normal idempotent outcome carried in the OK payload, NOT an error).
		const callHostTool = vi
			.fn()
			.mockResolvedValueOnce({ output: '{"status":"captured","turnsProcessed":1}', status: "ok" })
			.mockResolvedValueOnce({ output: '{"status":"skipped-locked"}', status: "ok" });
		const sink = new CortexSessionSink({ host: { callHostTool }, stateDir: dir, repoKey: "repo", warn });
		sink.onTurnComplete(turn(0));

		// Two boundary triggers race (e.g. debounce timer fires as /new arrives):
		const results = await Promise.all([sink.flush(ref, "debounce"), sink.flush(ref, "new")]);

		expect(results).toEqual([undefined, undefined]); // both resolve — the loop is never blocked
		expect(callHostTool).toHaveBeenCalledTimes(2);
		expect(warn).not.toHaveBeenCalled(); // skipped-locked is success, not a failure to surface
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F @ai-ezio/session-recorder test`
Expected: FAIL — `CortexSessionSink` not found.

- [ ] **Step 3: Write `cortex-sink.ts`**

```typescript
/** The ONLY cortex-aware adapter. Writes the Claude-format projection and triggers
 * `capture_session` through the host-private `callHostTool` path (NEVER advertised to
 * the model). cortex specifics (schema, file, tool name) are quarantined here. */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderCortexLines } from "./cortex-projection.js";
import type { ConversationRef, FlushReason, HostToolCaller, RecordedTurn, SessionSink } from "./types.js";

export interface CortexSessionSinkOptions {
	host: HostToolCaller;
	stateDir: string;
	repoKey: string;
	/** Namespaced tool name. Default "cortex__capture_session". */
	toolName?: string;
	/** Compute embeddings during capture. Default true. */
	embed?: boolean;
	/** One-line failure warnings. Defaults to stderr. */
	warn?: (msg: string) => void;
}

export class CortexSessionSink implements SessionSink {
	private readonly lineNo = new Map<string, number>();

	constructor(private readonly opts: CortexSessionSinkOptions) {}

	private path(ref: ConversationRef): string {
		return join(this.opts.stateDir, "sessions", this.opts.repoKey, `${ref.conversationId}.cortex.jsonl`);
	}

	onTurnComplete(turn: RecordedTurn): void {
		const p = this.path(turn.ref);
		mkdirSync(dirname(p), { recursive: true });
		const start = this.lineNo.get(turn.ref.conversationId) ?? 0;
		const lines = renderCortexLines(turn, start);
		appendFileSync(p, `${lines.join("\n")}\n`);
		this.lineNo.set(turn.ref.conversationId, start + lines.length);
	}

	async flush(ref: ConversationRef, _reason: FlushReason): Promise<void> {
		try {
			await this.opts.host.callHostTool(this.opts.toolName ?? "cortex__capture_session", {
				worktreePath: ref.worktreePath,
				sessionId: ref.conversationId,
				transcriptPath: this.path(ref),
				embed: this.opts.embed ?? true,
			});
		} catch (e) {
			this.warn(`cortex capture failed: ${(e as Error).message}`);
		}
	}

	private warn(msg: string): void {
		(this.opts.warn ?? ((m) => process.stderr.write(`${m}\n`)))(msg);
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -F @ai-ezio/session-recorder test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/session-recorder/src/cortex-sink.ts packages/session-recorder/src/cortex-sink.test.ts
git commit -m "feat(session-recorder): cortex sink (projection + host-private capture)"
```

---

## Task 8: mcp-host — `hostPrivateTools` filter + `callHostTool` (spec §4.1)

**Files:**
- Modify: `packages/mcp-host/src/host.ts`
- Test: `packages/mcp-host/src/host-private.test.ts`

This is the load-bearing seam: it keeps `capture_session` OFF hax's advertised tool
table while still letting the harness call it directly.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from "vitest";
import { McpHost } from "./host.js";
import type { McpClient } from "./mcp-client.js";
import type { DelegatedToolDef } from "@ai-ezio/protocol";

function fakeClient(tools: string[], onCall: (tool: string, args: Record<string, unknown>) => void = () => {}): McpClient {
	return {
		listTools: async (): Promise<DelegatedToolDef[]> =>
			tools.map((name) => ({
				name,
				description: name,
				parametersSchema: { type: "object", properties: { worktreePath: { type: "string" } } },
			})),
		callTool: async (tool, args) => {
			onCall(tool, args);
			return { output: "ok", status: "ok" as const };
		},
		close: async () => {},
	};
}

function fakeSession() {
	const registered: DelegatedToolDef[][] = [];
	return {
		session: {
			registerDelegatedTools: (defs: DelegatedToolDef[]) => void registered.push(defs),
			sendToolResult: vi.fn(),
		},
		registered,
	};
}

describe("McpHost host-private tools", () => {
	it("excludes hostPrivateTools from the delegated set but still routes them", async () => {
		const { session, registered } = fakeSession();
		const host = new McpHost({
			mode: "mounted",
			cwd: "/repo",
			servers: [{ name: "cortex", command: "x", args: [] }],
			toolPolicy: {},
			hostPrivateTools: ["cortex__capture_session"],
			connect: async () => fakeClient(["recall_memory", "capture_session"]),
		});
		await host.start(session);

		const advertised = registered.flat().map((d) => d.name);
		expect(advertised).toEqual(["cortex__recall_memory"]);
		expect(advertised).not.toContain("cortex__capture_session");
	});

	it("callHostTool routes to the client, injects cwd, and returns the result", async () => {
		const { session } = fakeSession();
		const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
		const host = new McpHost({
			mode: "mounted",
			cwd: "/repo",
			servers: [{ name: "cortex", command: "x", args: [] }],
			toolPolicy: {},
			hostPrivateTools: ["cortex__capture_session"],
			connect: async () => fakeClient(["capture_session"], (tool, args) => calls.push({ tool, args })),
		});
		await host.start(session);

		const res = await host.callHostTool("cortex__capture_session", { sessionId: "s1-0", worktreePath: "/wrong" });
		expect(res).toEqual({ output: "ok", status: "ok" });
		expect(calls).toEqual([{ tool: "capture_session", args: { sessionId: "s1-0", worktreePath: "/repo" } }]);
	});

	it("callHostTool throws on a denied tool and on an unknown tool", async () => {
		const { session } = fakeSession();
		const host = new McpHost({
			mode: "mounted",
			cwd: "/repo",
			servers: [{ name: "cortex", command: "x", args: [] }],
			toolPolicy: { cortex__capture_session: "deny" },
			hostPrivateTools: ["cortex__capture_session"],
			connect: async () => fakeClient(["capture_session"]),
		});
		await host.start(session);
		await expect(host.callHostTool("cortex__capture_session", {})).rejects.toThrow(/blocked by policy/);
		await expect(host.callHostTool("cortex__nope", {})).rejects.toThrow(/unknown host tool/);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F @ai-ezio/mcp-host test`
Expected: FAIL — `hostPrivateTools` unknown option / `callHostTool` not a function.

- [ ] **Step 3: Add `hostPrivateTools` to `McpHostOptions`**

In `packages/mcp-host/src/host.ts`, add to the `McpHostOptions` interface (after `injectArgs`):

```typescript
	/** Namespaced tool names that must NOT be advertised to the model (excluded from
	 * registerDelegatedTools) but remain callable by the harness via callHostTool.
	 * Generic: the host hardcodes no tool/server name; ezio config supplies the list. */
	hostPrivateTools?: string[];
```

- [ ] **Step 4: Partition private tools in `start()`**

In `host.ts`, replace the tool-collection loop body inside `start()`:

```typescript
				for (const def of await client.listTools()) {
					const name = this.routes.add(server.name, def.name);
					const namespaced = { ...def, name };
					this.defsByName.set(name, namespaced);
					if (!(this.opts.hostPrivateTools ?? []).includes(name)) defs.push(namespaced);
				}
```

(Only the final line changes: host-private tools are still added to `routes`/`defsByName` but excluded from `defs`.)

- [ ] **Step 5: Add the `callHostTool` method**

In `host.ts`, add this public method (e.g. after `handleEvent`):

```typescript
	/** Harness-private MCP call: invoke a tool directly, WITHOUT advertising it to the
	 * model or riding the tool_call_requested path. For tools listed in
	 * `hostPrivateTools` (e.g. cortex__capture_session). Policy `deny` still blocks;
	 * the standalone `confirm` prompt is skipped (host-initiated calls are trusted). */
	async callHostTool(
		name: string,
		args: Record<string, unknown>,
	): Promise<{ output: string; status: "ok" | "error" }> {
		const route = this.routes.resolve(name);
		if (!route) throw new Error(`unknown host tool: ${name}`);
		if (decidePolicy(name, this.opts.toolPolicy, this.opts.mode) === "deny")
			throw new Error(`host tool "${name}" is blocked by policy`);
		const client = this.clients.get(route.server);
		if (!client) throw new Error(`server "${route.server}" unavailable`);
		const injected = this.injectCwd(name, args);
		return withTimeout(
			client.callTool(route.tool, injected),
			this.opts.callTimeoutMs ?? 60_000,
			`host call ${name}`,
		);
	}
```

- [ ] **Step 6: Run the host-private test to verify it passes**

Run: `pnpm -F @ai-ezio/mcp-host test`
Expected: PASS (the `host.ts` seam works). Now wire it through config + the host factory so
the DELIVERED product marks `cortex__capture_session` private BY DEFAULT — otherwise the
option exists but nothing sets it, and the cortex tool would still be advertised.

- [ ] **Step 7: Add a default-private list to `policy.ts` and export it**

In `packages/mcp-host/src/policy.ts`, add:

```typescript
/** Tools the host invokes itself and must NEVER advertise to the model (capture is a
 * harness lifecycle action, not a model capability). Merged with config `hostPrivateTools`. */
export const DEFAULT_HOST_PRIVATE: readonly string[] = ["cortex__capture_session"];
```

In `packages/mcp-host/src/index.ts`, extend the policy export line:

```typescript
export { decidePolicy, DEFAULT_DENY, DEFAULT_HOST_PRIVATE } from "./policy.js";
```

- [ ] **Step 8: Carry `hostPrivateTools` in `HostConfig` + parse it**

In `packages/mcp-host/src/config.ts`, add `hostPrivateTools` to the interface and parser.

Interface:

```typescript
export interface HostConfig {
	servers: ServerConfig[];
	toolPolicy: Record<string, ToolPolicy>;
	hostPrivateTools: string[];
}
```

`parseConfig` — update the empty return, the `raw` type, and the populated return:

```typescript
	if (!text || !text.trim()) return { servers: [], toolPolicy: {}, hostPrivateTools: [] };
	const raw = JSON.parse(text) as {
		mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
		toolPolicy?: Record<string, ToolPolicy>;
		hostPrivateTools?: string[];
	};
	const servers: ServerConfig[] = Object.entries(raw.mcpServers ?? {}).map(([name, s]) => ({
		name,
		command: s.command,
		args: s.args ?? [],
		env: s.env,
	}));
	return { servers, toolPolicy: raw.toolPolicy ?? {}, hostPrivateTools: raw.hostPrivateTools ?? [] };
```

`loadConfig`'s catch — update the fallback:

```typescript
	} catch {
		return { servers: [], toolPolicy: {}, hostPrivateTools: [] };
	}
```

- [ ] **Step 9: Thread the merged list through `attach.ts`**

In `packages/mcp-host/src/attach.ts`, import the default and pass the merged set into `McpHost`:

```typescript
import { DEFAULT_HOST_PRIVATE } from "./policy.js";

export function createMcpHost(cfg: HostConfig, opts: CreateHostOptions): McpHost {
	return new McpHost({
		mode: opts.mode,
		cwd: opts.cwd ?? process.cwd(),
		servers: cfg.servers,
		toolPolicy: cfg.toolPolicy,
		hostPrivateTools: [...new Set([...DEFAULT_HOST_PRIVATE, ...cfg.hostPrivateTools])],
		confirm: opts.confirm,
		connect: opts.connect,
	});
}
```

- [ ] **Step 10: Write the wired-default test** (proves the DELIVERED host keeps capture private)

Create `packages/mcp-host/src/attach.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { createMcpHost } from "./attach.js";
import { parseConfig } from "./config.js";
import type { McpClient } from "./mcp-client.js";
import type { DelegatedToolDef } from "@ai-ezio/protocol";

describe("createMcpHost host-private default", () => {
	it("keeps cortex__capture_session OUT of the delegated set by default", async () => {
		const registered: DelegatedToolDef[][] = [];
		const session = {
			registerDelegatedTools: (d: DelegatedToolDef[]) => void registered.push(d),
			sendToolResult: vi.fn(),
		};
		const client: McpClient = {
			listTools: async () => [
				{ name: "recall_memory", description: "", parametersSchema: { type: "object" } },
				{ name: "capture_session", description: "", parametersSchema: { type: "object" } },
			],
			callTool: async () => ({ output: "", status: "ok" as const }),
			close: async () => {},
		};
		const host = createMcpHost(
			{ servers: [{ name: "cortex", command: "x", args: [] }], toolPolicy: {}, hostPrivateTools: [] },
			{ mode: "mounted", cwd: "/repo", connect: async () => client },
		);
		await host.start(session);

		const advertised = registered.flat().map((d) => d.name);
		expect(advertised).toContain("cortex__recall_memory");
		expect(advertised).not.toContain("cortex__capture_session");
	});

	it("parseConfig carries hostPrivateTools (defaults to [])", () => {
		expect(parseConfig(undefined).hostPrivateTools).toEqual([]);
		expect(parseConfig(JSON.stringify({ hostPrivateTools: ["x__y"] })).hostPrivateTools).toEqual(["x__y"]);
	});
});
```

- [ ] **Step 11: Run the mcp-host tests**

Run: `pnpm -F @ai-ezio/mcp-host test`
Expected: PASS (host-private seam + wired default + config parsing).

- [ ] **Step 12: Commit**

```bash
git add packages/mcp-host/src/host.ts packages/mcp-host/src/policy.ts packages/mcp-host/src/config.ts packages/mcp-host/src/attach.ts packages/mcp-host/src/index.ts packages/mcp-host/src/host-private.test.ts packages/mcp-host/src/attach.test.ts
git commit -m "feat(mcp-host): host-private tools (filter, callHostTool, config + default wiring)"
```

---

## Task 9: cortex — `capture_session` MCP tool (cross-repo: ai-cortex)

**Files:**
- Modify: `/Users/vuphan/Dev/ai-cortex/src/mcp/server.ts` (after the `extract_session` registration, ~line 1603)
- Test: `/Users/vuphan/Dev/ai-cortex/src/lib/history/projection-evidence.test.ts`

> Cross-repo. Run cortex's own toolchain in `/Users/vuphan/Dev/ai-cortex`. Keep the tool
> signature stable so the parallel incremental-capture (Lever B) work can swap only the
> body of `captureSession`. Mirrors the existing `extract_session` registration
> (`server.ts:1554`): `server.registerTool(name, { description, inputSchema }, logged(...))`,
> with `rkFromWorktree`, `NO_STATS_PARAMS`, and `withRepoIdentity` already in scope.

- [ ] **Step 1: Write the failing round-trip test** (ezio's projection shape → cortex's REAL parser + evidence; spec §6)

```typescript
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTranscript, extractEvidence } from "./compact.js";

// This transcript is BYTE-FOR-BYTE what ezio's CortexSessionSink/renderCortexLines emits
// (packages/session-recorder/src/cortex-projection.ts): a user line, then an assistant
// line whose content is [text, tool_use{name,input}…]. The round-trip proves cortex's
// real parser+evidence layer extracts the prompts/tools/paths the recorder depends on.
function ezioProjection(): string {
	return (
		[
			JSON.stringify({ type: "user", turn: 0, message: { content: [{ type: "text", text: "analyze auth" }] } }),
			JSON.stringify({
				type: "assistant",
				turn: 1,
				message: {
					content: [
						{ type: "text", text: "reading" },
						{ type: "tool_use", name: "Read", input: { file_path: "src/auth.ts" } },
						{ type: "tool_use", name: "bash", input: "grep -n token src/auth.ts" },
					],
				},
			}),
		].join("\n") + "\n"
	);
}

describe("ezio projection → cortex evidence", () => {
	it("extracts user prompts, tool calls, and file paths via the real parser", () => {
		const dir = mkdtempSync(join(tmpdir(), "cortex-ev-"));
		const file = join(dir, "t.jsonl");
		writeFileSync(file, ezioProjection());
		const ev = extractEvidence(parseTranscript(file));
		expect(ev.userPrompts.map((u) => u.text)).toContain("analyze auth");
		expect(ev.toolCalls.map((t) => t.name)).toEqual(expect.arrayContaining(["Read", "bash"]));
		expect(ev.filePaths.map((f) => f.path)).toContain("src/auth.ts");
	});
});
```

> Confirm `parseTranscript` + `extractEvidence` are exported from
> `src/lib/history/compact.js` (they are — imported by `capture.ts:15-20`). This is the
> assertion the reviewer requires: cortex's real evidence layer, not a JSON-shape check.
> Keep the fixture identical to `renderCortexLines` output so this stays a true round-trip.

- [ ] **Step 2: Run the test to verify it fails, then passes once asserted**

Run (in ai-cortex): `pnpm vitest run src/lib/history/projection-evidence.test.ts`
Expected: PASS — the projected shape yields the expected evidence from cortex's real parser.

- [ ] **Step 3: Register the `capture_session` tool** — insert in `server.ts` immediately after the `extract_session` block (after `server.ts:1603`)

```typescript
	server.registerTool(
		"capture_session",
		{
			description:
				"Capture a host-written transcript JSONL into the session history cache (parse → evidence → chunks → extractor). Host-agnostic: any host that writes a Claude-format transcript can call it.",
			inputSchema: {
				worktreePath: z.string().describe("Absolute path to a directory inside the project's git worktree. The server derives the repo identity from this path."),
				sessionId: z.string().min(1),
				transcriptPath: z.string().min(1).describe("Absolute path to the transcript JSONL the host wrote."),
				embed: z.boolean().optional(),
			},
		},
		logged(
			"capture_session",
			(p) => ({ worktreePath: p.worktreePath, sessionId: p.sessionId }),
			NO_STATS_PARAMS,
			rkFromWorktree,
			(r) => {
				try {
					const m = JSON.parse((r as { content: { text: string }[] }).content[0].text) as {
						turnsProcessed?: unknown;
					};
					const n =
						typeof m.turnsProcessed === "number" && Number.isFinite(m.turnsProcessed)
							? m.turnsProcessed
							: 0;
					return { result_count: n };
				} catch {
					return { result_count: 0 };
				}
			},
			async (p) =>
				withRepoIdentity(p.worktreePath, async (repoKey) => {
					const { captureSession } = await import("../lib/history/capture.js");
					const result = await captureSession({
						repoKey,
						sessionId: p.sessionId,
						transcriptPath: p.transcriptPath,
						embed: p.embed !== false,
					});
					return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
				}),
		),
	);
```

- [ ] **Step 4: Build cortex to verify the registration type-checks**

Run (in ai-cortex): `pnpm build`
Expected: PASS. If `rkFromWorktree` / `NO_STATS_PARAMS` / `logged` / `withRepoIdentity` aren't visible at this point in the file, confirm they're module-level (they are — `server.ts:221`, used by `extract_session`).

- [ ] **Step 5: Commit (in ai-cortex)**

```bash
cd /Users/vuphan/Dev/ai-cortex
git add src/mcp/server.ts src/lib/history/projection-evidence.test.ts
git commit -m "feat(mcp): host-agnostic capture_session tool + projection evidence round-trip"
```

---

## Task 10: Startup recovery sweep

**Files:**
- Create: `packages/session-recorder/src/recovery.ts`
- Test: `packages/session-recorder/src/recovery.test.ts`

cortex's `captureSession` is idempotent (`up-to-date` short-circuits when there are no
new turns and on-disk state is complete), so re-triggering capture for every on-disk
projection at startup safely closes the gap left by a crash before a final capture.

- [ ] **Step 1: Write the failing test**

```typescript
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { recoverUncaptured } from "./recovery.js";

describe("recoverUncaptured", () => {
	it("triggers capture_session once per on-disk projection file", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "ezio-recover-"));
		const dir = join(stateDir, "sessions", "repo");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "s1-0.cortex.jsonl"), "{}\n");
		writeFileSync(join(dir, "s1-1.cortex.jsonl"), "{}\n");
		writeFileSync(join(dir, "notes.txt"), "ignore me\n");

		const callHostTool = vi.fn().mockResolvedValue({ output: "{}", status: "ok" });
		await recoverUncaptured({ host: { callHostTool }, stateDir, repoKey: "repo", worktreePath: "/repo" });

		const captured = callHostTool.mock.calls.map((c) => (c[1] as { sessionId: string }).sessionId).sort();
		expect(captured).toEqual(["s1-0", "s1-1"]);
		expect(callHostTool).toHaveBeenCalledWith("cortex__capture_session", {
			worktreePath: "/repo",
			sessionId: "s1-0",
			transcriptPath: join(dir, "s1-0.cortex.jsonl"),
			embed: true,
		});
	});

	it("is a no-op when the sessions dir is absent", async () => {
		const callHostTool = vi.fn();
		await recoverUncaptured({ host: { callHostTool }, stateDir: "/nonexistent-xyz", repoKey: "repo", worktreePath: "/repo" });
		expect(callHostTool).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F @ai-ezio/session-recorder test`
Expected: FAIL — `recoverUncaptured` not found.

- [ ] **Step 3: Write `recovery.ts`**

```typescript
/** Startup recovery: re-trigger capture for any on-disk cortex projection (idempotent
 * in cortex), closing the gap left by a crash before a final boundary capture. */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { HostToolCaller } from "./types.js";

export interface RecoverOptions {
	host: HostToolCaller;
	stateDir: string;
	repoKey: string;
	worktreePath: string;
	toolName?: string;
	embed?: boolean;
	warn?: (msg: string) => void;
}

const SUFFIX = ".cortex.jsonl";

export async function recoverUncaptured(opts: RecoverOptions): Promise<void> {
	const dir = join(opts.stateDir, "sessions", opts.repoKey);
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch {
		return; // no sessions dir yet
	}
	for (const f of files) {
		if (!f.endsWith(SUFFIX)) continue;
		const conversationId = f.slice(0, -SUFFIX.length);
		try {
			await opts.host.callHostTool(opts.toolName ?? "cortex__capture_session", {
				worktreePath: opts.worktreePath,
				sessionId: conversationId,
				transcriptPath: join(dir, f),
				embed: opts.embed ?? true,
			});
		} catch (e) {
			(opts.warn ?? ((m) => process.stderr.write(`${m}\n`)))(
				`cortex recovery capture failed for ${conversationId}: ${(e as Error).message}`,
			);
		}
	}
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm -F @ai-ezio/session-recorder test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/session-recorder/src/recovery.ts packages/session-recorder/src/recovery.test.ts
git commit -m "feat(session-recorder): startup recovery sweep"
```

---

## Task 11: Factory + barrel + CLI wiring

**Files:**
- Create: `packages/session-recorder/src/factory.ts`
- Modify: `packages/session-recorder/src/index.ts`
- Test: `packages/session-recorder/src/factory.test.ts`
- Modify: the CLI site that constructs `Session` (locate via `rg -n "new Session\(" packages/cli/src`)

- [ ] **Step 1: Write the failing test** (end-to-end through the factory, no real host/fs beyond tmp)

```typescript
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRecorder } from "./factory.js";

describe("createRecorder", () => {
	it("wires store + cortex sink: a completed turn writes both artifacts and a boundary captures", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "ezio-factory-"));
		const callHostTool = vi.fn().mockResolvedValue({ output: "{}", status: "ok" });
		const rec = createRecorder({
			worktreePath: "/repo",
			host: { callHostTool },
			stateDir,
			repoKey: "repo",
			everyKTurns: 100,
			idleDebounceMs: 100_000,
		});

		rec.handleEvent({ type: "ready", sessionId: "s1", protocol: "0.1.0", haxBaseCommit: "abc" });
		rec.noteSubmit("hi");
		rec.handleEvent({ type: "user_turn_started", turnId: "t1" });
		rec.handleEvent({ type: "assistant_turn_finished", turnId: "t1", content: "hello" });
		rec.handleEvent({ type: "idle" });
		rec.close();
		await Promise.resolve();

		const cortexFile = join(stateDir, "sessions", "repo", "s1-0.cortex.jsonl");
		const recordFile = join(stateDir, "sessions", "repo", "s1-0.record.jsonl");
		expect(readFileSync(cortexFile, "utf8")).toContain('"type":"user"');
		expect(readFileSync(recordFile, "utf8")).toContain('"userText":"hi"');
		expect(callHostTool).toHaveBeenCalledWith("cortex__capture_session", expect.objectContaining({ sessionId: "s1-0" }));
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm -F @ai-ezio/session-recorder test`
Expected: FAIL — `createRecorder` not found.

- [ ] **Step 3: Write `factory.ts`**

```typescript
/** Wire the durable store + cortex sink into a SessionRecorder. */
import { CortexSessionSink } from "./cortex-sink.js";
import { JsonlDurableStore } from "./durable-store.js";
import { SessionRecorder } from "./recorder.js";
import type { HostToolCaller } from "./types.js";

export interface CreateRecorderOptions {
	worktreePath: string;
	host: HostToolCaller;
	stateDir: string;
	repoKey: string;
	idleDebounceMs?: number;
	everyKTurns?: number;
	embed?: boolean;
	warn?: (msg: string) => void;
}

export function createRecorder(opts: CreateRecorderOptions): SessionRecorder {
	const store = new JsonlDurableStore({ stateDir: opts.stateDir, repoKey: opts.repoKey });
	const sink = new CortexSessionSink({
		host: opts.host,
		stateDir: opts.stateDir,
		repoKey: opts.repoKey,
		embed: opts.embed,
		warn: opts.warn,
	});
	return new SessionRecorder({
		worktreePath: opts.worktreePath,
		store,
		sink,
		idleDebounceMs: opts.idleDebounceMs,
		everyKTurns: opts.everyKTurns,
	});
}
```

- [ ] **Step 4: Write the barrel `index.ts`** (replace the placeholder)

```typescript
/** ai-ezio session recorder: protocol stream → cortex capture. */
export { SessionRecorder, sanitizeId } from "./recorder.js";
export type { RecorderOptions } from "./recorder.js";
export { CortexSessionSink } from "./cortex-sink.js";
export type { CortexSessionSinkOptions } from "./cortex-sink.js";
export { JsonlDurableStore } from "./durable-store.js";
export type { JsonlDurableStoreOptions } from "./durable-store.js";
export { renderCortexLines } from "./cortex-projection.js";
export { recoverUncaptured } from "./recovery.js";
export type { RecoverOptions } from "./recovery.js";
export { createRecorder } from "./factory.js";
export type { CreateRecorderOptions } from "./factory.js";
export { ezioStateDir, repoKeyForPath } from "./paths.js";
export type {
	ConversationRef,
	DurableStore,
	FlushReason,
	HostToolCaller,
	RecordedToolCall,
	RecordedTurn,
	SessionSink,
	TokenUsage,
} from "./types.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm -F @ai-ezio/session-recorder test`
Expected: PASS.

- [ ] **Step 6: Wire into the CLI**

Locate the `Session` construction site:

Run: `rg -n "new Session\(" packages/cli/src`

At that site (the CLI already has the `McpHost` instance — it calls `host.start(session)`),
add the recorder. Use this exact shape, adapting variable names to the file:

```typescript
import { createRecorder, ezioStateDir, repoKeyForPath, recoverUncaptured } from "@ai-ezio/session-recorder";

const cwd = process.cwd();
const stateDir = ezioStateDir();
const repoKey = repoKeyForPath(cwd);
const recorder = createRecorder({ worktreePath: cwd, host, stateDir, repoKey });

// 1. Observe every event (non-consuming tee):
const session = new Session({ onEvent: (e) => recorder.handleEvent(e) });
// ...existing start() + host.start(session)...

// 2. Record submit text authoritatively (spec §2). Wherever the CLI sends a user turn,
//    call noteSubmit FIRST so the next user_turn_started is attributed to the exact text
//    ezio sent (the protocol `user_turn_started.text` echo is only a fallback):
//        recorder.noteSubmit(text);
//        session.submit(text);              // or: await session.submitAndWait(text)

// 3. After host.start(session) succeeds, sweep any crash-orphaned projections:
await recoverUncaptured({ host, stateDir, repoKey, worktreePath: cwd });

// 4. On /new (before delegating to the engine):
//    recorder.noteNewConversation();
//    await session.newConversation();

// 5. On shutdown (and/or session.onExit):
//    recorder.close();
```

Also add the dependency to `packages/cli/package.json`: `"@ai-ezio/session-recorder": "workspace:*"`, and add `{ "path": "../session-recorder" }` to `packages/cli/tsconfig.json` references.

The `host` passed to `createRecorder` is the same `McpHost` built by `createMcpHost` / `loadMcpHost`, which now marks `cortex__capture_session` host-private **by default** (Task 8) — so capture is never advertised to the model even though the cortex MCP server lists the tool. No per-session config is required; a custom `mcp.json` may add more names via a top-level `"hostPrivateTools": [...]` array (merged with the default).

- [ ] **Step 7: Build the workspace + run all package tests**

Run: `pnpm install && pnpm -r build && pnpm -r test`
Expected: PASS across packages.

- [ ] **Step 8: Commit**

```bash
git add packages/session-recorder/src/factory.ts packages/session-recorder/src/index.ts packages/session-recorder/src/factory.test.ts packages/cli
git commit -m "feat(session-recorder): factory + CLI wiring (recorder, recovery sweep)"
```

---

## Self-Review (spec coverage)

| Spec section | Task(s) |
| --- | --- |
| §1 Architecture & boundaries (SessionRecorder / SessionSink / CortexSessionSink; new package; IDs) | 1, 2, 4, 7, 11 |
| §2 User text = the `submit` ezio sent (stashed via `noteSubmit`; the protocol echo is only a fallback) | 4 (`noteSubmit` API + correlation/precedence/fallback tests), 11 (CLI wiring records submit) |
| §2 Data model & event→turn mapping; usage persisted, omitted from projection | 2, 3, 4, 6 |
| §2 Model → cortex Claude-format projection; fidelity trade-offs | 3, 7 |
| §3 Trigger policy (append-per-turn, boundary/close/debounce/K) | 4, 5 |
| §3 Recovery sweep (in for v1) | 10, 11 |
| §4 cortex `capture_session` tool (host-agnostic, thin) | 9 |
| §4.1 Host-private MCP seam: `host.ts` filter + `callHostTool` AND config/`DEFAULT_HOST_PRIVATE`/`attach.ts` wiring so the DELIVERED host marks capture private | 8 |
| §5 Edge cases (empty/tool-only turn, interrupt/error, no-turn idle, id sanitization, capture failure swallowed, rapid overlapping triggers tolerate `skipped-locked`) | 4, 5, 7 |
| §6 Testing — recorder + submit correlation, projection shape + REAL cortex parser round-trip, trigger, boundary, recovery, host-private isolation (seam + wired default), concurrency/idempotency (overlapping `flush` + `skipped-locked`) | 3 (shape + guarded real round-trip), 4, 5 (trigger + rapid boundaries), 7 (sink + overlapping/`skipped-locked`), 8 (seam + wired default), 9 (cortex evidence round-trip), 10, 11 |

**Coordination note (Lever B):** Task 9 keeps the `capture_session({worktreePath, sessionId, transcriptPath, embed})` signature stable; the parallel incremental-capture work changes only the body of `captureSession()`, so ezio is unaffected.
