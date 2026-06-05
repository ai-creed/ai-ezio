# M8 — Mounted ezio display fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A mounted ezio pane renders like a real coding agent — assistant prose as **formatted markdown** at turn end, a **thinking spinner** while working, **tool calls** with args + output previews + **colored diffs**, a clean usage line, and a magenta `❯` prompt — all from protocol events, engine stays protocol-native.

**Architecture:** Two tiers, one merge. **Tier 1 (adapter-only):** extract a pure `mounted-renderer.ts` (+ `render-markdown.ts`) that owns all pane presentation; render markdown at turn end, add a spinner, block separators, `❯` prompt, red errors. **Tier 2 (emitter + adapter):** hax surfaces tool `args`/`output`/`isDiff` from the `agent.c` dispatch seam over optional protocol fields; the renderer draws tool blocks live. All protocol additions optional/back-compat; codex/claude + M6/M7 unchanged.

**Tech Stack:** C11 + meson + jansson (hax, 4-space indent, `clang-format -i`, SPDX); TypeScript + pnpm + vitest (protocol, adapter — tabs, double quotes, semicolons, trailing commas).

**Spec:** `/Users/vuphan/Dev/ai-ezio/docs/superpowers/specs/2026-06-05-m8-mounted-display-fidelity-design.md`

**Repos / dirs:** ai-ezio `/Users/vuphan/Dev/ai-ezio` (hax `vendor/hax`, protocol `packages/protocol`); ai-whisper `/Users/vuphan/Dev/ai-whisper` (adapter `packages/adapter-ai-ezio`).

**Verification gate (before final commit):**
- ai-ezio: `meson compile -C vendor/hax/build && meson test -C vendor/hax/build` and `pnpm -r build && pnpm -r test`
- ai-whisper: `pnpm -r build && pnpm typecheck && pnpm lint && pnpm test && pnpm run e2e:ai-ezio-mount && pnpm run e2e:ai-ezio-workflow`

---

### Task 0: Branches + baseline

- [ ] **Step 1: Branch both repos**

```sh
cd /Users/vuphan/Dev/ai-ezio && git checkout master && git pull --ff-only && git checkout -b m8-display-fidelity
cd /Users/vuphan/Dev/ai-whisper && git checkout master && git pull --ff-only && git checkout -b m8-display-fidelity
```

- [ ] **Step 2: Baseline green**

```sh
cd /Users/vuphan/Dev/ai-ezio && meson test -C vendor/hax/build && pnpm -r test
cd /Users/vuphan/Dev/ai-whisper && pnpm test
```
Expected: hax meson PASS; ai-ezio + ai-whisper vitest PASS. STOP if anything fails.

---

### Task 1: Protocol — tool args/output/isDiff (docs first) (ai-ezio)

**Files:** `docs/protocol.md`, `packages/protocol/src/events.ts`, `packages/protocol/src/codec.test.ts`

- [ ] **Step 1: Document in `docs/protocol.md` FIRST**

In the events table + a short note: `tool_call_started` gains optional `args?`
(a one-line summary of the call's arguments); `tool_call_finished` gains optional
`output?` (the tool's result text) and `isDiff?` (true when the output is a unified
diff). Note these are emitted from the engine's **tool-dispatch** path, so
`tool_call_finished.status` now reflects execution (`ok`/`error`), and both events
fire at dispatch time. All optional/back-compatible.

- [ ] **Step 2: Failing codec tests (present + absence)**

Append to `packages/protocol/src/codec.test.ts`:

```ts
describe("M8 tool fields", () => {
	it("round-trips tool args/output/isDiff", () => {
		const started = { type: "tool_call_started", turnId: "t", name: "bash", callId: "c", args: "ls -la" } satisfies ProtocolEvent;
		const finished = { type: "tool_call_finished", turnId: "t", name: "bash", callId: "c", status: "ok", output: "README.md\nsrc/", isDiff: false } satisfies ProtocolEvent;
		const d = new JsonlDecoder();
		const out = [...d.push(encodeEvent(started)), ...d.push(encodeEvent(finished))];
		expect(out[0]).toMatchObject({ type: "tool_call_started", args: "ls -la" });
		expect(out[1]).toMatchObject({ type: "tool_call_finished", output: "README.md\nsrc/", isDiff: false });
	});
	it("absence stays absent (no args/output/isDiff keys when omitted)", () => {
		const started = { type: "tool_call_started", turnId: "t", name: "bash", callId: "c" } satisfies ProtocolEvent;
		const line = encodeEvent(started);
		expect(line).not.toContain("args");
		const [dec] = new JsonlDecoder().push(line);
		expect(Object.prototype.hasOwnProperty.call(dec, "args")).toBe(false);
	});
});
```

- [ ] **Step 3: Run — expect TYPE failure**

Run: `cd /Users/vuphan/Dev/ai-ezio && pnpm --filter @ai-ezio/protocol test`
Expected: FAIL — `args`/`output`/`isDiff` not on the types (`satisfies` fails).

- [ ] **Step 4: Add the optional fields to `events.ts`**

```ts
export interface ToolCallStartedEvent {
	type: "tool_call_started";
	turnId: string;
	name: string;
	callId: string;
	/** One-line summary of the call's arguments (M8). */
	args?: string;
}

export interface ToolCallFinishedEvent {
	type: "tool_call_finished";
	turnId: string;
	name: string;
	callId: string;
	status: "ok" | "error";
	/** Tool result text (M8); absent when the engine didn't surface it. */
	output?: string;
	/** True when `output` is a unified diff (render colored) (M8). */
	isDiff?: boolean;
}
```

- [ ] **Step 5: Build + test**

Run: `pnpm --filter @ai-ezio/protocol build && pnpm --filter @ai-ezio/protocol test`
Expected: PASS.

- [ ] **Step 6: Commit (ai-ezio)**

```sh
git add docs/protocol.md packages/protocol/src/events.ts packages/protocol/src/codec.test.ts
git commit -m "M8 protocol: optional tool_call args/output/isDiff (documented first, absence covered)"
```

---

### Task 2: hax emitter — tool started/finished from dispatch (ai-ezio, C)

The tool **result**/`output_is_diff` only exist after `tool->run` in `agent.c`'s
dispatch loop (`EV_TOOL_CALL_END`'s `status:ok` means "args finalized", NOT
execution). So the tool events **move** from the stream hook to the dispatch seam.

**Files:** `vendor/hax/src/protocol/emit.h`, `vendor/hax/src/protocol/emit.c`, `vendor/hax/tests/protocol/test_emit.c`

- [ ] **Step 1: Failing C tests**

Add to `test_emit.c` (call from `main()`), modeled on the existing pipe+`read_all`+`json_loads`:

```c
/* M8: emit_tool_started carries args; emit_tool_finished carries output + isDiff. */
static void test_tool_events(void)
{
    int fds[2];
    EXPECT(pipe(fds) == 0);
    struct emit_state es;
    emit_state_init(&es, fds[1], -1);
    emit_set_turn(&es, "t1");
    emit_tool_started(&es, "bash", "c1", "ls -la");
    emit_tool_finished(&es, "bash", "c1", "ok", "README.md\nsrc/", 0);
    emit_tool_started(&es, "edit", "c2", "src/app.ts");
    emit_tool_finished(&es, "edit", "c2", "ok", "--- a\n+++ b\n", 1);
    close(fds[1]);
    char buf[4096];
    read_all(fds[0], buf, sizeof(buf));
    close(fds[0]);
    char *save = NULL;
    int started = 0, finished = 0;
    for (char *line = strtok_r(buf, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
        json_t *o = json_loads(line, 0, NULL);
        EXPECT(o != NULL);
        const char *type = json_string_value(json_object_get(o, "type"));
        if (type && strcmp(type, "tool_call_started") == 0) {
            EXPECT_STR_EQ(json_string_value(json_object_get(o, "name")), started == 0 ? "bash" : "edit");
            EXPECT(json_object_get(o, "args") != NULL);
            started++;
        }
        if (type && strcmp(type, "tool_call_finished") == 0) {
            json_t *d = json_object_get(o, "isDiff");
            EXPECT(json_object_get(o, "output") != NULL);
            EXPECT(d != NULL && json_is_boolean(d));
            EXPECT(json_boolean_value(d) == (finished == 1)); /* edit is the diff */
            finished++;
        }
        json_decref(o);
    }
    EXPECT(started == 2 && finished == 2);
}
```

- [ ] **Step 2: Compile — expect failure (undeclared functions)**

Run: `meson compile -C vendor/hax/build` → FAIL (`emit_tool_started`/`emit_tool_finished` undeclared).

- [ ] **Step 3: `emit.h` — declarations**

```c
/* M8: tool-call display, emitted from the agent's dispatch seam (after run, so
 * `output`/`isDiff` and an execution-accurate `status` are known). */
void emit_tool_started(struct emit_state *es, const char *name, const char *call_id,
                       const char *args);
void emit_tool_finished(struct emit_state *es, const char *name, const char *call_id,
                        const char *status, const char *output, int is_diff);
```

- [ ] **Step 4: `emit.c` — implement + remove the stream-hook tool emission**

Add (near `emit_status`), stamping the current turn id like the stream path does:

```c
void emit_tool_started(struct emit_state *es, const char *name, const char *call_id,
                       const char *args)
{
    if (es->event_fd < 0)
        return;
    json_t *o = json_object();
    json_object_set_new(o, "type", json_string("tool_call_started"));
    json_object_set_new(o, "turnId", json_string(es->turn_id));
    json_object_set_new(o, "name", json_string(name ? name : ""));
    json_object_set_new(o, "callId", json_string(call_id ? call_id : ""));
    if (args)
        json_object_set_new(o, "args", json_string(args));
    emit_obj(es->event_fd, o);
}

void emit_tool_finished(struct emit_state *es, const char *name, const char *call_id,
                        const char *status, const char *output, int is_diff)
{
    if (es->event_fd < 0)
        return;
    json_t *o = json_object();
    json_object_set_new(o, "type", json_string("tool_call_finished"));
    json_object_set_new(o, "turnId", json_string(es->turn_id));
    json_object_set_new(o, "name", json_string(name ? name : ""));
    json_object_set_new(o, "callId", json_string(call_id ? call_id : ""));
    json_object_set_new(o, "status", json_string(status ? status : "ok"));
    if (output)
        json_object_set_new(o, "output", json_string(output));
    /* `isDiff` is a real boolean (not an "unreported" field): a dispatch-sourced
     * tool_call_finished ALWAYS knows whether its output is a diff, so emit it as
     * true OR false. (The protocol type keeps it optional only for back-compat
     * with non-dispatch/older events.) Matches the C unit test, which asserts
     * `isDiff` is present + boolean for both the non-diff bash and the diff edit. */
    json_object_set_new(o, "isDiff", json_boolean(is_diff != 0));
    emit_obj(es->event_fd, o);
}
```

In `emit_stream_event`, **remove** the `EV_TOOL_CALL_START` and `EV_TOOL_CALL_END`
cases (they now `break;` into the `default` — no protocol event at stream time).
Then the `pending_tool_add`/`pending_tool_take` helpers + the `pending_tools`
machinery in `emit_state`/`emit_state_init` become unused — **remove them** to keep
`warning_level=3` clean (delete the two static helpers, the `EMIT_MAX_PENDING_TOOLS`
+ `pending_tools`/`n_pending_tools` fields, and their init).

- [ ] **Step 5: clang-format + compile + run emit test**

```sh
clang-format -i vendor/hax/src/protocol/emit.c vendor/hax/src/protocol/emit.h vendor/hax/tests/protocol/test_emit.c
meson compile -C vendor/hax/build && meson test -C vendor/hax/build protocol/emit
```
Expected: PASS. (Commit deferred to Task 3 — the stream-hook removal makes
`test_observer_tool_e2e` need the dispatch wiring first.)

---

### Task 3: hax agent.c — emit tool events at dispatch + engine tests (ai-ezio, C)

**Files:** `vendor/hax/src/agent.c`, `vendor/hax/tests/protocol/test_observer_tool_e2e.c`, `vendor/hax/tests/protocol/test_mount_repl.c`

- [ ] **Step 1: Emit tool events around the dispatch loop**

In `agent.c`'s tool-dispatch loop (the `for` over `sess.items[i].kind == ITEM_TOOL_CALL`
that calls `dispatch_tool_refused`/`dispatch_tool_skipped`/`dispatch_tool_call`),
emit `tool_call_started` before dispatch and `tool_call_finished` after, using the
call item's fields, the `result` output, and `find_tool(...)->output_is_diff`:

```c
                struct item result;
                const struct item *call = &sess.items[i];
                const struct tool *tdef = call->tool_name ? find_tool(call->tool_name) : NULL;
                if (obsp)
                    emit_tool_started(&emit, call->tool_name, call->call_id,
                                      tool_display_arg(tdef, call->tool_arguments_json));
                if (sess.n_tools == 0) {
                    render_transition(&r, RS_IDLE);
                    result = dispatch_tool_refused(&r, call);
                } else if (interrupt_requested()) {
                    render_transition(&r, RS_IDLE);
                    result = dispatch_tool_skipped(&r, call);
                } else {
                    result = dispatch_tool_call(&r, call);
                }
                if (obsp)
                    emit_tool_finished(&emit, call->tool_name, call->call_id,
                                       (sess.n_tools == 0 || interrupt_requested()) ? "error" : "ok",
                                       result.output, tdef && tdef->output_is_diff ? 1 : 0);
                items_append(&sess.items, &sess.n_items, &sess.cap_items, result);
```

`tool_display_arg(tdef, args_json)` extracts the human-readable arg (the
`tdef->def.display_arg` JSON field — e.g. bash's `command`) from
`tool_arguments_json`, falling back to the raw JSON. **If hax already has a helper
for this (used by `render_collapsed_tool_call`), call it; otherwise add a tiny
static helper in `agent.c`** that pulls the `display_arg` string field via jansson
and returns a malloc'd/borrowed string (free after the emit, or return a static
buffer). Confirm `find_tool` is in scope (it is used in `agent_dispatch.c`; include
its header / `tool.h` if needed).

- [ ] **Step 2: Update `test_observer_tool_e2e.c`**

The tool events now come from dispatch (not the stream hook) and carry `args`/
`output`/`isDiff`. Update its assertions: still `tool_call_started` then
`tool_call_finished` with matching name/callId and `status:"ok"` for a successful
mock bash turn, but now also assert `tool_call_started.args` is present and
`tool_call_finished.output` is present. (Timing is unchanged from the reader's view
— start before run, finish after — so the ordered-subsequence check still holds.)

- [ ] **Step 3: Extend `test_mount_repl.c` with a tool turn**

Add a third scripted turn to the mock script that issues a tool call (mock `tool`
directive runs the real tool over fds), e.g.:
```
text Looking…
tool bash {"command":"echo hi"}
end-turn
```
Drive it (submit after the prior idle, as the existing two turns do — protocol
contract). Assert the wire carries `tool_call_started{args}` then
`tool_call_finished{output, status:"ok"}` for that turn. (Use a deterministic tool
like `bash echo` so `output` is stable; `isDiff:false`.)

- [ ] **Step 4: clang-format + compile + full hax test**

```sh
clang-format -i vendor/hax/src/agent.c vendor/hax/tests/protocol/test_observer_tool_e2e.c vendor/hax/tests/protocol/test_mount_repl.c
meson compile -C vendor/hax/build && meson test -C vendor/hax/build
```
Expected: full build clean (warning_level=3, no unused-function warnings after the
pending_tool removal); ALL meson tests PASS (incl. `mount_chrome`, `observer_e2e`,
`observer_tool_e2e`, `emit`, `mount_repl`).

- [ ] **Step 5: Commit the hax submodule + bump the pointer**

```sh
cd /Users/vuphan/Dev/ai-ezio/vendor/hax
git add src/protocol/emit.c src/protocol/emit.h src/agent.c tests/protocol/test_emit.c tests/protocol/test_observer_tool_e2e.c tests/protocol/test_mount_repl.c
git commit -m "M8 emitter: tool_call_started.args + tool_call_finished.output/isDiff from the dispatch seam"
cd /Users/vuphan/Dev/ai-ezio
git add vendor/hax
git commit -m "M8: bump vendor/hax — tool args/output/isDiff from dispatch seam"
```

---

### Task 4: `render-markdown.ts` — full-text markdown → ANSI (ai-whisper)

**Files:** Create `packages/adapter-ai-ezio/src/render-markdown.ts`; Test `test/render-markdown.test.ts`

- [ ] **Step 1: Failing fixture tests**

Create `test/render-markdown.test.ts` with a case per construct, asserting the
ANSI output contains the expected codes (`\u001b[1m` bold, `\u001b[36m` cyan inline
code, `\u001b[2m` dim, etc.) and the text. Cover: H1–H3 headers, `**bold**`,
`*italic*`/`_italic_`, `` `inline code` ``, a fenced ```` ``` ```` block (dim/
indented, content preserved), `- ` and `1. ` lists (rendered with `•`/number),
`> ` blockquote, `[text](url)` link (text + dim url), plain paragraph passthrough,
and a malformed/unclosed `**` degrading to literal. Example:

```ts
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../packages/adapter-ai-ezio/src/render-markdown.ts";

it("bold + inline code + header", () => {
	const out = renderMarkdown("# Title\n\nA **bold** word and `code`.");
	expect(out).toContain("\u001b[1m"); // header/bold
	expect(out).toContain("Title");
	expect(out).toContain("\u001b[36m"); // inline code cyan
	expect(out).toContain("code");
});
it("fenced code block renders dim/indented, content preserved", () => {
	const out = renderMarkdown("```\nnpm run build\n```");
	expect(out).toContain("\u001b[2m");
	expect(out).toContain("npm run build");
});
it("list items render with a bullet", () => {
	expect(renderMarkdown("- a\n- b")).toMatch(/[•\-] a/);
});
it("plain text passes through; unclosed ** degrades", () => {
	expect(renderMarkdown("just text")).toContain("just text");
	expect(renderMarkdown("a **bad")).toContain("**bad");
});
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

- [ ] **Step 3: Implement `render-markdown.ts`**

A dependency-free `renderMarkdown(md: string): string`. Line-oriented for
block constructs (headers, fences, lists, blockquotes) + an inline pass for
bold/italic/code/links. Keep it ~200 lines, no external dep. Skeleton:

```ts
const ESC = "\u001b";
const BOLD = `${ESC}[1m`, DIM = `${ESC}[2m`, ITAL = `${ESC}[3m`, CYAN = `${ESC}[36m`, RESET = `${ESC}[0m`;

function inline(s: string): string {
	// order matters: code first (protect), then bold, then italic, then links
	return s
		.replace(/`([^`]+)`/g, `${CYAN}$1${RESET}`)
		.replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${RESET}`)
		.replace(/(?:\*|_)([^*_]+)(?:\*|_)/g, `${ITAL}$1${RESET}`)
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `$1 ${DIM}$2${RESET}`);
}

export function renderMarkdown(md: string): string {
	const lines = md.split("\n");
	const out: string[] = [];
	let inFence = false;
	for (const line of lines) {
		if (/^```/.test(line)) { inFence = !inFence; out.push(`${DIM}${line}${RESET}`); continue; }
		if (inFence) { out.push(`${DIM}  ${line}${RESET}`); continue; }
		const h = /^(#{1,6})\s+(.*)$/.exec(line);
		if (h) { out.push(`${BOLD}${inline(h[2])}${RESET}`); continue; }
		const li = /^(\s*)[-*]\s+(.*)$/.exec(line);
		if (li) { out.push(`${li[1]}• ${inline(li[2])}`); continue; }
		const ol = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
		if (ol) { out.push(`${ol[1]}${ol[2]}. ${inline(ol[3])}`); continue; }
		const bq = /^>\s?(.*)$/.exec(line);
		if (bq) { out.push(`${DIM}│ ${inline(bq[1])}${RESET}`); continue; }
		out.push(inline(line));
	}
	return out.join("\n");
}
```

(Refine the inline regexes for the "unclosed `**` degrades" case — the `[^*]+`
guard already leaves a lone `**bad` literal. Tune until the fixture tests pass.)

- [ ] **Step 4: Run tests; Commit (ai-whisper)**

```sh
pnpm vitest run test/render-markdown.test.ts   # PASS
git add packages/adapter-ai-ezio/src/render-markdown.ts test/render-markdown.test.ts
git commit -m "M8 adapter: dependency-free markdown→ANSI renderer + fixtures"
```

---

### Task 5: `mounted-renderer.ts` — the pane presentation unit (ai-whisper)

**Files:** Create `packages/adapter-ai-ezio/src/mounted-renderer.ts`; Test `test/mounted-renderer.test.ts`

- [ ] **Step 1: Failing renderer tests (the spec's exact contract)**

Create `test/mounted-renderer.test.ts`. Construct the renderer with a capturing
stdout, an injectable timer, and an injectable `utf8` flag; feed `ProtocolEvent`s;
assert stdout / side effects. REQUIRED cases (1:1 with the spec):

```ts
import { describe, expect, it, vi } from "vitest";
import { createMountedRenderer } from "../packages/adapter-ai-ezio/src/mounted-renderer.ts";

function setup(opts?: { utf8?: boolean }) {
	const writes: string[] = [];
	const stdout = { write: (s: string) => (writes.push(s), true) } as never;
	const timer = { set: vi.fn(() => 1 as never), clear: vi.fn() };
	const r = createMountedRenderer({ stdout, utf8: opts?.utf8 ?? true, setInterval: timer.set, clearInterval: timer.clear });
	return { r, out: () => writes.join(""), timer };
}
```

- **Banner once:** two `status` events → exactly one banner (`/ezio/g` length 1).
- **No-raw-delta (renderer layer):** feeding `assistant_delta` writes nothing to stdout.
- **Markdown at turn end:** `assistant_turn_finished{content:"**hi**"}` then `idle` → stdout contains the bold-rendered `hi` (`\u001b[1m`).
- **Spinner shown then cleared:** `user_turn_started` → `timer.set` called and a spinner frame written; the first output (`tool_call_started` or finished content) writes a clear sequence (`\r` + clear-line) and calls `timer.clear`.
- **Spinner idle-safety:** `user_turn_started` → `idle` asserts `timer.clear` was called and no spinner frame is written after `idle` (advance the injected timer; assert no new frame).
- **Tool rendering:** `tool_call_started{args:"ls -la"}` → `⏺ bash · ls -la`; `tool_call_finished{output:"--- a\n+ x", isDiff:true}` → green `+`/red `-` diff lines; `{output:"line1\nline2\n…", isDiff:false}` → dim truncated preview; `status:"error"` → red.
- **Usage separator:** `assistant_turn_finished{content:"x", usage:{...}}` then `idle` → the usage line is preceded by a newline (begins its own line; not glued to `x`).
- **Prompt parity:** `utf8:true` → prompt contains `❯`; a second renderer with `utf8:false` → prompt contains `>` and not `❯`.
- **Error → prompt recovery:** `error{message:"boom"}` → stdout has the red message (`\u001b[31m`) AND a trailing prompt glyph.

- [ ] **Step 2: Run — expect FAIL (module missing)**

- [ ] **Step 3: Implement `mounted-renderer.ts`**

`createMountedRenderer(input: { stdout; utf8?: boolean; setInterval?; clearInterval?; })`
returns `{ handle(event: ProtocolEvent): void }`. It owns ALL presentation; move the
M7 banner/usage/`fmtTokens` logic here (from the live-session) and add spinner,
markdown (via `renderMarkdown`), tool rendering, separators, prompt parity, errors.
Key structure:

```ts
import type { ProtocolEvent } from "@ai-ezio/protocol";
import { renderMarkdown } from "./render-markdown.js";

const ESC = "\u001b";
const PROMPT = (utf8: boolean) => (utf8 ? `${ESC}[35m${ESC}[1m❯${ESC}[0m ` : "> ");
const SPIN = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

export function createMountedRenderer(input: {
	stdout: NodeJS.WritableStream;
	utf8?: boolean;
	setInterval?: (cb: () => void, ms: number) => unknown;
	clearInterval?: (h: unknown) => void;
}) {
	const utf8 = input.utf8 ?? true;
	const setI = input.setInterval ?? ((cb, ms) => globalThis.setInterval(cb, ms));
	const clrI = input.clearInterval ?? ((h) => globalThis.clearInterval(h as never));
	const w = (s: string) => input.stdout.write(s);
	let bannerRendered = false;
	let spinH: unknown = null, spinFrame = 0, spinVisible = false;
	let lastUsage: Extract<ProtocolEvent, { type: "assistant_turn_finished" }>["usage"];
	let lastContent = "";

	const stopSpinner = () => {
		if (spinH !== null) { clrI(spinH); spinH = null; }
		if (spinVisible) { w(`\r${ESC}[2K`); spinVisible = false; }
	};
	const startSpinner = () => {
		spinFrame = 0;
		const tick = () => { w(`\r${ESC}[2K${ESC}[2m${SPIN[spinFrame++ % SPIN.length]} thinking…${ESC}[0m`); spinVisible = true; };
		tick();
		spinH = setI(tick, 80);
	};
	// fmtTokens / renderBanner / renderUsage: moved from M7 live-session (binary-k parity).
	// renderTool(started|finished): `⏺ name · args` dim line; finished → colored diff
	//   (split output on \n, green if startsWith "+", red if "-") or dim truncated
	//   preview (first N lines + "…(+M)"), status:"error" in red.
	// All block writes ensure a leading newline so blocks are separated (usage fix).

	return {
		handle(event: ProtocolEvent) {
			switch (event.type) {
				case "status": if (!bannerRendered) { /* renderBanner */ bannerRendered = true; } break;
				case "user_turn_started": startSpinner(); break;
				case "assistant_delta": break; // suppressed from the pane (relay capture handled in live-session)
				case "tool_call_started": stopSpinner(); /* renderToolStart */ break;
				case "tool_call_finished": /* renderToolFinish */ break;
				case "assistant_turn_finished":
					stopSpinner();
					lastContent = event.content; lastUsage = event.usage;
					if (lastContent) w(`\n${renderMarkdown(lastContent)}\n`);
					break;
				case "idle":
					stopSpinner();
					if (lastUsage) { /* renderUsage on its own line */ lastUsage = undefined; }
					w(`\n`); /* separator */ w(PROMPT(utf8));
					break;
				case "error": stopSpinner(); w(`\n${ESC}[31m▌ ${event.message}${ESC}[0m\n`); w(PROMPT(utf8)); break;
				default: break;
			}
		},
	};
}
```

Fill in `fmtTokens`/`renderBanner`/`renderUsage` (moved verbatim from M7, binary-k
parity) and the tool renderers; tune separators so each block starts on its own
line (fixes the M7 usage-glue bug). Ensure the spinner is never started without a
matching `stopSpinner` on every turn-ending path (`tool_call_started`,
`assistant_turn_finished`, `idle`, `error`).

- [ ] **Step 4: Run tests; build**

Run: `pnpm --filter @ai-whisper/adapter-ai-ezio build && pnpm vitest run test/mounted-renderer.test.ts` → PASS.

- [ ] **Step 5: Commit (ai-whisper)**

```sh
git add packages/adapter-ai-ezio/src/mounted-renderer.ts test/mounted-renderer.test.ts
git commit -m "M8 adapter: mounted-renderer (banner/spinner/markdown/tool/usage/prompt/errors)"
```

---

### Task 6: Refactor live-session to delegate + integration test (ai-whisper)

**Files:** `packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts`; Test `test/adapter-ai-ezio-live-session.test.ts`

- [ ] **Step 1: Failing live-session integration test (relay-capture half)**

Add to `test/adapter-ai-ezio-live-session.test.ts` — the live-session owns handlers,
so this asserts the `onProviderOutput` forwarding the renderer can't:

```ts
it("forwards assistant_delta to onProviderOutput even though the pane suppresses it (M8)", async () => {
	const f = fakeEngine();
	const got: string[] = [];
	const live = createAiEzioLiveSession({ createEngineSession: f.create, stdout: { write: () => true } as never });
	live.onProviderOutput((d) => got.push(d));
	await live.start();
	f.emit({ type: "assistant_delta", turnId: "t", text: "hello" });
	expect(got.join("")).toBe("hello"); // relay capture still receives the delta
});
```

- [ ] **Step 2: Refactor `create-ai-ezio-live-session.ts` to delegate display**

Replace the inline M7 rendering (`renderBanner`/`renderUsage`/`renderPrompt`/
`fmtTokens` + the per-event stdout writes) with a `mounted-renderer`:
- construct `const renderer = createMountedRenderer({ stdout: input.stdout });`
- in `onEvent`, FIRST forward to handlers where required (`assistant_delta` →
  `outputHandlers`; `assistant_turn_finished`/`idle` → `turnFinishedHandlers` with
  the handback content, preserving the M6 `sawTurn`/startup-idle guard), THEN call
  `renderer.handle(event)` for all display.
- Keep `start`/`stop`/`writeUserInput`/`sendLocalMessage`/`onExit`/`onProviderOutput`/
  `onTurnFinished` as-is. The live-session no longer writes assistant text/banner/
  usage/prompt itself — that's the renderer's job. `sendLocalMessage` still writes
  relay-preview text to stdout directly (unchanged).

Keep the M6 handback timing: `onTurnFinished` handlers fire on `idle` (guarded by
`sawTurn`) exactly as today, BEFORE/independently of the renderer's prompt.

- [ ] **Step 3: Run the adapter + renderer tests + typecheck**

Run: `pnpm --filter @ai-ezio/protocol build` (ensure protocol dist current) then
`pnpm install` in ai-whisper (refresh the file: dep store copy if protocol changed),
then `pnpm --filter @ai-whisper/adapter-ai-ezio build && pnpm vitest run test/adapter-ai-ezio-live-session.test.ts test/mounted-renderer.test.ts test/ai-ezio-relay-integration.test.ts && pnpm typecheck`
Expected: PASS / 0 errors. (The relay-integration test must still pass — handback
timing unchanged.)

- [ ] **Step 4: Commit (ai-whisper)**

```sh
git add packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts test/adapter-ai-ezio-live-session.test.ts
git commit -m "M8 adapter: live-session delegates display to mounted-renderer; keep handler forwarding"
```

---

### Task 7: e2e — tool line + diff in the pane (ai-whisper)

**Files:** `scripts/ai-ezio-mount-relay-e2e.mjs`

- [ ] **Step 1: Drive a tool turn + assert tool rendering**

The mount e2e mounts real ezio (`HAX_PROVIDER=mock`). Point it at a mock script
(`HAX_MOCK_SCRIPT`) whose driven turn issues a deterministic tool call with a
**unique, assertable output marker**, e.g.:
```
text Running a command…
tool bash {"command":"echo M8_TOOL_OUTPUT_MARKER"}
end-turn
```
`bash echo` produces a stable, non-diff result (`M8_TOOL_OUTPUT_MARKER`) that the
renderer draws as an output preview — so the pane must show **both** the `⏺ `
invocation line **and** the rendered output (not just the invocation line; the
spec requires asserting the diff/preview, not only the tool line). After the
handback proof + the M7 banner/prompt assertions, add:

```js
// M8: a tool call renders a `⏺ ` invocation line AND its output/diff in the pane.
// Asserting only the `⏺ ` line would pass even if output/diff rendering regressed,
// so assert the rendered tool OUTPUT (the unique marker) appears too.
if (!/⏺ /.test(mountLog)) { cleanup(); console.error("FAIL: no M8 tool invocation line\n" + mountLog.slice(-2500)); process.exit(1); }
if (!mountLog.includes("M8_TOOL_OUTPUT_MARKER")) { cleanup(); console.error("FAIL: tool output/preview not rendered in the pane (invocation line only)\n" + mountLog.slice(-2500)); process.exit(1); }
console.log("OK: M8 tool call + output rendered in the mounted ezio pane");
```

(If you prefer to additionally prove the **colored-diff** path, add a second
scripted turn with a `write`/`edit` tool and assert a `\u001b[32m`/`\u001b[31m`
diff line in `mountLog`; the `bash echo` marker above already satisfies the
spec's "tool line + preview" requirement.)

(Drive the tool turn via `HAX_MOCK_SCRIPT` in `childEnv` so the driven turn emits a
tool call. Keep it deterministic.)

- [ ] **Step 2: Build + run both e2e**

Run: `cd /Users/vuphan/Dev/ai-whisper && pnpm -r build && pnpm run e2e:ai-ezio-mount && pnpm run e2e:ai-ezio-workflow`
Expected: M7 banner/prompt OK lines + the new `OK: M8 tool call rendered…`; workflow e2e still `done`.

- [ ] **Step 3: Commit (ai-whisper)**

```sh
git add scripts/ai-ezio-mount-relay-e2e.mjs
git commit -m "M8 e2e: assert mounted ezio pane renders a tool invocation line"
```

---

### Task 8: UPSTREAM, milestone, full gate, finish

**Files:** `UPSTREAM.md`, `docs/milestones.md` (ai-ezio)

- [ ] **Step 1: `UPSTREAM.md`** — note the emitter now also emits tool events from the
  `agent.c` dispatch seam (`tool_call_started.args`, `tool_call_finished.output/isDiff`,
  execution-accurate `status`); the stream-hook tool emission + pending-tool tracking
  were removed. Still confined to `emit.{c,h}` + the dispatch loop.

- [ ] **Step 2: `docs/milestones.md`** — add `## M8 — Mounted ezio display fidelity ✅`
  summarizing markdown-at-end, spinner, tool rendering (args/output/diffs), separators,
  `❯` prompt; link this plan + the spec.

- [ ] **Step 3: Full verification gate**

```sh
cd /Users/vuphan/Dev/ai-ezio && meson compile -C vendor/hax/build && meson test -C vendor/hax/build && pnpm -r build && pnpm -r test
cd /Users/vuphan/Dev/ai-whisper && pnpm -r build && pnpm typecheck && pnpm lint && pnpm test && pnpm run e2e:ai-ezio-mount && pnpm run e2e:ai-ezio-workflow
```
Expected: all green. Fix lint inline with scoped `// eslint-disable-next-line <rule> -- <reason>` (M5–M7 precedent). Prettier repo-wide drift is pre-existing, NOT a gate; eslint is the gate.

- [ ] **Step 4: Commit docs (ai-ezio)**

```sh
cd /Users/vuphan/Dev/ai-ezio
git add UPSTREAM.md docs/milestones.md
git commit -m "M8: UPSTREAM tool-emitter note + milestone marker"
```

- [ ] **Step 5: Finish both branches**

Announce: "I'm using the finishing-a-development-branch skill to complete this work."
Then follow superpowers:finishing-a-development-branch for EACH repo (ai-ezio first
— it provides the engine/protocol the adapter builds against — then ai-whisper):
verified-green summary + merge options (M7 precedent: verify on the branch,
`git checkout master && git merge --ff-only m8-display-fidelity`, push; the hax
submodule commit goes up too). Do not merge without the full gate green. **Pin the
new hax emitter commit as the submodule base** (per `UPSTREAM.md`) and re-run
`meson test` after pinning.

---

## Edge cases & test coverage summary

- **No-raw-delta + relay capture** → split across layers: renderer test (delta
  writes nothing to stdout) + live-session test (`onProviderOutput` still receives
  the delta).
- **Spinner idle-safety** → renderer test drives `user_turn_started → idle` and
  asserts `clearInterval` called + no post-idle frame (injected timer).
- **Prompt UTF-8 + ASCII fallback** → renderer tests for `❯` (utf8 true) and `>`
  (utf8 false), via the injected `utf8` flag.
- **Error → prompt recovery** → renderer test asserts red error + trailing prompt.
- **Usage on its own line** → renderer test asserts a newline precedes the usage
  line (fixes the M7 glue bug).
- **Tool data is execution-accurate** → events come from the dispatch seam after
  `tool->run`; `status` reflects refusal/skip (`error`) vs run (`ok`); engine-level
  `test_observer_tool_e2e` + `test_mount_repl` assert args/output/isDiff over the
  real protocol.
- **Back-compat / absence** → protocol fields optional; codec absence test proves
  no `args`/`output`/`isDiff` keys when omitted.
- **M6/M7 unchanged** → both e2e (`mount` + `workflow`) in the gate; relay-integration
  + handback timing tests still pass.

## Out of scope (per spec)

Live streaming markdown; reasoning/retry/progress events; cursor-level in-place
repaint; intra-code syntax highlighting; any REPL re-enable / PTY scraping.
