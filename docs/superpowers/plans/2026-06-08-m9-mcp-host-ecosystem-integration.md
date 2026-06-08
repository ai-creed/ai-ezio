# M9 — Generic MCP Host + Unified Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ezio a generic MCP host — the model can call any configured stdio MCP server's tools (cortex first) live, mid-turn — on a unified architecture where hax is always headless and ezio (TS) always owns the terminal.

**Architecture:** hax gains one MCP-agnostic seam: "host-delegated tools" (defs registered at startup; on call, hax emits `tool_call_requested` and blocks on the control fd for a `tool_result`, interrupt- and timeout-aware). A new `@ai-ezio/mcp-host` TS package owns all MCP (spawn/connect servers, namespacing, cwd injection, policy, lifecycle). The standalone CLI is reworked to self-mount: spawn headless hax, drive a line-buffered REPL through the M7/M8 surface, with the MCP host in the loop.

**Tech Stack:** TypeScript (Node LTS, pnpm workspace, vitest, tabs/double-quotes/semicolons), C11 (hax fork, meson, jansson, clang-format 4-space), `@modelcontextprotocol/sdk`.

**Spec:** `docs/superpowers/specs/2026-06-08-m9-mcp-host-ecosystem-integration-design.md`

**Both-modes wiring (load-bearing — read before Phase 3/4):** the MCP host attaches to a `Session`, so whoever *creates* the Session attaches it. There are exactly two Session creators: (1) ezio's **standalone CLI** (Phase 4), and (2) ai-whisper's **mounted adapter** (`packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts`, which imports `@ai-ezio/harness`). Both call the **same** `loadMcpHost(...)` factory + `host.start(session)` sequence. This is why "ai-whisper unaffected" from the spec is refined to "ai-whisper adapter gains a one-line host wiring" (Task 4.3): without it, mounted ezio would have no MCP tools. The host's register-before-first-submit ordering and routing are identical in both modes; only the input source differs.

**Wire-field convention (IMPORTANT):** the existing protocol is **camelCase on the wire** (`callId`, `turnId`, `sessionId`). The spec's JSON examples used snake_case illustratively — **use camelCase** for all new fields (`callId`, `parametersSchema`). hax's `emit.c` already emits camelCase; match it.

**Phase order (each phase is independently testable / committable):**
- Phase 0 — Protocol contract first (docs + TS types + codec)
- Phase 1 — hax delegated-tool seam (C)
- Phase 2 — harness `Session` delegated-tool API
- Phase 3 — `@ai-ezio/mcp-host` package
- Phase 4 — standalone unification (line-buffered REPL + self-mount)
- Phase 5 — cortex as server #1 + end-to-end
- Phase 6 — documentation updates

**Build/test commands (memorize):**
- TS build: `pnpm -r build` · TS test: `pnpm -r --workspace-concurrency=1 test` · single pkg: `pnpm --filter @ai-ezio/<pkg> test`
- C: `meson compile -C vendor/hax/build` · `meson test -C vendor/hax/build [<name>] --print-errorlogs`
- C lint: run `clang-format -i` on any touched `.c`/`.h` before committing.

---

## Phase 0 — Protocol contract first (docs + TS types + codec)

Working-agreement #4: document protocol before code. New surface = **1 event** (`tool_call_requested`) + **2 controls** (`register_delegated_tools`, `tool_result`).

### Task 0.1: Document the new protocol surface

**Files:**
- Modify: `docs/protocol.md` (add the event + two controls to the schema sections)

- [ ] **Step 1: Add the event + controls to `docs/protocol.md`**

Find the events section and the controls section. Add, matching the existing prose/table style:

````markdown
#### `tool_call_requested` (event, hax → harness)

Emitted mid-turn **only for delegated tools** (tools registered by the host via
`register_delegated_tools`). It is the unambiguous "host, execute this and reply
with `tool_result`" signal. Display events (`tool_call_started` /
`tool_call_finished`) still fire around it for rendering; the surface renders
from those and **ignores** `tool_call_requested`.

```jsonc
{ "type": "tool_call_requested",
  "turnId": "t1", "callId": "c1",
  "name": "cortex__recall_memory",
  "args": { /* model-supplied arguments object */ } }
```

#### `register_delegated_tools` (control, harness → hax)

Sent **once, after `ready`, before the first `submit`**. Merges host-provided
tool defs into the session's advertised tool table; they serialize to the model
exactly like native tools. Defs carry no executable body — their results come
back via `tool_result`.

```jsonc
{ "type": "register_delegated_tools",
  "tools": [ { "name": "cortex__recall_memory",
               "description": "…",
               "parametersSchema": { /* JSON Schema object */ } } ] }
```

#### `tool_result` (control, harness → hax)

The host's reply to a `tool_call_requested`, correlated by `callId`.

```jsonc
{ "type": "tool_result", "callId": "c1", "output": "…", "status": "ok" } // | "error"
```

**Blocking-read contract:** after emitting `tool_call_requested`, hax blocks
reading the control fd for the matching `tool_result`. An `interrupt` arriving
instead aborts the call (`[interrupted]` result). A backstop timeout
(`AI_EZIO_DELEGATED_TIMEOUT`, default 120s) guards against a dead host. Tool
dispatch is sequential, so at most one delegated call is outstanding.
````

- [ ] **Step 2: Commit**

```bash
git add docs/protocol.md
git commit -m "docs(protocol): tool_call_requested event + register_delegated_tools/tool_result controls"
```

### Task 0.2: Add the TypeScript event + control types

**Files:**
- Modify: `packages/protocol/src/events.ts`
- Modify: `packages/protocol/src/controls.ts`
- Modify: `packages/protocol/src/index.ts` (export the new types)
- Test: `packages/protocol/src/codec.test.ts`

- [ ] **Step 1: Write the failing codec round-trip test**

Append to `packages/protocol/src/codec.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { encodeControl, encodeEvent, JsonlDecoder } from "./codec.js";
import type { ToolCallRequestedEvent } from "./events.js";
import type { RegisterDelegatedToolsControl, ToolResultControl } from "./controls.js";

describe("M9 delegated-tool protocol", () => {
	it("round-trips a tool_call_requested event", () => {
		const ev: ToolCallRequestedEvent = {
			type: "tool_call_requested",
			turnId: "t1",
			callId: "c1",
			name: "cortex__recall_memory",
			args: { query: "auth" },
		};
		const [decoded] = new JsonlDecoder().push(encodeEvent(ev));
		expect(decoded).toEqual(ev);
	});

	it("encodes register_delegated_tools and tool_result controls", () => {
		const reg: RegisterDelegatedToolsControl = {
			type: "register_delegated_tools",
			tools: [{ name: "cortex__recall_memory", description: "d", parametersSchema: { type: "object" } }],
		};
		const res: ToolResultControl = { type: "tool_result", callId: "c1", output: "ok", status: "ok" };
		expect(encodeControl(reg)).toBe(`${JSON.stringify(reg)}\n`);
		expect(encodeControl(res)).toBe(`${JSON.stringify(res)}\n`);
	});
});
```

- [ ] **Step 2: Run it; expect failure**

Run: `pnpm --filter @ai-ezio/protocol test`
Expected: FAIL — `ToolCallRequestedEvent` / `RegisterDelegatedToolsControl` / `ToolResultControl` not exported.

- [ ] **Step 3: Add the event type**

In `packages/protocol/src/events.ts`, after `ToolCallFinishedEvent` (line ~53), add:

```ts
export interface ToolCallRequestedEvent {
	type: "tool_call_requested";
	turnId: string;
	name: string;
	callId: string;
	/** Full model-supplied arguments object for the delegated tool. */
	args: Record<string, unknown>;
}
```

Add `ToolCallRequestedEvent` to the `ProtocolEvent` union (line ~96) and to `EventType` coverage (it derives automatically from the union).

- [ ] **Step 4: Add the control types**

In `packages/protocol/src/controls.ts`, after `InterruptControl` (line ~17), add:

```ts
/** One host-provided tool advertised to the model; its result comes via tool_result. */
export interface DelegatedToolDef {
	name: string;
	description: string;
	parametersSchema: Record<string, unknown>;
}

/** Sent once after `ready`, before the first `submit` (M9). */
export interface RegisterDelegatedToolsControl {
	type: "register_delegated_tools";
	tools: DelegatedToolDef[];
}

/** The host's reply to a `tool_call_requested`, correlated by callId (M9). */
export interface ToolResultControl {
	type: "tool_result";
	callId: string;
	output: string;
	status: "ok" | "error";
}
```

Add both controls to the `ProtocolControl` union (line ~38).

- [ ] **Step 5: Export the new types**

In `packages/protocol/src/index.ts`, add to the `./events.js` type export block: `ToolCallRequestedEvent`. Add to the `./controls.js` type export block: `DelegatedToolDef`, `RegisterDelegatedToolsControl`, `ToolResultControl`.

- [ ] **Step 6: Run tests; expect pass**

Run: `pnpm --filter @ai-ezio/protocol test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/protocol/src/events.ts packages/protocol/src/controls.ts packages/protocol/src/index.ts packages/protocol/src/codec.test.ts
git commit -m "feat(protocol): types for tool_call_requested + register_delegated_tools/tool_result"
```

---

## Phase 1 — hax delegated-tool seam (C)

All under `vendor/hax/`. The seam: a delegated registry, a new emit for the request, a blocking control read for the result, registration parsing, and a dispatch branch. hax learns nothing about MCP.

### Task 1.1: Emit the `tool_call_requested` event

**Files:**
- Modify: `vendor/hax/src/protocol/emit.h` (declare `emit_tool_requested`)
- Modify: `vendor/hax/src/protocol/emit.c` (implement it)
- Test: `vendor/hax/tests/test_emit.c` (add a case)

- [ ] **Step 1: Add a failing test**

In `vendor/hax/tests/test_emit.c`, mirror the existing `emit_tool_started` test. Add a test that calls `emit_tool_requested(&es, "cortex__recall_memory", "c1", "{\"query\":\"x\"}")` against an `emit_state` whose `event_fd` is a pipe, then reads the line and asserts it parses as JSON with `type == "tool_call_requested"`, `callId == "c1"`, `name == "cortex__recall_memory"`, and an `args` object equal to `{"query":"x"}`. Use the same pipe + `read` + jansson assertions the file already uses for `emit_tool_started`.

- [ ] **Step 2: Run; expect failure**

Run: `meson compile -C vendor/hax/build && meson test -C vendor/hax/build test_emit --print-errorlogs`
Expected: FAIL — `emit_tool_requested` undefined.

- [ ] **Step 3: Declare it in `emit.h`**

After the `emit_tool_started`/`emit_tool_finished` declarations (near line ~120), add:

```c
/* M9 (ai-ezio): emit `tool_call_requested` for a host-delegated tool. `args_json`
 * is the model-supplied arguments as a JSON object string; it is embedded as a
 * JSON value (parsed; empty-object fallback on parse error). */
void emit_tool_requested(struct emit_state *es, const char *name, const char *call_id,
                         const char *args_json);
```

- [ ] **Step 4: Implement it in `emit.c`**

Follow the existing emit helpers (they build a `json_t` with `json_pack`, stamp `turnId` from `es->turn_id`, write with the file's `emit_line`/`json_dumps` helper). Embed `args` by parsing `args_json` with `json_loads`, falling back to `json_object()` on error:

```c
void emit_tool_requested(struct emit_state *es, const char *name, const char *call_id,
                         const char *args_json)
{
    if (es->event_fd < 0)
        return;
    json_error_t err;
    json_t *args = args_json ? json_loads(args_json, 0, &err) : NULL;
    if (!args)
        args = json_object();
    json_t *o = json_pack("{s:s, s:s, s:s, s:s, s:o}", "type", "tool_call_requested", "turnId",
                          es->turn_id, "name", name ? name : "", "callId", call_id ? call_id : "",
                          "args", args);
    emit_json_line(es, o); /* use whatever the file's existing line-writer is named */
    json_decref(o);
}
```

Match the exact line-writer name already used by `emit_tool_started` (e.g. `emit_obj`/`write_json_line`) — read the file and reuse it; do not invent a new writer.

- [ ] **Step 5: Run; expect pass; clang-format**

Run: `clang-format -i vendor/hax/src/protocol/emit.c vendor/hax/src/protocol/emit.h && meson compile -C vendor/hax/build && meson test -C vendor/hax/build test_emit --print-errorlogs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add vendor/hax/src/protocol/emit.c vendor/hax/src/protocol/emit.h vendor/hax/tests/test_emit.c
git commit -m "feat(hax/emit): emit_tool_requested for delegated tools"
```

### Task 1.2: Parse `register_delegated_tools` + `tool_result` controls

**Files:**
- Modify: `vendor/hax/src/protocol/emit.h` (new control kind + `tool_result` reader)
- Modify: `vendor/hax/src/protocol/emit.c`
- Test: `vendor/hax/tests/test_emit.c`

- [ ] **Step 1: Failing test for control parsing**

Add a test that writes a `register_delegated_tools` JSON line into a pipe used as `control_fd`, calls `emit_read_control(&es)`, and asserts the returned `emit_control.kind == EMIT_CTL_REGISTER_DELEGATED` with a parsed tool-def array of length 1 (name/description/parametersSchema). Add a second test: write a `tool_result` line, call the new `emit_read_tool_result(&es, "c1", ...)`, assert it returns `output == "hello"`, `status == EMIT_TOOL_OK`.

- [ ] **Step 2: Run; expect failure**

Run: `meson test -C vendor/hax/build test_emit --print-errorlogs`
Expected: FAIL — new symbols undefined.

- [ ] **Step 3: Extend the control-kind enum + structs in `emit.h`**

Add `EMIT_CTL_REGISTER_DELEGATED` to `enum emit_control_kind`. Extend `struct emit_control` to carry the parsed defs:

```c
struct emit_delegated_def {
    char *name;             /* malloc'd */
    char *description;      /* malloc'd */
    char *parameters_schema_json; /* malloc'd JSON Schema string */
};

struct emit_control {
    enum emit_control_kind kind;
    char *text;                          /* SUBMIT only */
    struct emit_delegated_def *defs;     /* REGISTER_DELEGATED only; caller frees */
    size_t n_defs;
};

/* M9: result of a blocking wait for a delegated tool result. */
enum emit_tool_status { EMIT_TOOL_OK, EMIT_TOOL_ERROR, EMIT_TOOL_INTERRUPTED,
                        EMIT_TOOL_TIMEOUT, EMIT_TOOL_SHUTDOWN };
struct emit_tool_result {
    enum emit_tool_status status;
    char *output;           /* malloc'd; NULL for interrupted/timeout/shutdown */
};

/* Block reading the control fd for a `tool_result` matching `call_id`. Honors an
 * `interrupt` control (→ INTERRUPTED) and a backstop timeout in seconds (→ TIMEOUT);
 * EOF → SHUTDOWN. `register_delegated_tools` arriving here is ignored (registration
 * happens between turns only). */
struct emit_tool_result emit_read_tool_result(struct emit_state *es, const char *call_id,
                                              int timeout_secs);
void emit_delegated_defs_free(struct emit_delegated_def *defs, size_t n);
```

- [ ] **Step 4: Implement parsing + the result reader in `emit.c`**

In `emit_read_control`'s JSON dispatch (where it already branches on `type` for submit/new_conversation/status), add a `register_delegated_tools` branch that walks the `tools` array and fills `defs`/`n_defs` (`json_string_value` for name/description; `json_dumps` the `parametersSchema` object to `parameters_schema_json`). Implement `emit_read_tool_result` using the existing control-fd line-buffer machinery (`es->ctl_buf`/`ctl_len`) plus a `poll()` on `es->control_fd` with `timeout_secs * 1000` ms; on each complete line parse `type`: `tool_result` with matching `callId` → return OK/ERROR + output; `interrupt` → return INTERRUPTED; EOF (`read` == 0) → SHUTDOWN; poll timeout → TIMEOUT. Implement `emit_delegated_defs_free`.

- [ ] **Step 5: Run; expect pass; clang-format**

Run: `clang-format -i vendor/hax/src/protocol/emit.c vendor/hax/src/protocol/emit.h && meson test -C vendor/hax/build test_emit --print-errorlogs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add vendor/hax/src/protocol/emit.c vendor/hax/src/protocol/emit.h vendor/hax/tests/test_emit.c
git commit -m "feat(hax/emit): parse register_delegated_tools + blocking emit_read_tool_result"
```

### Task 1.3: Delegated registry + advertise to the model

**Files:**
- Modify: `vendor/hax/src/agent_core.h` (delegated-name set on the session, or a sidecar)
- Modify: `vendor/hax/src/agent_core.c` (helper to merge defs + test `is_delegated`)
- Test: `vendor/hax/tests/test_agent_core.c` (create if absent; else add to an existing core test)

- [ ] **Step 1: Failing test**

Write a test that builds an `agent_session` via `agent_session_init` (mock provider, non-raw), then calls `agent_session_add_delegated(&s, defs, n)` with one def `{name:"x__y", description:"d", parameters_schema_json:"{\"type\":\"object\"}"}`, and asserts: `s.n_tools` increased by 1, the new entry's `def.name == "x__y"`, and `agent_session_is_delegated(&s, "x__y") == 1` while `agent_session_is_delegated(&s, "read") == 0`.

- [ ] **Step 2: Run; expect failure**

Run: `meson test -C vendor/hax/build test_agent_core --print-errorlogs`
Expected: FAIL — symbols undefined. (If the test executable doesn't exist, add an `executable(...)`+`test(...)` pair to `vendor/hax/tests/meson.build` linking `test_agent_core.c` + `agent_core.c` + deps.)

- [ ] **Step 3: Add the delegated set to the session**

In `agent_core.h`'s `struct agent_session`, add after `n_tools`:

```c
    /* M9: names of host-delegated tools (subset of `tools`). A tool is delegated
     * when its result comes from the host over the protocol, not a local run(). */
    char **delegated_names; /* owned */
    size_t n_delegated;
```

Declare:

```c
void agent_session_add_delegated(struct agent_session *s, const struct emit_delegated_def *defs,
                                 size_t n);
int agent_session_is_delegated(const struct agent_session *s, const char *name);
```

(Include `protocol/emit.h` for `struct emit_delegated_def`, or move that struct to a shared header if a cycle appears — prefer forward-declaring and passing name/description/schema as three args if the include is awkward.)

- [ ] **Step 4: Implement in `agent_core.c`**

```c
void agent_session_add_delegated(struct agent_session *s, const struct emit_delegated_def *defs,
                                 size_t n)
{
    if (!n)
        return;
    s->tools = xrealloc(s->tools, (s->n_tools + n) * sizeof(*s->tools));
    s->delegated_names = xrealloc(s->delegated_names, (s->n_delegated + n) * sizeof(char *));
    for (size_t i = 0; i < n; i++) {
        s->tools[s->n_tools].name = xstrdup(defs[i].name);
        s->tools[s->n_tools].description = xstrdup(defs[i].description);
        s->tools[s->n_tools].parameters_schema_json = xstrdup(defs[i].parameters_schema_json);
        s->tools[s->n_tools].display_arg = NULL;
        s->n_tools++;
        s->delegated_names[s->n_delegated++] = xstrdup(defs[i].name);
    }
}

int agent_session_is_delegated(const struct agent_session *s, const char *name)
{
    if (!name)
        return 0;
    for (size_t i = 0; i < s->n_delegated; i++)
        if (strcmp(s->delegated_names[i], name) == 0)
            return 1;
    return 0;
}
```

Free `delegated_names` (and any strdup'd `tool_def` fields for delegated entries) in `agent_session_free`. Note: native `tool_def`s in `s->tools` point at static string literals (copied by value from `TOOLS[i]->def`), but delegated ones are strdup'd — track the boundary (e.g. only free `tools[i]` strings for `i >= N_native`), or always strdup in init for uniformity. Choose uniform strdup-and-free to avoid a mixed-ownership bug; adjust `agent_session_init` to strdup native def fields too if you go uniform.

- [ ] **Step 5: Run; expect pass; clang-format**

Run: `clang-format -i vendor/hax/src/agent_core.c vendor/hax/src/agent_core.h && meson test -C vendor/hax/build test_agent_core --print-errorlogs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add vendor/hax/src/agent_core.c vendor/hax/src/agent_core.h vendor/hax/tests/test_agent_core.c vendor/hax/tests/meson.build
git commit -m "feat(hax/core): delegated-tool registry on the session"
```

### Task 1.4: `dispatch_tool_delegated` helper

**Files:**
- Modify: `vendor/hax/src/agent_dispatch.c` (new helper near `dispatch_tool_skipped`)
- Modify: `vendor/hax/src/agent_dispatch.h` (declare it)
- Test: `vendor/hax/tests/test_dispatch.c` (add a case, or the existing dispatch test)

- [ ] **Step 1: Failing test (incl. output capping)**

Add a test that builds a `struct item` tool call (`kind = ITEM_TOOL_CALL`, `call_id = "c1"`, `tool_name = "x__y"`), calls `dispatch_tool_delegated(&r, &call, "host output", 0 /*ok*/)`, and asserts the returned item is `ITEM_TOOL_RESULT` with `call_id == "c1"` and `output == "host output"`. Mirror the existing `dispatch_tool_skipped` test setup for `render_ctx`.

Add a **capping** test: `setenv("HAX_TOOL_OUTPUT_CAP", "64", 1)`, build an output string longer than 64 bytes (e.g. 500 `'a'`s, with a couple of multibyte UTF-8 chars near the boundary to prove no codepoint is split), call `dispatch_tool_delegated(&r, &call, big, 0)`, and assert: (a) `strlen(result.output)` is `<= 64 + marker_len` (capped, not the full 500); (b) `result.output` contains the substring `"[delegated output truncated"`; (c) the kept prefix is valid UTF-8 (no `0x80–0xBF` continuation byte left dangling at the cut). `unsetenv` afterward.

- [ ] **Step 2: Run; expect failure**

Run: `meson test -C vendor/hax/build test_dispatch --print-errorlogs`
Expected: FAIL — `dispatch_tool_delegated` undefined.

- [ ] **Step 3: Implement the helper**

Mirror `dispatch_tool_skipped` (`agent_dispatch.c:340`), but take host-provided output and **cap it with hax's shared tool-output limit** (`output_cap_bytes()` from `util.h`, default 50K, env `HAX_TOOL_OUTPUT_CAP`) — the same ceiling native tools honor before their output enters history — and `ctrl_strip_dup` it exactly as the native path does (`agent_dispatch.c:568`/`:668`). Both helpers are already in scope in this file:

```c
/* M9: build a tool result from host-delegated output. `is_error` only affects the
 * render transition; the model sees `output` either way (errors are recoverable
 * tool output, same convention as native tools). The output is capped to hax's
 * shared tool-output limit so a huge MCP result can't blow up model context. */
struct item dispatch_tool_delegated(struct render_ctx *r, const struct item *call,
                                    const char *output, int is_error)
{
    render_transition(r, RS_IDLE);
    (void)is_error;

    const char *raw = output ? output : "";
    size_t cap = output_cap_bytes();
    char *capped;
    if (strlen(raw) > cap) {
        size_t n = cap;
        /* Back off so the cut never splits a UTF-8 multibyte sequence. */
        while (n > 0 && ((unsigned char)raw[n] & 0xC0) == 0x80)
            n--;
        capped = xasprintf("%.*s\n[delegated output truncated to %zu bytes]", (int)n, raw, cap);
    } else {
        capped = xstrdup(raw);
    }
    char *history = ctrl_strip_dup(capped); /* strip control bytes, native parity */
    free(capped);

    return (struct item){
        .kind = ITEM_TOOL_RESULT,
        .call_id = xstrdup(call->call_id),
        .output = history,
    };
}
```

Ensure `#include "util.h"` is present (for `output_cap_bytes`/`xasprintf`/`ctrl_strip_dup`/`xstrdup`); `agent_dispatch.c` already uses `ctrl_strip_dup`, so it is. Declare `dispatch_tool_delegated` in `agent_dispatch.h` beside `dispatch_tool_skipped`/`dispatch_tool_refused`.

- [ ] **Step 4: Run; expect pass; clang-format**

Run: `clang-format -i vendor/hax/src/agent_dispatch.c vendor/hax/src/agent_dispatch.h && meson test -C vendor/hax/build test_dispatch --print-errorlogs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vendor/hax/src/agent_dispatch.c vendor/hax/src/agent_dispatch.h vendor/hax/tests/test_dispatch.c
git commit -m "feat(hax/dispatch): dispatch_tool_delegated builds a result from host output"
```

### Task 1.5: Wire registration + the delegated dispatch branch into the agent loop

**Files:**
- Modify: `vendor/hax/src/agent.c` (control loop ~976; dispatch loop ~1197)
- Test: `vendor/hax/tests/test_delegated_e2e.c` (new; register in `tests/meson.build`)

- [ ] **Step 1: Failing end-to-end test (mock provider)**

Create `vendor/hax/tests/test_delegated_e2e.c` modeled on `test_mount_repl.c` / `test_observer_tool_e2e.c`. It drives a real hax session with `HAX_PROVIDER=mock` and a mock script that, on the first turn, emits a tool call to `x__y`. The test, over the control fd: (1) after `ready`, sends `register_delegated_tools` advertising `x__y`; (2) sends `submit`; (3) expects to read a `tool_call_requested` event for `x__y`; (4) replies with a `tool_result {callId, output:"DELEGATED-OK", status:"ok"}`; (5) asserts the turn completes and the transcript/`assistant_turn_finished` reflects that the tool ran (e.g. the mock echoes the tool result). Add a second case: reply with `interrupt` instead → assert the turn ends with an interrupted/aborted result, no hang. Add a third: never reply, set `AI_EZIO_DELEGATED_TIMEOUT=1` → assert the turn ends within ~1s with an error result (no deadlock).

Register the executable+test in `vendor/hax/tests/meson.build` (link `agent.c`, `agent_dispatch.c`, `agent_core.c`, `protocol/emit.c`, mock provider, deps — copy the link list from `test_mount_repl`).

- [ ] **Step 2: Run; expect failure**

Run: `meson compile -C vendor/hax/build && meson test -C vendor/hax/build test_delegated_e2e --print-errorlogs`
Expected: FAIL — registration ignored / `tool_call_requested` never emitted / hangs (kill via the test's own timeout guard).

- [ ] **Step 3: Handle `register_delegated_tools` in the between-turns control loop**

In `agent.c` around the `emit_read_control` switch (lines 976–990), add a branch before the `EMIT_CTL_SUBMIT` handling:

```c
if (ctl.kind == EMIT_CTL_REGISTER_DELEGATED) {
    agent_session_add_delegated(&sess, ctl.defs, ctl.n_defs);
    /* Rebuild the provider-facing tool view if the agent caches it. The render
     * ctx built at lines ~899-906 reads sess.tools/sess.n_tools by pointer, but
     * if any cached copy exists, refresh it here. */
    emit_delegated_defs_free(ctl.defs, ctl.n_defs);
    continue; /* keep reading controls; registration precedes the first submit */
}
```

Confirm the surrounding loop is a `for(;;)`/`while` that `continue` returns to the `emit_read_control` call; if it is a flat sequence, restructure minimally so registration loops back to read the next control. Note the `struct render_ctx` at lines ~899–906 holds `.tools = sess.tools, .n_tools = sess.n_tools` **by value at construction** — ensure the value used when building the provider request reflects the post-registration `sess.tools/n_tools`. Since registration happens before the first submit (before the first turn builds its request), reading `sess.n_tools` at request-build time picks up the additions; verify the request build path reads the live session fields, not a stale snapshot. If it snapshots, move the snapshot to after the control loop settles on a `submit`.

- [ ] **Step 4: Add the delegated branch to the dispatch loop**

In the tool-execution loop (`agent.c:1197–1232`), branch before the existing `sess.n_tools == 0` / `interrupt_requested` / `dispatch_tool_call` ladder:

```c
} else if (agent_session_is_delegated(&sess, call->tool_name)) {
    /* Host-delegated: emit the request, block for the host's result. The display
     * tool_call_started/_finished still bracket this (emitted at 1209/1227). */
    emit_tool_requested(&emit, call->tool_name, call->call_id, call->tool_arguments_json);
    int tmo = 120;
    const char *tmo_env = getenv("AI_EZIO_DELEGATED_TIMEOUT");
    if (tmo_env && *tmo_env)
        tmo = atoi(tmo_env);
    struct emit_tool_result tr = emit_read_tool_result(&emit, call->call_id, tmo);
    switch (tr.status) {
    case EMIT_TOOL_OK:
        result = dispatch_tool_delegated(&r, call, tr.output, 0);
        break;
    case EMIT_TOOL_ERROR:
        result = dispatch_tool_delegated(&r, call, tr.output, 1);
        break;
    case EMIT_TOOL_INTERRUPTED:
        result = dispatch_tool_skipped(&r, call); /* [interrupted] result */
        break;
    case EMIT_TOOL_TIMEOUT:
        result = dispatch_tool_delegated(&r, call, "delegated tool timed out", 1);
        break;
    case EMIT_TOOL_SHUTDOWN:
        result = dispatch_tool_delegated(&r, call, "host disconnected", 1);
        break;
    }
    free(tr.output);
}
```

Place this branch so the existing `emit_tool_started` (1209) fires before it and `emit_tool_finished` (1227) fires after with `result.output`. Confirm `refused_or_skipped` is computed as today; delegated calls are neither refused nor skipped, so `emit_tool_finished` reports `status` from the dispatch result (use `"ok"` for OK, `"error"` otherwise — adjust the existing `emit_tool_finished` status arg accordingly for the delegated branch).

- [ ] **Step 5: Run; expect pass; clang-format**

Run: `clang-format -i vendor/hax/src/agent.c && meson compile -C vendor/hax/build && meson test -C vendor/hax/build --print-errorlogs`
Expected: PASS (the new e2e + the full suite — confirm native-tool behavior unchanged: `test_observer_tool_e2e`, `test_mount_repl` still green).

- [ ] **Step 6: Commit**

```bash
git add vendor/hax/src/agent.c vendor/hax/tests/test_delegated_e2e.c vendor/hax/tests/meson.build
git commit -m "feat(hax/agent): register delegated tools + delegated dispatch round-trip"
```

---

## Phase 2 — harness `Session` delegated-tool API

**Files map:** `packages/harness/src/session.ts` gains `registerDelegatedTools()` + `sendToolResult()`; consumers catch `tool_call_requested` via the existing `onEvent` tee.

### Task 2.1: `registerDelegatedTools` + `sendToolResult` on `Session`

**Files:**
- Modify: `packages/harness/src/session.ts`
- Test: `packages/harness/src/session.delegated.test.ts` (new)

- [ ] **Step 1: Failing test (against a fake transport)**

Create `packages/harness/src/session.delegated.test.ts`. Use the same fake-transport / fake-spawn approach the existing `session.*.test.ts` files use (read `packages/harness/src/spawn-call.test.ts` and any `session.*.test.ts` to copy the fixture). Assert:

```ts
import { describe, expect, it } from "vitest";
// import the test's existing Session harness helpers / fake transport

it("sends register_delegated_tools as a control", async () => {
	const { session, sentControls } = await startFakeSession(); // helper per existing tests
	session.registerDelegatedTools([
		{ name: "cortex__recall_memory", description: "d", parametersSchema: { type: "object" } },
	]);
	expect(sentControls).toContainEqual({
		type: "register_delegated_tools",
		tools: [{ name: "cortex__recall_memory", description: "d", parametersSchema: { type: "object" } }],
	});
});

it("sends tool_result as a control", async () => {
	const { session, sentControls } = await startFakeSession();
	session.sendToolResult("c1", "out", "ok");
	expect(sentControls).toContainEqual({ type: "tool_result", callId: "c1", output: "out", status: "ok" });
});
```

If no reusable fake-session helper exists, add a minimal one in the test that injects a fake `Transport` capturing `send()` calls (the `Session` constructs `FdTransport` from streams in `start`; for unit purposes, expose a seam or construct around a fake — follow whatever the existing tests do; do not change production wiring just for tests if a fixture already exists).

- [ ] **Step 2: Run; expect failure**

Run: `pnpm --filter @ai-ezio/harness test`
Expected: FAIL — methods undefined.

- [ ] **Step 3: Implement the methods**

In `session.ts`, import `DelegatedToolDef` from `@ai-ezio/protocol`, and add after `interrupt()` (line ~170):

```ts
/** Advertise host-provided tools to the engine. Call once after `start()`'s
 * `ready` resolves and BEFORE the first submit, so the first turn sees them. */
registerDelegatedTools(tools: DelegatedToolDef[]): void {
	this.control({ type: "register_delegated_tools", tools });
}

/** Reply to a `tool_call_requested` (correlated by callId). */
sendToolResult(callId: string, output: string, status: "ok" | "error"): void {
	this.control({ type: "tool_result", callId, output, status });
}
```

- [ ] **Step 4: Run; expect pass**

Run: `pnpm --filter @ai-ezio/harness test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/harness/src/session.ts packages/harness/src/session.delegated.test.ts
git commit -m "feat(harness): Session.registerDelegatedTools + sendToolResult"
```

---

## Phase 3 — `@ai-ezio/mcp-host` package

A new package owning all MCP. Files split by responsibility:
- `src/config.ts` — load + validate `mcp.json`
- `src/policy.ts` — per-tool allow/deny/confirm decision
- `src/namespace.ts` — `<server>__<tool>` encode/decode + routing map
- `src/mcp-client.ts` — `McpClient` interface + `StdioMcpClient` (SDK) impl
- `src/host.ts` — wires `Session` ↔ clients (register, route, lifecycle)
- `src/index.ts` — barrel

### Task 3.1: Scaffold the package

**Files:**
- Create: `packages/mcp-host/package.json`, `packages/mcp-host/tsconfig.json`, `packages/mcp-host/src/index.ts`, `packages/mcp-host/vitest.config.ts` (if siblings use one)

- [ ] **Step 1: Create `package.json`**

Copy the shape of `packages/harness/package.json` (name `@ai-ezio/mcp-host`, `type: module`, `test: vitest run`, build via project references). Add deps: `@ai-ezio/protocol`, `@ai-ezio/harness`, `@modelcontextprotocol/sdk`. Add `@ai-ezio/mcp-host` to the root `tsconfig` references and ensure pnpm picks it up (it matches `packages/*`).

- [ ] **Step 2: Create `tsconfig.json`**

Copy `packages/harness/tsconfig.json`, adjusting `references` to `../protocol` and `../harness`.

- [ ] **Step 3: Minimal barrel + install**

`src/index.ts`: `export {};` placeholder. Run:

```bash
pnpm install
pnpm -r build
```

Expected: workspace resolves `@ai-ezio/mcp-host` and `@modelcontextprotocol/sdk`; build passes.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-host package.json pnpm-lock.yaml tsconfig.json
git commit -m "chore(mcp-host): scaffold @ai-ezio/mcp-host package"
```

### Task 3.2: Namespacing

**Files:**
- Create: `packages/mcp-host/src/namespace.ts`
- Test: `packages/mcp-host/src/namespace.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { encodeToolName, RouteMap } from "./namespace.js";

describe("namespace", () => {
	it("encodes <server>__<tool>", () => {
		expect(encodeToolName("cortex", "recall_memory")).toBe("cortex__recall_memory");
	});
	it("routes a namespaced name back to (server, tool)", () => {
		const map = new RouteMap();
		map.add("cortex", "recall_memory");
		expect(map.resolve("cortex__recall_memory")).toEqual({ server: "cortex", tool: "recall_memory" });
		expect(map.resolve("unknown__x")).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run; expect failure**

Run: `pnpm --filter @ai-ezio/mcp-host test`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
/** Advertised name for a server's tool. Tool names may themselves contain "__";
 * RouteMap resolves by exact registered key, so collisions across servers can't
 * mis-route (first writer wins; log on collision at the call site). */
export function encodeToolName(server: string, tool: string): string {
	return `${server}__${tool}`;
}

export interface Route {
	server: string;
	tool: string;
}

export class RouteMap {
	private readonly map = new Map<string, Route>();
	add(server: string, tool: string): string {
		const name = encodeToolName(server, tool);
		if (!this.map.has(name)) this.map.set(name, { server, tool });
		return name;
	}
	resolve(name: string): Route | undefined {
		return this.map.get(name);
	}
	names(): string[] {
		return [...this.map.keys()];
	}
}
```

- [ ] **Step 4: Run; expect pass**

Run: `pnpm --filter @ai-ezio/mcp-host test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-host/src/namespace.ts packages/mcp-host/src/namespace.test.ts
git commit -m "feat(mcp-host): tool namespacing + route map"
```

### Task 3.3: Config loader

**Files:**
- Create: `packages/mcp-host/src/config.ts`
- Test: `packages/mcp-host/src/config.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { parseConfig, configPath } from "./config.js";

describe("config", () => {
	it("parses servers + tool policy", () => {
		const cfg = parseConfig(
			JSON.stringify({
				mcpServers: { cortex: { command: "ai-cortex", args: ["mcp"] } },
				toolPolicy: { cortex__purge_memory: "deny" },
			}),
		);
		expect(cfg.servers).toEqual([{ name: "cortex", command: "ai-cortex", args: ["mcp"], env: undefined }]);
		expect(cfg.toolPolicy.cortex__purge_memory).toBe("deny");
	});
	it("returns empty config for missing/blank input", () => {
		expect(parseConfig(undefined).servers).toEqual([]);
	});
	it("derives path from XDG_CONFIG_HOME", () => {
		expect(configPath({ XDG_CONFIG_HOME: "/x" })).toBe("/x/ai-ezio/mcp.json");
		expect(configPath({ HOME: "/home/u" })).toBe("/home/u/.config/ai-ezio/mcp.json");
	});
});
```

- [ ] **Step 2: Run; expect failure**

Run: `pnpm --filter @ai-ezio/mcp-host test`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ToolPolicy = "allow" | "deny" | "confirm";

export interface ServerConfig {
	name: string;
	command: string;
	args: string[];
	env?: Record<string, string>;
}

export interface HostConfig {
	servers: ServerConfig[];
	toolPolicy: Record<string, ToolPolicy>;
}

/** `${XDG_CONFIG_HOME:-$HOME/.config}/ai-ezio/mcp.json` — matches the skills-dir convention. */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	const base = env.XDG_CONFIG_HOME?.trim() || join(env.HOME ?? "", ".config");
	return join(base, "ai-ezio", "mcp.json");
}

export function parseConfig(text: string | undefined): HostConfig {
	if (!text || !text.trim()) return { servers: [], toolPolicy: {} };
	const raw = JSON.parse(text) as {
		mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
		toolPolicy?: Record<string, ToolPolicy>;
	};
	const servers: ServerConfig[] = Object.entries(raw.mcpServers ?? {}).map(([name, s]) => ({
		name,
		command: s.command,
		args: s.args ?? [],
		env: s.env,
	}));
	return { servers, toolPolicy: raw.toolPolicy ?? {} };
}

/** Load from disk; returns the empty config if the file is absent. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): HostConfig {
	try {
		return parseConfig(readFileSync(configPath(env), "utf8"));
	} catch {
		return { servers: [], toolPolicy: {} };
	}
}
```

- [ ] **Step 4: Run; expect pass**

Run: `pnpm --filter @ai-ezio/mcp-host test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-host/src/config.ts packages/mcp-host/src/config.test.ts
git commit -m "feat(mcp-host): mcp.json config loader"
```

### Task 3.4: Permission policy

**Files:**
- Create: `packages/mcp-host/src/policy.ts`
- Test: `packages/mcp-host/src/policy.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from "vitest";
import { decidePolicy, DEFAULT_DENY } from "./policy.js";

describe("policy", () => {
	it("denies the default destructive set", () => {
		expect(DEFAULT_DENY).toContain("cortex__purge_memory");
		expect(decidePolicy("cortex__purge_memory", {}, "mounted")).toBe("deny");
	});
	it("allows read-ish tools by default", () => {
		expect(decidePolicy("cortex__recall_memory", {}, "mounted")).toBe("allow");
	});
	it("config overrides defaults", () => {
		expect(decidePolicy("cortex__recall_memory", { cortex__recall_memory: "deny" }, "mounted")).toBe("deny");
	});
	it("confirm degrades to deny in mounted, stays confirm in standalone", () => {
		const pol = { cortex__trash_memory: "confirm" as const };
		expect(decidePolicy("cortex__trash_memory", pol, "mounted")).toBe("deny");
		expect(decidePolicy("cortex__trash_memory", pol, "standalone")).toBe("confirm");
	});
});
```

- [ ] **Step 2: Run; expect failure**

Run: `pnpm --filter @ai-ezio/mcp-host test`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import type { ToolPolicy } from "./config.js";

export type RunMode = "standalone" | "mounted";

/** Conservative default deny-list (curate later per spec). */
export const DEFAULT_DENY: readonly string[] = [
	"cortex__purge_memory",
	"cortex__trash_memory",
	"cortex__promote_to_global",
];

/** Resolve the effective policy for a namespaced tool. Config wins; otherwise the
 * default deny-list applies, else allow. `confirm` only has teeth in standalone
 * (a human is present); in mounted it degrades to deny. */
export function decidePolicy(
	name: string,
	configPolicy: Record<string, ToolPolicy>,
	mode: RunMode,
): ToolPolicy {
	const base: ToolPolicy = configPolicy[name] ?? (DEFAULT_DENY.includes(name) ? "deny" : "allow");
	if (base === "confirm" && mode === "mounted") return "deny";
	return base;
}
```

- [ ] **Step 4: Run; expect pass**

Run: `pnpm --filter @ai-ezio/mcp-host test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-host/src/policy.ts packages/mcp-host/src/policy.test.ts
git commit -m "feat(mcp-host): config-driven allow/deny/confirm policy"
```

### Task 3.5: `McpClient` interface + stdio implementation

**Files:**
- Create: `packages/mcp-host/src/mcp-client.ts`
- Test: `packages/mcp-host/src/mcp-client.test.ts`

- [ ] **Step 1: Failing test (against the interface, using a fake)**

```ts
import { describe, expect, it } from "vitest";
import { mapToolResult, type McpToolResult } from "./mcp-client.js";

describe("mapToolResult", () => {
	it("joins text content blocks", () => {
		const r: McpToolResult = { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] };
		expect(mapToolResult(r)).toEqual({ output: "a\nb", status: "ok" });
	});
	it("maps isError to status error", () => {
		const r: McpToolResult = { content: [{ type: "text", text: "boom" }], isError: true };
		expect(mapToolResult(r)).toEqual({ output: "boom", status: "error" });
	});
	it("stringifies non-text blocks", () => {
		const r: McpToolResult = { content: [{ type: "image", data: "..." } as never] };
		expect(mapToolResult(r).status).toBe("ok");
	});
});
```

- [ ] **Step 2: Run; expect failure**

Run: `pnpm --filter @ai-ezio/mcp-host test`
Expected: FAIL.

- [ ] **Step 3: Implement the interface + mapping + stdio client**

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { DelegatedToolDef } from "@ai-ezio/protocol";
import type { ServerConfig } from "./config.js";

export interface McpToolResult {
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
}

/** MCP content blocks → the string the model sees + an ok/error status. */
export function mapToolResult(r: McpToolResult): { output: string; status: "ok" | "error" } {
	const output = r.content
		.map((b) => (b.type === "text" && b.text != null ? b.text : JSON.stringify(b)))
		.join("\n");
	return { output, status: r.isError ? "error" : "ok" };
}

export interface McpClient {
	/** List tools as delegated defs (un-namespaced tool name in `name`). */
	listTools(): Promise<DelegatedToolDef[]>;
	callTool(tool: string, args: Record<string, unknown>): Promise<{ output: string; status: "ok" | "error" }>;
	close(): Promise<void>;
}

/** Spawn + connect a stdio MCP server. */
export async function connectStdio(server: ServerConfig, connectTimeoutMs = 10_000): Promise<McpClient> {
	const transport = new StdioClientTransport({
		command: server.command,
		args: server.args,
		env: server.env,
	});
	const client = new Client({ name: "ai-ezio", version: "0.1.0" }, { capabilities: {} });
	await withTimeout(client.connect(transport), connectTimeoutMs, `connect ${server.name}`);
	return {
		async listTools() {
			const res = await client.listTools();
			return res.tools.map((t) => ({
				name: t.name,
				description: t.description ?? "",
				parametersSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object" },
			}));
		},
		async callTool(tool, args) {
			const res = (await client.callTool({ name: tool, arguments: args })) as McpToolResult;
			return mapToolResult(res);
		},
		async close() {
			await client.close();
		},
	};
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
	]);
}
```

(Verify the exact SDK import paths/method names against the installed `@modelcontextprotocol/sdk` version — `listTools()`/`callTool()` shapes are stable, but adjust the subpath imports if the package exports differ.)

**Output capping is hax's job, not the host's.** `mapToolResult` returns the full joined text; the engine caps it to `output_cap_bytes()` (`HAX_TOOL_OUTPUT_CAP`) inside `dispatch_tool_delegated` (Task 1.4) — the same limit native tools use. Do **not** also truncate here, so there's one cap with one configurable limit (double-capping would hide the truncation marker and diverge from native behavior).

- [ ] **Step 4: Run; expect pass**

Run: `pnpm --filter @ai-ezio/mcp-host test`
Expected: PASS (the `mapToolResult` unit tests; `connectStdio` is exercised via the host integration test in 3.6/Phase 5).

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-host/src/mcp-client.ts packages/mcp-host/src/mcp-client.test.ts
git commit -m "feat(mcp-host): McpClient interface + stdio client + result mapping"
```

### Task 3.6: The host — wire `Session` ↔ clients

**Files:**
- Create: `packages/mcp-host/src/host.ts`
- Modify: `packages/mcp-host/src/index.ts` (export public surface)
- Test: `packages/mcp-host/src/host.test.ts`

- [ ] **Step 1: Failing test (fake Session + fake clients)**

```ts
import { expect, it, vi } from "vitest";
import { McpHost } from "./host.js";
import type { McpClient } from "./mcp-client.js";

// Tools declare a schema (properties) so cwd-injection can be schema-aware.
function fakeClient(
	tools: Array<{ name: string; props?: string[] }>,
	onCall: (t: string, a: Record<string, unknown>) => { output: string; status: "ok" | "error" } | Promise<never>,
): McpClient {
	return {
		listTools: async () =>
			tools.map((t) => ({
				name: t.name,
				description: "",
				parametersSchema: {
					type: "object",
					properties: Object.fromEntries((t.props ?? []).map((p) => [p, { type: "string" }])),
				},
			})),
		callTool: async (t, a) => onCall(t, a) as { output: string; status: "ok" | "error" },
		close: async () => {},
	};
}

function fakeSession() {
	const registered: unknown[] = [];
	const results: Array<[string, string, string]> = [];
	return {
		registered,
		results,
		session: {
			registerDelegatedTools: (t: unknown) => registered.push(t),
			sendToolResult: (id: string, out: string, st: string) => results.push([id, out, st]),
		},
	};
}

it("registers namespaced tools and routes a call, injecting cwd from schema", async () => {
	const fx = fakeSession();
	const host = new McpHost({
		mode: "mounted", cwd: "/repo", toolPolicy: {},
		servers: [{ name: "cortex", command: "x", args: [] }],
		connect: async () =>
			fakeClient([{ name: "recall_memory", props: ["query", "worktreePath"] }], (t, a) => ({
				output: `called ${t} ${JSON.stringify(a)}`,
				status: "ok",
			})),
	});
	await host.start(fx.session as never);
	expect((fx.registered[0] as Array<{ name: string }>)[0].name).toBe("cortex__recall_memory");

	await host.handleEvent({ type: "tool_call_requested", turnId: "t", callId: "c1", name: "cortex__recall_memory", args: { query: "x" } });
	expect(fx.results[0]).toEqual(["c1", `called recall_memory {"query":"x","worktreePath":"/repo"}`, "ok"]);
});

it("overrides model-supplied worktreePath AND path (no drift)", async () => {
	const fx = fakeSession();
	let seen: Record<string, unknown> = {};
	const host = new McpHost({
		mode: "mounted", cwd: "/repo", toolPolicy: {},
		servers: [{ name: "cortex", command: "x", args: [] }],
		connect: async () =>
			fakeClient([{ name: "suggest_files", props: ["task", "path", "worktreePath"] }], (_t, a) => {
				seen = a;
				return { output: "ok", status: "ok" };
			}),
	});
	await host.start(fx.session as never);
	await host.handleEvent({
		type: "tool_call_requested", turnId: "t", callId: "c1", name: "cortex__suggest_files",
		args: { task: "auth", path: "/evil", worktreePath: "/evil" },
	});
	expect(seen.path).toBe("/repo");
	expect(seen.worktreePath).toBe("/repo");
});

it("does NOT add an injected arg the tool's schema lacks", async () => {
	const fx = fakeSession();
	let seen: Record<string, unknown> = {};
	const host = new McpHost({
		mode: "mounted", cwd: "/repo", toolPolicy: {},
		servers: [{ name: "stub", command: "x", args: [] }],
		connect: async () =>
			fakeClient([{ name: "ping", props: ["msg"] }], (_t, a) => {
				seen = a;
				return { output: "ok", status: "ok" };
			}),
	});
	await host.start(fx.session as never);
	await host.handleEvent({ type: "tool_call_requested", turnId: "t", callId: "c1", name: "stub__ping", args: { msg: "hi" } });
	expect("worktreePath" in seen).toBe(false);
	expect("path" in seen).toBe(false);
});

it("denies a policy-blocked tool without calling the server", async () => {
	const fx = fakeSession();
	const call = vi.fn();
	const host = new McpHost({
		mode: "mounted", cwd: "/repo", toolPolicy: { cortex__purge_memory: "deny" },
		servers: [{ name: "cortex", command: "x", args: [] }],
		connect: async () => fakeClient([{ name: "purge_memory" }], () => { call(); return { output: "x", status: "ok" }; }),
	});
	await host.start(fx.session as never);
	await host.handleEvent({ type: "tool_call_requested", turnId: "t", callId: "c2", name: "cortex__purge_memory", args: {} });
	expect(call).not.toHaveBeenCalled();
	expect(fx.results[0][2]).toBe("error");
	expect(fx.results[0][1]).toMatch(/blocked|denied|policy/i);
});

it("returns an error tool_result when the server call rejects (crash) — no missing reply", async () => {
	const fx = fakeSession();
	const host = new McpHost({
		mode: "mounted", cwd: "/repo", toolPolicy: {},
		servers: [{ name: "cortex", command: "x", args: [] }],
		connect: async () => fakeClient([{ name: "recall_memory", props: ["worktreePath"] }], () => Promise.reject(new Error("server died"))),
	});
	await host.start(fx.session as never);
	await host.handleEvent({ type: "tool_call_requested", turnId: "t", callId: "c3", name: "cortex__recall_memory", args: {} });
	expect(fx.results[0][0]).toBe("c3");
	expect(fx.results[0][2]).toBe("error");
	expect(fx.results[0][1]).toMatch(/failed|died/i);
});

it("returns an error tool_result when a call exceeds the per-call timeout (before hax backstop)", async () => {
	const fx = fakeSession();
	const host = new McpHost({
		mode: "mounted", cwd: "/repo", toolPolicy: {}, callTimeoutMs: 20,
		servers: [{ name: "cortex", command: "x", args: [] }],
		connect: async () => fakeClient([{ name: "recall_memory", props: ["worktreePath"] }], () => new Promise(() => {}) as Promise<never>),
	});
	await host.start(fx.session as never);
	await host.handleEvent({ type: "tool_call_requested", turnId: "t", callId: "c4", name: "cortex__recall_memory", args: {} });
	expect(fx.results[0][2]).toBe("error");
	expect(fx.results[0][1]).toMatch(/timed out|failed/i);
});
```

- [ ] **Step 2: Run; expect failure**

Run: `pnpm --filter @ai-ezio/mcp-host test`
Expected: FAIL — `McpHost` missing.

- [ ] **Step 3: Implement `host.ts`**

```ts
import type { DelegatedToolDef, ProtocolEvent } from "@ai-ezio/protocol";
import type { Session } from "@ai-ezio/harness";
import { decidePolicy, type RunMode } from "./policy.js";
import type { ToolPolicy } from "./config.js";
import { RouteMap } from "./namespace.js";
import { connectStdio, type McpClient } from "./mcp-client.js";
import type { ServerConfig } from "./config.js";

export interface McpHostOptions {
	mode: RunMode;
	cwd: string;
	servers: ServerConfig[];
	toolPolicy: Record<string, ToolPolicy>;
	/** Repo-root arg names forced to cwd (default ["worktreePath","path"] — the
	 * ai-* convention). Drift-proof: overrides model-supplied values. */
	injectArgs?: string[];
	/** Per-call timeout; the host ALWAYS replies before hax's 120s backstop. Default 60s. */
	callTimeoutMs?: number;
	/** Injectable for tests; defaults to stdio connect. */
	connect?: (server: ServerConfig) => Promise<McpClient>;
	/** One-line warnings surfaced ONLY on failure (per spec). Defaults to stderr. */
	warn?: (msg: string) => void;
	/** Standalone-only confirm prompt; returns true to allow. */
	confirm?: (name: string) => Promise<boolean>;
}

export class McpHost {
	private readonly routes = new RouteMap();
	private readonly clients = new Map<string, McpClient>();
	/** Namespaced name → def (for schema-aware cwd injection). */
	private readonly defsByName = new Map<string, DelegatedToolDef>();
	private session?: Pick<Session, "registerDelegatedTools" | "sendToolResult">;

	constructor(private readonly opts: McpHostOptions) {}

	/** Connect servers, list tools, register with the session. Failures are
	 * surfaced as one-line warnings; the host continues with whatever connected. */
	async start(session: Pick<Session, "registerDelegatedTools" | "sendToolResult">): Promise<void> {
		this.session = session;
		const connect = this.opts.connect ?? connectStdio;
		const defs = [];
		for (const server of this.opts.servers) {
			try {
				const client = await connect(server);
				this.clients.set(server.name, client);
				for (const def of await client.listTools()) {
					const name = this.routes.add(server.name, def.name);
					const namespaced = { ...def, name };
					this.defsByName.set(name, namespaced);
					defs.push(namespaced);
				}
			} catch (e) {
				this.warn(`mcp: server "${server.name}" failed to connect: ${(e as Error).message}`);
			}
		}
		if (defs.length) session.registerDelegatedTools(defs);
	}

	/** Feed every protocol event here (wire as Session.onEvent). Acts only on
	 * tool_call_requested. */
	async handleEvent(event: ProtocolEvent): Promise<void> {
		if (event.type !== "tool_call_requested") return;
		const { callId, name, args } = event;
		const route = this.routes.resolve(name);
		if (!route) return this.reply(callId, `unknown tool: ${name}`, "error");

		const policy = decidePolicy(name, this.opts.toolPolicy, this.opts.mode);
		if (policy === "deny") return this.reply(callId, `tool "${name}" is blocked by policy`, "error");
		if (policy === "confirm") {
			const ok = this.opts.confirm ? await this.opts.confirm(name) : false;
			if (!ok) return this.reply(callId, `tool "${name}" was not confirmed`, "error");
		}

		const client = this.clients.get(route.server);
		if (!client) return this.reply(callId, `server "${route.server}" unavailable`, "error");
		try {
			const injected = this.injectCwd(name, args);
			const res = await withTimeout(
				client.callTool(route.tool, injected),
				this.opts.callTimeoutMs ?? 60_000,
				`call ${name}`,
			);
			this.reply(callId, res.output, res.status);
		} catch (e) {
			// Covers BOTH a per-call timeout AND a crashed/hung/down server: the host
			// ALWAYS replies, so hax never reaches its 120s backstop and never hangs.
			this.warn(`mcp: call ${name} failed: ${(e as Error).message}`);
			this.reply(callId, `tool call failed: ${(e as Error).message}`, "error");
		}
	}

	/** Force repo-root args (worktreePath/path) to the session cwd. Overrides any
	 * model-supplied value (drift-proof) AND fills when omitted — but ONLY for args
	 * the tool's own schema declares, so we never add a property the server would
	 * reject and never clobber an unrelated `path`. */
	private injectCwd(name: string, args: Record<string, unknown>): Record<string, unknown> {
		const schema = this.defsByName.get(name)?.parametersSchema as
			| { properties?: Record<string, unknown> }
			| undefined;
		const props = schema?.properties ?? {};
		const injectArgs = this.opts.injectArgs ?? ["worktreePath", "path"];
		const out = { ...args };
		for (const arg of injectArgs) if (arg in props) out[arg] = this.opts.cwd;
		return out;
	}

	private reply(callId: string, output: string, status: "ok" | "error"): void {
		this.session?.sendToolResult(callId, output, status);
	}

	private warn(msg: string): void {
		(this.opts.warn ?? ((m) => process.stderr.write(`${m}\n`)))(msg);
	}

	async stop(): Promise<void> {
		for (const c of this.clients.values()) await c.close().catch(() => {});
		this.clients.clear();
	}
}

/** Reject after `ms` so a hung/crashed server can't stall the host (and thus
 * never reaches hax's backstop). */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
	]);
}
```

Export `McpHost`, `loadConfig`, `parseConfig`, types from `src/index.ts`.

- [ ] **Step 4: Run; expect pass**

Run: `pnpm --filter @ai-ezio/mcp-host test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-host/src/host.ts packages/mcp-host/src/index.ts packages/mcp-host/src/host.test.ts
git commit -m "feat(mcp-host): McpHost wires Session <-> MCP servers (register, route, policy, cwd-inject)"
```

### Task 3.7: Shared `loadMcpHost` factory (the single both-modes entry point)

Both Session creators (standalone CLI + mounted adapter) must build the host the same way. Factor that into one helper so the two call sites stay one line each and behave identically.

**Files:**
- Create: `packages/mcp-host/src/attach.ts`
- Modify: `packages/mcp-host/src/index.ts` (export `createMcpHost`, `loadMcpHost`)
- Test: `packages/mcp-host/src/attach.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { expect, it } from "vitest";
import { createMcpHost } from "./attach.js";
import type { McpClient } from "./mcp-client.js";

it("builds a host from an explicit config and registers tools in mounted mode", async () => {
	const registered: unknown[] = [];
	const session = { registerDelegatedTools: (t: unknown) => registered.push(t), sendToolResult: () => {} };
	const fake: McpClient = {
		listTools: async () => [{ name: "recall_memory", description: "", parametersSchema: { type: "object" } }],
		callTool: async () => ({ output: "", status: "ok" }),
		close: async () => {},
	};
	const host = createMcpHost(
		{ servers: [{ name: "cortex", command: "x", args: [] }], toolPolicy: {} },
		{ mode: "mounted", cwd: "/repo", connect: async () => fake },
	);
	await host.start(session as never);
	expect((registered[0] as Array<{ name: string }>)[0].name).toBe("cortex__recall_memory");
});

it("builds a no-op host (no servers) when config is empty", async () => {
	const registered: unknown[] = [];
	const session = { registerDelegatedTools: (t: unknown) => registered.push(t), sendToolResult: () => {} };
	const host = createMcpHost({ servers: [], toolPolicy: {} }, { mode: "standalone", cwd: "/repo" });
	await host.start(session as never);
	expect(registered).toEqual([]); // nothing registered → native behavior unchanged
});
```

- [ ] **Step 2: Run; expect failure**

Run: `pnpm --filter @ai-ezio/mcp-host test`
Expected: FAIL — `createMcpHost` missing.

- [ ] **Step 3: Implement `attach.ts`**

```ts
import { McpHost } from "./host.js";
import { loadConfig, type HostConfig, type ServerConfig } from "./config.js";
import type { McpClient } from "./mcp-client.js";
import type { RunMode } from "./policy.js";

export interface CreateHostOptions {
	mode: RunMode;
	cwd?: string;
	/** Standalone-only confirm prompt. */
	confirm?: (name: string) => Promise<boolean>;
	/** Injectable connect (tests). */
	connect?: (server: ServerConfig) => Promise<McpClient>;
}

/** Build an MCP host from an explicit config (pure — no disk). */
export function createMcpHost(cfg: HostConfig, opts: CreateHostOptions): McpHost {
	return new McpHost({
		mode: opts.mode,
		cwd: opts.cwd ?? process.cwd(),
		servers: cfg.servers,
		toolPolicy: cfg.toolPolicy,
		confirm: opts.confirm,
		connect: opts.connect,
	});
}

/** Build an MCP host from `mcp.json` on disk (the both-modes entry point). The
 * caller MUST: (1) construct the Session with onEvent fanning to host.handleEvent,
 * (2) await session.start(), (3) `await host.start(session)` BEFORE the first
 * submit so the first turn sees the tools. */
export function loadMcpHost(opts: CreateHostOptions & { env?: NodeJS.ProcessEnv }): McpHost {
	return createMcpHost(loadConfig(opts.env ?? process.env), opts);
}
```

- [ ] **Step 4: Export + run; expect pass**

Add `createMcpHost`, `loadMcpHost`, `CreateHostOptions` to `src/index.ts`.
Run: `pnpm --filter @ai-ezio/mcp-host test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-host/src/attach.ts packages/mcp-host/src/index.ts packages/mcp-host/src/attach.test.ts
git commit -m "feat(mcp-host): loadMcpHost/createMcpHost factory shared by both run modes"
```

---

## Phase 4 — standalone unification (line-buffered REPL + self-mount)

Rework the CLI so a human running `ai-ezio` drives headless hax through the surface + MCP host. The reference line-buffered reader is ai-whisper's `live-session.ts feedLineBufferedInput`.

### Task 4.1: Line-buffered input reader

**Files:**
- Create: `packages/cli/src/repl/input-reader.ts`
- Test: `packages/cli/src/repl/input-reader.test.ts`

- [ ] **Step 1: Failing test (pure reducer over keystrokes)**

```ts
import { describe, expect, it } from "vitest";
import { feedKey, newLineBuffer } from "./input-reader.js";

describe("line buffer", () => {
	it("accumulates printable chars and submits on Enter", () => {
		let b = newLineBuffer();
		for (const ch of "hello") b = feedKey(b, ch).buffer;
		const out = feedKey(b, "\r");
		expect(out.submit).toBe("hello");
		expect(out.buffer.text).toBe("");
	});
	it("backspace removes the last char", () => {
		let b = newLineBuffer();
		for (const ch of "abc") b = feedKey(b, ch).buffer;
		b = feedKey(b, "").buffer;
		expect(b.text).toBe("ab");
	});
	it("Ctrl-C signals interrupt, Ctrl-D signals eof", () => {
		expect(feedKey(newLineBuffer(), "").signal).toBe("interrupt");
		expect(feedKey(newLineBuffer(), "").signal).toBe("eof");
	});
});
```

- [ ] **Step 2: Run; expect failure**

Run: `pnpm --filter @ai-ezio/cli test`
Expected: FAIL.

- [ ] **Step 3: Implement the pure reducer**

```ts
export interface LineBuffer {
	text: string;
}
export function newLineBuffer(): LineBuffer {
	return { text: "" };
}

export interface KeyResult {
	buffer: LineBuffer;
	/** Set when Enter completed a line. */
	submit?: string;
	/** Out-of-band signals. */
	signal?: "interrupt" | "eof";
	/** Echo to write to the terminal (printable char or erase sequence). */
	echo?: string;
}

/** Reduce one decoded key against the buffer. Mirrors ai-whisper's
 * feedLineBufferedInput: backspace, Ctrl-C, Ctrl-D, Enter, printable. */
export function feedKey(buffer: LineBuffer, ch: string): KeyResult {
	if (ch === "") return { buffer, signal: "interrupt" };
	if (ch === "") return { buffer, signal: "eof" };
	if (ch === "\r" || ch === "\n") return { buffer: { text: "" }, submit: buffer.text, echo: "\r\n" };
	if (ch === "" || ch === "") {
		if (!buffer.text) return { buffer };
		return { buffer: { text: buffer.text.slice(0, -1) }, echo: "\b \b" };
	}
	// Ignore other control chars; echo printable.
	if (ch < " " && ch !== "\t") return { buffer };
	return { buffer: { text: buffer.text + ch }, echo: ch };
}
```

- [ ] **Step 4: Run; expect pass**

Run: `pnpm --filter @ai-ezio/cli test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/repl/input-reader.ts packages/cli/src/repl/input-reader.test.ts
git commit -m "feat(cli): line-buffered input reducer (ported from ai-whisper)"
```

### Task 4.2: Self-mount standalone REPL

**Files:**
- Create: `packages/cli/src/repl/standalone.ts`
- Modify: `packages/cli/src/cli.ts` (route the interactive path to `runStandaloneRepl`; keep `-p` and mounted/native paths)
- Test: `packages/cli/src/repl/standalone.test.ts` (drive with a fake stdin + fake Session + fake host)

- [ ] **Step 1: Failing test (no real tty, no real hax)**

Drive `runStandaloneRepl` with injected seams: a fake `readKeys` async-iterable yielding `"h","i","\r"` then `""`; a fake `Session` whose `submitAndWait` resolves and records the submitted text; a fake surface sink capturing writes; assert the session received `submit("hi")` and the loop exits cleanly on Ctrl-D.

```ts
import { describe, expect, it } from "vitest";
import { runStandaloneRepl } from "./standalone.js";

it("submits a typed line and exits on Ctrl-D", async () => {
	const submitted: string[] = [];
	const keys = (async function* () {
		for (const k of ["h", "i", "\r", ""]) yield k;
	})();
	const session = {
		submit: (t: string) => submitted.push(t),
		interrupt: () => {},
		waitForEvent: async () => ({ type: "idle" }),
		close: () => {},
	};
	await runStandaloneRepl({
		keys,
		session: session as never,
		host: { handleEvent: async () => {}, stop: async () => {} } as never,
		write: () => {},
	});
	expect(submitted).toEqual(["hi"]);
});
```

- [ ] **Step 2: Run; expect failure**

Run: `pnpm --filter @ai-ezio/cli test`
Expected: FAIL.

- [ ] **Step 3: Implement `runStandaloneRepl`**

```ts
import type { Session } from "@ai-ezio/harness";
import type { McpHost } from "@ai-ezio/mcp-host";
import { feedKey, newLineBuffer } from "./input-reader.js";

export interface StandaloneReplDeps {
	keys: AsyncIterable<string>;
	session: Pick<Session, "submit" | "interrupt" | "waitForEvent" | "close">;
	host: Pick<McpHost, "handleEvent" | "stop">;
	write: (s: string) => void;
}

/** The human REPL loop over headless hax. Output is rendered elsewhere (surface
 * subscribed via Session.onEvent); this owns input → submit + lifecycle. */
export async function runStandaloneRepl(deps: StandaloneReplDeps): Promise<void> {
	let buffer = newLineBuffer();
	for await (const ch of deps.keys) {
		const r = feedKey(buffer, ch);
		buffer = r.buffer;
		if (r.echo) deps.write(r.echo);
		if (r.signal === "eof") break;
		if (r.signal === "interrupt") {
			deps.session.interrupt();
			continue;
		}
		if (r.submit !== undefined) {
			deps.session.submit(r.submit);
			// Wait for the turn to settle before reading the next line. The surface
			// renders streamed events live via Session.onEvent; idle = prompt again.
			await deps.session.waitForEvent("idle");
		}
	}
	await deps.host.stop();
	deps.session.close();
}
```

- [ ] **Step 4: Wire the real assembly in `cli.ts`**

Add a `runStandalone(argv)` that, in this order: (1) `const host = loadMcpHost({ mode: "standalone", cwd: process.cwd(), confirm: terminalConfirm })` (built but not started); (2) constructs a `Session` with `onEvent` fanned to BOTH the M7/M8 surface renderer (from `@ai-ezio/surface`) and `(e) => void host.handleEvent(e)`; (3) `await session.start({ args })` (spawns headless hax via the harness, which already passes `--mount-mode`); (4) `await host.start(session)` **before** enabling input (so the first turn sees the tools); (5) sets `process.stdin.setRawMode(true)` and adapts stdin to an async `keys` iterable (decode chunks → chars); (6) `await runStandaloneRepl({...})`. Provide `terminalConfirm(name)` that prints a y/N prompt and reads one key (standalone-only; mounted degrades `confirm`→`deny` in policy). In `main()`, route to `runStandalone` when the invocation is interactive (not `wantsVersionJson`, not `isNativeSubcommand`, not `-p` one-shot, not an explicit mounted invocation). Keep `-p` one-shot using a single `session.submitAndWait(prompt)` then print `content` — and wire `loadMcpHost`+`host.start` there too so `-p` also gets memory.

**Note on `isMountInvocation`:** a raw `ai-ezio --mount-mode --protocol-fd=.. --control-fd=..` forwarded straight to hax (the old `mountStdio` path) is a transparent fd bridge that creates **no** `Session`, so it cannot host MCP. Mounted ezio under ai-whisper does NOT use this path — it imports `@ai-ezio/harness` and creates a Session in the adapter (wired in Task 4.3). Leave the raw forward path as-is (a no-MCP escape hatch) and document it as such; the both-modes MCP guarantee is delivered by the two Session creators (standalone here + adapter in 4.3).

- [ ] **Step 5: Run; expect pass**

Run: `pnpm --filter @ai-ezio/cli test && pnpm -r build`
Expected: PASS + build green. Manual smoke (optional, requires a real provider key): `node packages/cli/dist/cli.js` → type a prompt → see it run; Ctrl-D exits.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/repl/standalone.ts packages/cli/src/cli.ts packages/cli/src/repl/standalone.test.ts packages/cli/package.json
git commit -m "feat(cli): self-mount standalone REPL (headless hax + surface + mcp-host)"
```

### Task 4.3: Mounted-mode wiring (ai-whisper adapter) — close the both-modes gap

The mounted Session is created by ai-whisper's adapter, so the host must be attached there too. This is the **one-line** ai-whisper touch the spec's "ai-whisper unaffected" did not account for; without it mounted ezio has no MCP tools.

**Repo:** ai-whisper (`~/Dev/ai-whisper`). **Files:**
- Modify: `packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts`
- Test: `packages/adapter-ai-ezio/src/create-ai-ezio-live-session.mcp.test.ts` (new)

- [ ] **Step 1: Failing mounted-ordering test**

In the adapter test, drive the live-session factory with a fake `Session` (capturing `registerDelegatedTools`/`sendToolResult`/submit order) and a fake `connect` yielding one tool. Assert that, on mount start, `registerDelegatedTools` is called **before** the first `submit` is possible (i.e. `host.start` is awaited during session start-up), and that a `tool_call_requested` event routed through the adapter's event handler produces a `sendToolResult`. Use `@ai-ezio/mcp-host`'s `createMcpHost({...}, { mode: "mounted", connect })` so no real server spawns.

- [ ] **Step 2: Run; expect failure**

Run (in ai-whisper): `pnpm --filter @ai-whisper/adapter-ai-ezio test`
Expected: FAIL — no host wired.

- [ ] **Step 3: Wire `loadMcpHost` into the adapter**

In `create-ai-ezio-live-session.ts`, where the harness `Session` is constructed and started: build `const host = loadMcpHost({ mode: "mounted", cwd: workspaceRoot })`; ensure the Session's event handler also calls `host.handleEvent(event)` (the adapter already forwards events to the renderer — add a second fan-out); after `session.start()` resolves and before the first submit is accepted, `await host.start(session)`. On teardown, `await host.stop()`. Add `@ai-ezio/mcp-host` to the adapter's `package.json` deps. `mode: "mounted"` ensures `confirm`→`deny` (no human prompt in a workflow pane).

- [ ] **Step 4: Run; expect pass**

Run (in ai-whisper): `pnpm --filter @ai-whisper/adapter-ai-ezio test`
Expected: PASS.

- [ ] **Step 5: Commit (in the ai-whisper repo)**

```bash
git -C ~/Dev/ai-whisper add packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts packages/adapter-ai-ezio/src/create-ai-ezio-live-session.mcp.test.ts packages/adapter-ai-ezio/package.json
git -C ~/Dev/ai-whisper commit -m "feat(adapter-ai-ezio): attach MCP host to the mounted Session (M9)"
```

---

## Phase 5 — cortex as server #1 + end-to-end

### Task 5.1: Ship a default `mcp.json` example + doctor surfacing

**Files:**
- Create: `docs/mcp.example.json`
- Modify: `packages/cli/src/doctor.ts` (+ its test) — report MCP config presence/server count

- [ ] **Step 1: Create the example config**

`docs/mcp.example.json`:

```json
{
  "mcpServers": {
    "cortex": { "command": "ai-cortex", "args": ["mcp"] }
  },
  "toolPolicy": {
    "cortex__purge_memory": "deny",
    "cortex__trash_memory": "deny",
    "cortex__promote_to_global": "deny"
  }
}
```

- [ ] **Step 2: Failing doctor test**

In `packages/cli/src/doctor.test.ts`, add a case asserting the report includes an `mcp` section listing configured server names (or "none configured"). Drive `buildDoctorReport` with an injected config (follow the existing injection pattern in that test).

- [ ] **Step 3: Run; expect failure → implement → pass**

Add an `mcp` field to the doctor report built from `loadConfig()` (server names). Run: `pnpm --filter @ai-ezio/cli test` → PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/mcp.example.json packages/cli/src/doctor.ts packages/cli/src/doctor.test.ts
git commit -m "feat(cli): ship mcp.example.json + doctor reports MCP servers"
```

### Task 5.2: End-to-end delegated round-trip (real hax + harness + stub server)

**Files:**
- Create: `packages/mcp-host/src/e2e/stub-mcp-server.mjs` (a tiny real stdio MCP server)
- Create: `packages/mcp-host/src/e2e/delegated.e2e.test.ts`

- [ ] **Step 1: Write the stub MCP server**

A minimal stdio MCP server using `@modelcontextprotocol/sdk/server` exposing one tool `echo` that returns its args as text. (Mirror the SDK's stdio server example; ~30 lines.)

- [ ] **Step 2: Write the failing e2e test**

Spawn real hax via `Session.start()` against `HAX_PROVIDER=mock` with a mock script that calls `stub__echo` on the first turn. Construct `McpHost` with the real stub server config (`{ name: "stub", command: process.execPath, args: ["<path>/stub-mcp-server.mjs"] }`), `onEvent` fanned to `host.handleEvent`. `await host.start(session)`, then `session.submitAndWait("go")`. Assert the final content reflects the echoed args (proving: register → model called → request emitted → host routed → result returned → turn finished). Mark `it.skipIf(!haxBinaryAvailable())` guarding the same way the existing harness e2e (`session.e2e.test.ts`) guards.

- [ ] **Step 3: Run; expect failure first (if any wiring gap), then pass**

Run: `pnpm --filter @ai-ezio/mcp-host test`
Expected: PASS once Phases 1–3 are in (this is the integration proof).

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-host/src/e2e
git commit -m "test(mcp-host): e2e delegated round-trip (real hax mock + stub MCP server)"
```

### Task 5.3: Full-suite green gate

- [ ] **Step 1: Build + test everything**

Run:
```bash
pnpm -r build && pnpm -r --workspace-concurrency=1 test
meson compile -C vendor/hax/build && meson test -C vendor/hax/build --print-errorlogs
```
Expected: all green. Fix any cross-package type drift (e.g. `DelegatedToolDef` shape) surfaced here.

- [ ] **Step 2: Commit (if fixes were needed)**

```bash
git add -A
git commit -m "chore: M9 full-suite green (TS + hax)"
```

---

## Phase 6 — documentation updates

### Task 6.1: architecture.md + milestones.md

**Files:**
- Modify: `docs/architecture.md` (unified terminal-ownership model + MCP host + delegated-tool seam)
- Modify: `docs/milestones.md` (add the M9 entry, mirroring the M7/M8 entries' "Done when / Met" style)

- [ ] **Step 1: Update `docs/architecture.md`**

Add a section "Terminal ownership (unified)" stating: hax is always headless (`--mount-mode`, stdin/stdout/stderr ignored, protocol-only); ezio (TS) always owns the terminal — surface renders output (both modes), a line-buffered reader owns input in standalone, the host app owns input in mounted. Add a "MCP host" section describing the delegated-tool seam (generic, MCP-agnostic) and `@ai-ezio/mcp-host`.

- [ ] **Step 2: Add the M9 milestone entry**

Append to `docs/milestones.md`:

```markdown
## M9 — Generic MCP host + unified terminal

- hax delegated-tool seam (MCP-agnostic): `register_delegated_tools` /
  `tool_result` controls + `tool_call_requested` event; block-on-control-fd
  dispatch with interrupt + `AI_EZIO_DELEGATED_TIMEOUT` backstop.
- `@ai-ezio/mcp-host`: spawn/connect stdio MCP servers, `<server>__<tool>`
  namespacing, cwd injection, config-driven allow/deny/confirm policy, lifecycle.
- Unified run architecture: hax always headless; ezio (TS) always owns the
  terminal. Standalone self-mounts (line-buffered reader + M7/M8 surface + host).
- cortex wired as server #1; e2e proves a real delegated round-trip.

**Done when:** the model calls a configured MCP server's tool live mid-turn over
the protocol, in both standalone and mounted modes; native-tool behavior
unchanged when no tools are registered.
```

- [ ] **Step 3: Commit**

```bash
git add docs/architecture.md docs/milestones.md
git commit -m "docs: architecture + M9 milestone for MCP host + unified terminal"
```

### Task 6.2: README.md, AGENTS.md, UPSTREAM.md

**Files:**
- Modify: `README.md` (positioning), `AGENTS.md` (sanctioned hax-extension areas + MCP host boundary), `UPSTREAM.md` (maintained-fork stance)

- [ ] **Step 1: README positioning**

Reframe the intro: ezio is the ai-\* ecosystem's opinionated, frontier coding agent and **generic MCP host** (hax engine + TS harness). Note it speaks MCP to any ecosystem service (cortex first).

- [ ] **Step 2: AGENTS.md**

In the working agreements, add the delegated-tool seam to the sanctioned hax-extension surface (alongside the emitter), and state the boundary: MCP/config/policy live in `@ai-ezio/mcp-host` (TS), never in hax; hax knows only "host-delegated tools."

- [ ] **Step 3: UPSTREAM.md**

Replace the "vendored unchanged-except-one-patch / upstreamable" framing with the maintained-fork stance: ezio maintains its own hax fork; changes stay localized/minimal/rebaseable so the fork can still sync with upstream hax; we do not aim to merge upstream.

- [ ] **Step 4: Commit**

```bash
git add README.md AGENTS.md UPSTREAM.md
git commit -m "docs: reframe ezio as the ecosystem MCP-host agent; maintained-fork stance"
```

---

## Self-Review

**Spec coverage:**
- Delegated-tool seam (registry, advertise, dispatch branch, blocking read) → Phase 1 (1.1–1.5). ✓
- Protocol: 1 event + 2 controls, clean separation, camelCase → Phase 0. ✓
- Interrupt + timeout safety, no-deadlock, native-unchanged invariant → Task 1.5 (e2e cases). ✓
- `@ai-ezio/mcp-host`: config, namespacing, policy, client, cwd injection, lifecycle, health-on-failure-only → Phase 3 (3.1–3.7). ✓
- **MCP host in BOTH modes** → shared `loadMcpHost` factory (3.7) wired in standalone (4.2) **and** the mounted adapter (4.3). ✓
- Standalone unification + line-buffered reader + `-p` preserved (now also wires the host) → Phase 4 (4.1–4.2). ✓
- cortex as server #1 + e2e → Phase 5. ✓
- Doc updates (protocol/architecture/milestones/README/AGENTS/UPSTREAM) → Phase 0.1 + Phase 6. ✓
- Defaults: deny-list (`purge`/`trash`/`promote`) → `policy.ts` (3.4). Timeouts: host per-call 60s implemented in `host.handleEvent` via `withTimeout(client.callTool, 60_000)` (3.6) + regression test; hax 120s backstop → Task 1.5. ✓

**Placeholder scan:** no "TBD"/"handle edge cases" without code; every code step shows code; C steps that can't show 100% (file-specific writer names, exact SDK import subpaths) explicitly instruct "read the file / verify against installed version and reuse the existing symbol" rather than leaving a blank. ✓

**Type consistency:** `DelegatedToolDef { name, description, parametersSchema }` used identically in protocol, harness, mcp-client, host, attach. `tool_result` fields `callId/output/status` consistent. Event `tool_call_requested` fields `turnId/callId/name/args` consistent across docs, TS type, hax emit, host handler. `McpHost` methods `start/handleEvent/stop` consistent across host.ts, attach.ts, standalone.ts, and the adapter. ✓

**Reviewer findings addressed (round 1):**
1. *Host in both modes* — added shared `loadMcpHost`/`createMcpHost` factory (Task 3.7); wired in standalone (4.2) AND the ai-whisper mounted adapter (4.3, with a mounted register-before-submit ordering test). The raw `--mount-mode` fd-forward path is documented as a deliberate no-MCP escape hatch (not the ai-whisper mounted path). ✓
2. *cwd/worktree injection drift + `path`* — `injectCwd` is now schema-aware: it **overrides** model-supplied `worktreePath` **and** `path` (drift-proof) for any tool whose schema declares them, and never adds an arg the schema lacks. Tests cover override-drift for both args and the no-spurious-add case (3.6). ✓
3. *Host 60s per-call timeout* — implemented in code (`withTimeout(client.callTool, callTimeoutMs ?? 60_000)` in `host.handleEvent`), with a regression test asserting a slow call returns `tool_result{status:"error"}` well before hax's 120s backstop (3.6). ✓
4. *Server-crash coverage* — added a regression test where `callTool` rejects (simulated crash/down server) and asserts the host still emits an error `tool_result` (no missing reply, no hang) (3.6). ✓

**Reviewer findings addressed (round 2):**
5. *Large-output capping* — `dispatch_tool_delegated` (Task 1.4) now caps host output to hax's shared `output_cap_bytes()` limit (default 50K, env `HAX_TOOL_OUTPUT_CAP`) with a UTF-8-safe cut + truncation marker, and `ctrl_strip_dup`s it for native parity — so MCP output is capped *before* the `ITEM_TOOL_RESULT` enters model history, exactly where native tool output is capped. A C capping test asserts truncation + marker + no split codepoint (1.4). The TS host deliberately does **not** double-cap (note in 3.5). ✓

**Result-mapping / large-output coverage** → `mapToolResult` (3.5) maps content blocks + `isError`; capping → hax `dispatch_tool_delegated` (1.4) with its own test. ✓
