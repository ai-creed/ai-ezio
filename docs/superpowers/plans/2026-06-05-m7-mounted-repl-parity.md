# M7 — Mounted ezio REPL parity (banner · prompt · usage) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A mounted `ezio` pane renders a REPL-like look — `▌ ezio › provider · model · effort` banner on start, and a per-turn usage line + `›` prompt — fed entirely by protocol events, with the engine staying protocol-native (no REPL re-enabled, no scraping).

**Architecture:** Three coordinated layers. (1) **hax emitter (C, ai-ezio)** surfaces data hax already computes: add `effort` to the `status` event, auto-emit `status` right after `ready` in mount mode, and attach an optional `usage` object to `assistant_turn_finished`. (2) **protocol (TS, ai-ezio)** documents (`docs/protocol.md` first) and types the new optional fields. (3) **adapter (TS, ai-whisper)** renders banner/usage/prompt from those events. All protocol additions are optional/back-compatible; codex/claude and all M6 behavior are untouched.

**Tech Stack:** C11 + meson + jansson (hax); TypeScript + pnpm + vitest (protocol, adapter). hax style: 4-space indent, snake_case, `clang-format -i`, SPDX header. TS style: tabs, double quotes, semicolons, trailing commas.

**Spec:** `/Users/vuphan/Dev/ai-ezio/docs/superpowers/specs/2026-06-05-m7-mounted-repl-parity-design.md`

**Repos / working dirs:**
- ai-ezio: `/Users/vuphan/Dev/ai-ezio` (hax engine under `vendor/hax`, protocol under `packages/protocol`)
- ai-whisper: `/Users/vuphan/Dev/ai-whisper` (adapter under `packages/adapter-ai-ezio`)

**Verification gate (before final commit):**
- ai-ezio: `meson compile -C vendor/hax/build && meson test -C vendor/hax/build` and `pnpm -r build && pnpm -r test`
- ai-whisper: `pnpm -r build && pnpm typecheck && pnpm lint && pnpm test && pnpm run e2e:ai-ezio-mount && pnpm run e2e:ai-ezio-workflow` (**both** e2e — the workflow e2e re-verifies unchanged M6 behavior through the adapter)

---

### Task 0: Branches + baseline

**Files:** none (git + sanity)

- [ ] **Step 1: Branch both repos**

```sh
cd /Users/vuphan/Dev/ai-ezio && git checkout master && git pull --ff-only && git checkout -b m7-mounted-repl-parity
cd /Users/vuphan/Dev/ai-whisper && git checkout master && git pull --ff-only && git checkout -b m7-mounted-repl-parity
```

- [ ] **Step 2: Baseline green**

```sh
cd /Users/vuphan/Dev/ai-ezio && meson test -C vendor/hax/build && pnpm -r test
cd /Users/vuphan/Dev/ai-whisper && pnpm test
```
Expected: hax meson tests PASS; ai-ezio + ai-whisper vitest PASS. If `vendor/hax/build` doesn't exist, run `meson setup vendor/hax/build` first. STOP if anything fails.

---

### Task 1: Protocol — document + type the new optional fields (ai-ezio)

**Files:**
- Modify: `docs/protocol.md`
- Modify: `packages/protocol/src/events.ts`
- Test: `packages/protocol/src/codec.test.ts`

- [ ] **Step 1: Write the failing codec round-trip test**

In `packages/protocol/src/codec.test.ts`, add a test that encodes/decodes a `status` event with `effort` and an `assistant_turn_finished` with `usage`:

```ts
it("round-trips status.effort and assistant_turn_finished.usage (M7)", () => {
	const status = {
		type: "status",
		model: "gpt-5.5",
		provider: "codex",
		protocol: "0.1.0",
		sessionId: "s1",
		state: "idle",
		contextPercent: null,
		effort: "high",
	} satisfies ProtocolEvent;
	const finished = {
		type: "assistant_turn_finished",
		turnId: "t1",
		content: "done",
		usage: { contextTokens: 8900, outputTokens: 595, cachedTokens: 2700, contextLimit: 262144 },
	} satisfies ProtocolEvent;

	const dec = new JsonlDecoder();
	const out = [
		...dec.push(encodeEvent(status)),
		...dec.push(encodeEvent(finished)),
	];
	expect(out[0]).toMatchObject({ type: "status", effort: "high" });
	expect(out[1]).toMatchObject({
		type: "assistant_turn_finished",
		usage: { contextTokens: 8900, outputTokens: 595, cachedTokens: 2700, contextLimit: 262144 },
	});
});
```

(Match the existing imports in `codec.test.ts` — `JsonlDecoder`, `encodeEvent`, `ProtocolEvent`.)

- [ ] **Step 2: Run it — expect a TYPE failure (`effort`/`usage` not on the types)**

Run: `cd /Users/vuphan/Dev/ai-ezio && pnpm --filter @ai-ezio/protocol test`
Expected: FAIL — `effort` / `usage` are not assignable (the `satisfies ProtocolEvent` check fails).

- [ ] **Step 3: Add the optional fields to the event types**

In `packages/protocol/src/events.ts`:

```ts
export interface AssistantTurnFinishedEvent {
	type: "assistant_turn_finished";
	turnId: string;
	/** Authoritative handback: the final assistant message of the user turn. */
	content: string;
	/** Optional per-turn token usage (M7). Fields omitted when the backend did
	 * not report them; absent entirely when no field is available. */
	usage?: {
		contextTokens?: number;
		outputTokens?: number;
		cachedTokens?: number;
		contextLimit?: number;
	};
}
```

and

```ts
export interface StatusEvent {
	type: "status";
	model: string;
	provider: string;
	protocol: string;
	sessionId: string;
	state: "idle" | "busy";
	contextPercent?: number | null;
	/** Reasoning effort for this session (M7); empty/omitted when not set. */
	effort?: string;
}
```

- [ ] **Step 4: Document the additions in `docs/protocol.md`**

Add to `docs/protocol.md` (find the `status` and `assistant_turn_finished` event sections):
- `assistant_turn_finished`: note the optional `usage` object and its four optional numeric fields (`contextTokens`, `outputTokens`, `cachedTokens`, `contextLimit`); a field is omitted when the backend didn't report it (hax `-1`), and `usage` is omitted when none are present.
- `status`: note the optional `effort` string.
- Add a sentence under the mount-mode/`status` description: in `--mount-mode`, hax emits one `status` event automatically right after `ready` (carrying `provider`/`model`/`effort`), in addition to answering the `status` control.

- [ ] **Step 5: Build protocol, run the test**

Run: `cd /Users/vuphan/Dev/ai-ezio && pnpm --filter @ai-ezio/protocol build && pnpm --filter @ai-ezio/protocol test`
Expected: PASS.

- [ ] **Step 6: Commit (ai-ezio)**

```sh
cd /Users/vuphan/Dev/ai-ezio
git add docs/protocol.md packages/protocol/src/events.ts packages/protocol/src/codec.test.ts
git commit -m "M7 protocol: optional status.effort + assistant_turn_finished.usage (documented)"
```

---

### Task 2: hax emitter — effort on status, usage on turn_finished (ai-ezio, C)

**Files:**
- Modify: `vendor/hax/src/protocol/emit.h`
- Modify: `vendor/hax/src/protocol/emit.c`
- Test: `vendor/hax/tests/protocol/test_emit.c`

- [ ] **Step 1: Write failing C tests**

In `vendor/hax/tests/protocol/test_emit.c`, add two test functions (model them on
`test_lifecycle_order_and_jsonl`'s pipe + `read_all` + `json_loads` pattern) and
call them from `main()`:

```c
/* M7: emit_status carries provider/model/effort. */
static void test_status_carries_effort(void)
{
    int fds[2];
    EXPECT(pipe(fds) == 0);
    struct emit_state es;
    emit_state_init(&es, fds[1], -1);
    emit_status(&es, "codex", "gpt-5.5", "high", "sess-1");
    close(fds[1]);

    char buf[2048];
    read_all(fds[0], buf, sizeof(buf));
    close(fds[0]);
    json_error_t err;
    json_t *o = json_loads(buf, 0, &err);
    EXPECT(o != NULL);
    EXPECT_STR_EQ(json_string_value(json_object_get(o, "type")), "status");
    EXPECT_STR_EQ(json_string_value(json_object_get(o, "provider")), "codex");
    EXPECT_STR_EQ(json_string_value(json_object_get(o, "model")), "gpt-5.5");
    EXPECT_STR_EQ(json_string_value(json_object_get(o, "effort")), "high");
    json_decref(o);
}

/* M7: a usage set before on_turn_finished is attached to that event; fields the
 * backend didn't report (-1, or cached<=0) are omitted. */
static void test_turn_finished_usage(void)
{
    int fds[2];
    EXPECT(pipe(fds) == 0);
    struct emit_state es;
    emit_state_init(&es, fds[1], -1);
    struct agent_observer obs = emit_observer(&es);
    emit_set_usage(&es, 8900, 595, 2700, 262144);
    obs.on_turn_finished(obs.user, "t1", "Hi");
    /* next turn reports nothing → no usage key */
    emit_set_usage(&es, -1, -1, -1, -1);
    obs.on_turn_finished(obs.user, "t2", "Yo");
    close(fds[1]);

    char buf[4096];
    read_all(fds[0], buf, sizeof(buf));
    close(fds[0]);
    char *save = NULL;
    int seen = 0;
    for (char *line = strtok_r(buf, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
        json_t *o = json_loads(line, 0, NULL);
        EXPECT(o != NULL);
        const char *turn = json_string_value(json_object_get(o, "turnId"));
        json_t *u = json_object_get(o, "usage");
        if (turn && strcmp(turn, "t1") == 0) {
            EXPECT(u != NULL);
            EXPECT(json_integer_value(json_object_get(u, "contextTokens")) == 8900);
            EXPECT(json_integer_value(json_object_get(u, "outputTokens")) == 595);
            EXPECT(json_integer_value(json_object_get(u, "cachedTokens")) == 2700);
            EXPECT(json_integer_value(json_object_get(u, "contextLimit")) == 262144);
            seen++;
        }
        if (turn && strcmp(turn, "t2") == 0)
            EXPECT(u == NULL); /* nothing reported → omitted */
        json_decref(o);
    }
    EXPECT(seen == 1);
}
```

Add `test_status_carries_effort();` and `test_turn_finished_usage();` to `main()`.

- [ ] **Step 2: Run — expect a COMPILE failure (new signature/function don't exist)**

Run: `cd /Users/vuphan/Dev/ai-ezio && meson compile -C vendor/hax/build`
Expected: FAIL — `emit_status` arity changed; `emit_set_usage` undeclared.

- [ ] **Step 3: Extend `emit.h` — `emit_status` signature + pending-usage state + `emit_set_usage`**

In `struct emit_state` (after the `have_last` block), add:

```c
    /* M7: per-turn usage staged before on_turn_finished fires; -1 = unreported. */
    long pend_usage_ctx, pend_usage_out, pend_usage_cached, pend_usage_limit;
    int have_pend_usage;
```

Change the `emit_status` declaration to take `effort`:

```c
void emit_status(struct emit_state *es, const char *provider, const char *model,
                 const char *effort, const char *session_id);
```

Add, near `emit_status`:

```c
/* M7: stage the current turn's token usage; consumed (and cleared) by the next
 * assistant_turn_finished emission. -1 fields are omitted; cached <= 0 omitted. */
void emit_set_usage(struct emit_state *es, long ctx, long out, long cached, long limit);
```

- [ ] **Step 4: Implement in `emit.c`**

In `emit_state_init`, initialize the new fields:

```c
    es->have_pend_usage = 0;
    es->pend_usage_ctx = es->pend_usage_out = es->pend_usage_cached = es->pend_usage_limit = -1;
```

Add `emit_set_usage` (place near `emit_status`):

```c
void emit_set_usage(struct emit_state *es, long ctx, long out, long cached, long limit)
{
    es->pend_usage_ctx = ctx;
    es->pend_usage_out = out;
    es->pend_usage_cached = cached;
    es->pend_usage_limit = limit;
    es->have_pend_usage = 1;
}
```

In `obs_on_turn_finished`, after setting `content` on the object and before
`emit_obj`, attach usage (mirrors `display_usage`'s per-field guards):

```c
    if (es->have_pend_usage) {
        json_t *u = json_object();
        if (es->pend_usage_ctx >= 0)
            json_object_set_new(u, "contextTokens", json_integer(es->pend_usage_ctx));
        if (es->pend_usage_out >= 0)
            json_object_set_new(u, "outputTokens", json_integer(es->pend_usage_out));
        if (es->pend_usage_cached > 0)
            json_object_set_new(u, "cachedTokens", json_integer(es->pend_usage_cached));
        if (es->pend_usage_limit > 0)
            json_object_set_new(u, "contextLimit", json_integer(es->pend_usage_limit));
        if (json_object_size(u) > 0)
            json_object_set_new(o, "usage", u);
        else
            json_decref(u);
        es->have_pend_usage = 0;
    }
```

Update `emit_status` to emit `effort`:

```c
void emit_status(struct emit_state *es, const char *provider, const char *model,
                 const char *effort, const char *session_id)
{
    if (es->event_fd < 0)
        return;
    json_t *o = json_object();
    json_object_set_new(o, "type", json_string("status"));
    json_object_set_new(o, "model", json_string(model ? model : ""));
    json_object_set_new(o, "provider", json_string(provider ? provider : ""));
    json_object_set_new(o, "effort", json_string(effort ? effort : ""));
    json_object_set_new(o, "protocol", json_string(AI_EZIO_PROTOCOL_VERSION));
    json_object_set_new(o, "sessionId", json_string(session_id ? session_id : "unknown"));
    json_object_set_new(o, "state", json_string("idle"));
    json_object_set_new(o, "contextPercent", json_null());
    emit_obj(es->event_fd, o);
}
```

- [ ] **Step 5: `clang-format -i` the touched C files**

```sh
cd /Users/vuphan/Dev/ai-ezio
clang-format -i vendor/hax/src/protocol/emit.c vendor/hax/src/protocol/emit.h vendor/hax/tests/protocol/test_emit.c
```

- [ ] **Step 6: Compile + run the emitter test**

Run: `meson compile -C vendor/hax/build && meson test -C vendor/hax/build emit`
Expected: PASS (the two new tests + the existing lifecycle test). If the test name differs, run the full `meson test -C vendor/hax/build`.

- [ ] **Step 7: Commit (ai-ezio)** — wait, the agent.c callers still pass the old `emit_status` arity; they're fixed in Task 3, so this won't fully build yet. Defer the commit to the end of Task 3.

---

### Task 3: hax agent.c — wire effort, auto-status, and usage (ai-ezio, C)

**Files:**
- Modify: `vendor/hax/src/agent.c`
- Create: `vendor/hax/tests/protocol/test_mount_repl.c` (engine-level test)
- Modify: `vendor/hax/tests/meson.build` (register the test)

- [ ] **Step 1: Fix the existing `emit_status` call (EMIT_CTL_STATUS) to pass effort**

At the `EMIT_CTL_STATUS` branch (currently
`emit_status(&emit, p->name, sess.model, session_log_resume_hint(state.slog));`),
add the effort arg:

```c
                if (ctl.kind == EMIT_CTL_STATUS) {
                    emit_status(&emit, p->name, sess.model, sess.reasoning_effort,
                                session_log_resume_hint(state.slog));
                    continue;
                }
```

- [ ] **Step 2: Auto-emit `status` right after `ready` in mount mode**

Immediately after the ready notify in the protocol-wiring block
(`AGENT_OBSERVER_NOTIFY(obsp, on_ready, session_log_resume_hint(state.slog));`),
add:

```c
        /* M7: in mount mode the operator has no REPL banner, so surface
         * provider/model/effort once up front for the adapter to render. */
        if (opts->mount_mode)
            emit_status(&emit, p->name, sess.model, sess.reasoning_effort,
                        session_log_resume_hint(state.slog));
```

- [ ] **Step 3: Stage usage before `on_turn_finished`**

Just before the turn-finished notify
(`AGENT_OBSERVER_NOTIFY(obsp, on_turn_finished, turn_id, last_assistant_text(&sess));`),
stage the usage that `display_usage` would have shown:

```c
        if (obsp)
            emit_set_usage(&emit, user_turn_ctx, user_turn_out, user_turn_cached,
                           context_limit(p));
        AGENT_OBSERVER_NOTIFY(obsp, on_turn_finished, turn_id, last_assistant_text(&sess));
```

(`context_limit` is the existing static fn in agent.c; `user_turn_ctx/out/cached`
are in scope here. `emit_set_usage` no-ops nothing — it only stages; the emit
happens inside `obs_on_turn_finished`.)

- [ ] **Step 4: clang-format, compile, full hax test**

```sh
cd /Users/vuphan/Dev/ai-ezio
clang-format -i vendor/hax/src/agent.c
meson compile -C vendor/hax/build && meson test -C vendor/hax/build
```
Expected: full build clean; all meson tests PASS (incl. `emit` and `mount_chrome` —
the human-display suppression is unchanged, so `mount_chrome` must still pass).

- [ ] **Step 4b: Write the engine-level mount-mode test (real hax + mock script)**

The Task-2 emitter unit tests call `emit_status`/`emit_set_usage` directly — they
do NOT prove `agent.c` actually auto-emits `status` after `ready` in mount mode or
passes real mock `EV_DONE` usage into the emitter. Add a committed **engine-level**
test that spawns the real hax binary (mock provider) over the protocol fds and
asserts the wire output — modeled on `vendor/hax/tests/protocol/test_observer_e2e.c`
(its `spawn_hax` fork/exec + event-fd drain) and `test_mount_chrome.c` (the
`--mount-mode` flags). The mock is scriptable via `HAX_MOCK_SCRIPT`
(`vendor/hax/src/providers/mock.c`): directives `text <msg>`,
`usage in=N out=M [cached=K]`, `end-turn`.

The test must cover BOTH usage cases **at the engine layer** (the spec's
mock-engine acceptance criterion requires `usage` present when the backend reports
counts AND omitted when it reports none): drive **two** mock turns in one session —
the first scripts usage counts, the second scripts none (`empty_usage` = `-1`). The
mock plays "one turn of directives per `stream()` call, in file order", so a single
script file with two `end-turn`-delimited turns yields turn 1 (with usage) then
turn 2 (without).

Create `vendor/hax/tests/protocol/test_mount_repl.c`:
- Write a temp mock-script file (via `mkstemp`) containing TWO turns:
  ```
  text Hi
  usage in=100 out=50 cached=10
  end-turn
  text Bye
  end-turn
  ```
  (Turn 1 reports usage; turn 2 reports none → `empty_usage` `-1/-1/-1`.)
- `spawn_hax(hax, ...)` with `--mount-mode --protocol-fd=<w> --control-fd=<r>` and
  child env `HAX_PROVIDER=mock`, `HAX_MOCK_SCRIPT=<temp>`, `HAX_NO_SESSION=1`.
- Write TWO submits to the control fd up front
  (`{"type":"submit","text":"go"}\n` twice), then drain the event fd until the
  **second** `idle`, collecting every JSONL line.
- Assert, by walking the parsed lines in order:
  1. a `ready` line appears, and the **next** event is a `status` line carrying
     non-empty `provider`, non-empty `model`, and an `effort` key present
     (string; may be empty) — proving the mount-mode auto-emit after ready.
  2. the **first** `assistant_turn_finished` line carries `usage` with
     `contextTokens == 150` (input+output), `outputTokens == 50`,
     `cachedTokens == 10` — proving `agent.c` fed the mock `EV_DONE` counts via
     `emit_set_usage` (`context_limit` may be 0 under mock → `contextLimit`
     legitimately absent; do not require it).
  3. the **second** `assistant_turn_finished` line has **no `usage` key at all**
     (`json_object_get(o, "usage") == NULL`) — proving `agent.c`/the emitter omit
     `usage` for a real mock turn whose `EV_DONE` reported `-1` counts (the
     engine-layer no-usage case the direct emitter unit test cannot prove).
- Unlink the temp script; close fds; `waitpid` the child.

Register it in `vendor/hax/tests/meson.build` (mirror the `observer_e2e` block):

```meson
# Engine-level: mount-mode auto-status-after-ready + assistant_turn_finished.usage
# present (turn 1, scripted counts) AND omitted (turn 2, -1 counts) over the real
# hax+mock path — exercises agent.c wiring, not just emit.c.
test_mount_repl = executable('test_mount_repl',
    sources: ['protocol/test_mount_repl.c'],
    dependencies: [jansson],
)
test('protocol/mount_repl', test_mount_repl, args: [hax_exe], depends: hax_exe)
```

Run: `clang-format -i vendor/hax/tests/protocol/test_mount_repl.c && meson compile -C vendor/hax/build && meson test -C vendor/hax/build mount_repl`
Expected: PASS. (If meson needs a reconfigure after adding the test target, run
`meson setup --reconfigure vendor/hax/build` first.)

- [ ] **Step 5: Manual protocol smoke (mock provider)**

Confirm the wire output carries the new fields end to end:

```sh
cd /Users/vuphan/Dev/ai-ezio
HAX_PROVIDER=mock node scripts/protocol-repl.mjs <<'EOF'
hello
EOF
```
Expected: a `status` line with `"effort"` appears shortly after `ready`, and the
`assistant_turn_finished` line includes a `"usage"` object. (If `scripts/protocol-repl.mjs`
needs different invocation, use the existing M3/M4 protocol smoke script; the goal
is to eyeball `status.effort` + `assistant_turn_finished.usage` on fd 3.)

- [ ] **Step 6: Commit (ai-ezio)**

```sh
cd /Users/vuphan/Dev/ai-ezio
git add vendor/hax/src/protocol/emit.c vendor/hax/src/protocol/emit.h vendor/hax/tests/protocol/test_emit.c vendor/hax/src/agent.c vendor/hax/tests/protocol/test_mount_repl.c vendor/hax/tests/meson.build
git commit -m "M7 emitter: status.effort + auto-status-on-ready (mount) + turn usage; engine-level mount test"
```

---

### Task 4: Adapter — render banner, usage line, prompt (ai-whisper, TS)

The adapter consumes `@ai-ezio/protocol`. Ensure ai-ezio's protocol dist is built
(Task 1 Step 5) so ai-whisper sees the new optional fields.

**Files:**
- Modify: `packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts`
- Test: `test/adapter-ai-ezio-live-session.test.ts` (extend existing)

- [ ] **Step 1: Rebuild ai-ezio protocol so ai-whisper picks up the new types**

```sh
cd /Users/vuphan/Dev/ai-ezio && pnpm --filter @ai-ezio/protocol build
cd /Users/vuphan/Dev/ai-whisper && pnpm --filter @ai-whisper/adapter-ai-ezio build
```

- [ ] **Step 2: Write failing adapter tests**

In `test/adapter-ai-ezio-live-session.test.ts`, add a `describe` that drives the
live session's engine `onEvent` with `status` + `assistant_turn_finished{usage}`
and asserts the rendered stdout. Reuse the file's existing fake-engine pattern
(the engine created via `createEngineSession` exposes the `onEvent` passed to it;
capture stdout via a fake `WritableStream` collecting `write` calls):

```ts
describe("createAiEzioLiveSession — REPL-look rendering (M7)", () => {
	it("renders a banner on status and a usage line + prompt after a turn", () => {
		const writes: string[] = [];
		const stdout = { write: (s: string) => (writes.push(s), true) } as never;
		let emit!: (e: ProtocolEvent) => void;
		const live = createAiEzioLiveSession({
			stdout,
			createEngineSession: ({ onEvent }) => {
				emit = onEvent;
				return {
					start: async () => ({ type: "ready" }),
					submit: () => {},
					submitAndWait: async () => ({ turnId: "t", content: "" }),
					onExit: () => {},
					close: () => {},
				} as never;
			},
		});
		void live.start();

		emit({ type: "status", model: "gpt-5.5", provider: "codex", protocol: "0.1.0", sessionId: "s", state: "idle", effort: "high" });
		emit({ type: "assistant_delta", turnId: "t", text: "hello" });
		emit({ type: "assistant_turn_finished", turnId: "t", content: "hello", usage: { contextTokens: 8900, outputTokens: 595, cachedTokens: 2700, contextLimit: 262144 } });
		emit({ type: "idle" });

		const out = writes.join("");
		expect(out).toContain("ezio"); // banner
		expect(out).toContain("codex");
		expect(out).toContain("gpt-5.5");
		expect(out).toContain("high");
		expect(out).toMatch(/context 8\.7k \/ 256k \(3%\)/); // usage line (binary k, mirrors hax format_tokens)
		expect(out).toContain("out 595");
		expect(out).toContain("cached 2.6k");
		expect(out).toContain("›"); // prompt glyph
	});

	it("omits the effort segment when empty and skips unreported usage fields", () => {
		const writes: string[] = [];
		const stdout = { write: (s: string) => (writes.push(s), true) } as never;
		let emit!: (e: ProtocolEvent) => void;
		createAiEzioLiveSession({
			stdout,
			createEngineSession: ({ onEvent }) => {
				emit = onEvent;
				return { start: async () => ({ type: "ready" }), submit: () => {}, submitAndWait: async () => ({ turnId: "t", content: "" }), onExit: () => {}, close: () => {} } as never;
			},
		}).start();
		emit({ type: "status", model: "m", provider: "p", protocol: "0.1.0", sessionId: "s", state: "idle", effort: "" });
		emit({ type: "assistant_turn_finished", turnId: "t", content: "x" }); // no usage
		emit({ type: "idle" });
		const out = writes.join("");
		expect(out).toContain("p");
		expect(out).not.toMatch(/· · /); // no empty effort segment
		expect(out).not.toContain("context "); // no usage line when usage absent
		expect(out).toContain("›"); // prompt still rendered
	});

	it("renders the banner only once across repeated status events", () => {
		const writes: string[] = [];
		const stdout = { write: (s: string) => (writes.push(s), true) } as never;
		let emit!: (e: ProtocolEvent) => void;
		createAiEzioLiveSession({
			stdout,
			createEngineSession: ({ onEvent }) => {
				emit = onEvent;
				return { start: async () => ({ type: "ready" }), submit: () => {}, submitAndWait: async () => ({ turnId: "t", content: "" }), onExit: () => {}, close: () => {} } as never;
			},
		}).start();
		const status = { type: "status", model: "gpt-5.5", provider: "codex", protocol: "0.1.0", sessionId: "s", state: "idle", effort: "high" } as const;
		emit(status); // auto-status on ready
		emit(status); // a later M4 status control must NOT re-render the banner
		const bannerCount = (writes.join("").match(/ezio/g) || []).length;
		expect(bannerCount).toBe(1);
	});
});
```

(Match the existing test's imports for `ProtocolEvent`/`createAiEzioLiveSession`
and its engine-session fake shape; the key is capturing `emit` = the `onEvent`.)

- [ ] **Step 3: Run — expect FAIL (no banner/usage/prompt rendering yet)**

Run: `cd /Users/vuphan/Dev/ai-whisper && pnpm vitest run test/adapter-ai-ezio-live-session.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement rendering in the adapter**

In `packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts`, add a small
token formatter + usage renderer and a banner/prompt, then handle `status` and
extend `assistant_turn_finished`/`idle`. Add near the top of the function body:

```ts
	// Mirrors hax's format_tokens (vendor/hax/src/agent.c) EXACTLY — binary k/M
	// with the same rounding: 595 -> "595", 8900 -> "8.7k", 262144 -> "256k".
	const fmtTokens = (n: number): string => {
		if (n < 0) return "?";
		if (n < 1024) return String(n);
		if (n < 10 * 1024) return `${(n / 1024).toFixed(1)}k`;
		if (n < 1024 * 1024) return `${Math.floor((n + 512) / 1024)}k`;
		if (n < 10 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}M`;
		return `${Math.floor((n + 512 * 1024) / (1024 * 1024))}M`;
	};

	const renderBanner = (provider: string, model: string, effort: string) => {
		const tail = effort ? `${provider} · ${model} · ${effort}` : `${provider} · ${model}`;
		input.stdout.write(`\u001b[36m▌\u001b[0m \u001b[1mezio\u001b[0m \u001b[2m› ${tail}\u001b[0m\n`);
	};

	const renderUsage = (u: NonNullable<Extract<ProtocolEvent, { type: "assistant_turn_finished" }>["usage"]>) => {
		const parts: string[] = [];
		if (typeof u.contextTokens === "number") {
			let s = `context ${fmtTokens(u.contextTokens)}`;
			if (typeof u.contextLimit === "number" && u.contextLimit > 0)
				s += ` / ${fmtTokens(u.contextLimit)} (${Math.floor((u.contextTokens * 100) / u.contextLimit)}%)`;
			parts.push(s);
		}
		if (typeof u.outputTokens === "number") parts.push(`out ${fmtTokens(u.outputTokens)}`);
		if (typeof u.cachedTokens === "number" && u.cachedTokens > 0) parts.push(`cached ${fmtTokens(u.cachedTokens)}`);
		if (parts.length > 0) input.stdout.write(`\u001b[2m${parts.join(" · ")}\u001b[0m\n`);
	};

	const renderPrompt = () => input.stdout.write("\u001b[2m›\u001b[0m ");

	let lastUsage: Extract<ProtocolEvent, { type: "assistant_turn_finished" }>["usage"];
	// Banner is rendered ONCE (spec: "render the banner once"). The mount-mode
	// auto-status-on-ready triggers it; later M4 `status` controls must NOT
	// re-render it.
	let bannerRendered = false;
```

In `onEvent`, add a `status` case and extend `assistant_turn_finished` + `idle`:

```ts
			case "status": {
				if (!bannerRendered) {
					renderBanner(event.provider, event.model, event.effort ?? "");
					bannerRendered = true;
				}
				break;
			}
			case "assistant_turn_finished": {
				sawTurn = true;
				lastContent = event.content;
				lastUsage = event.usage;
				break;
			}
			case "idle": {
				if (!sawTurn) break; // startup idle — nothing to hand back
				const content = lastContent;
				lastContent = "";
				sawTurn = false;
				for (const h of turnFinishedHandlers) h(content);
				if (lastUsage) renderUsage(lastUsage);
				lastUsage = undefined;
				renderPrompt();
				break;
			}
```

(Render the usage line + prompt on `idle` so they land after the turn's streamed
text and after the M6 handback fires. The `›` prompt is rendered every completed
turn, giving the REPL look.)

- [ ] **Step 5: Build + run adapter tests**

Run: `cd /Users/vuphan/Dev/ai-whisper && pnpm --filter @ai-whisper/adapter-ai-ezio build && pnpm vitest run test/adapter-ai-ezio-live-session.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit (ai-whisper)**

```sh
cd /Users/vuphan/Dev/ai-whisper
git add packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts test/adapter-ai-ezio-live-session.test.ts
git commit -m "M7 adapter: render banner (status) + usage line + prompt on turn finish"
```

---

### Task 5: e2e — assert banner + prompt over the real protocol (ai-whisper)

**Files:**
- Modify: `scripts/ai-ezio-mount-relay-e2e.mjs`

- [ ] **Step 1: Add assertions for the M7 wire output**

The M5 mount e2e already spawns a real `whisper collab mount ezio` (real hax,
`HAX_PROVIDER=mock`) and captures the mount pane via `mountLog`. After the relay
handback succeeds, assert the pane rendered the banner and a prompt:

```js
// M7: the mounted pane shows a REPL-like banner on ready AND a `›` prompt AFTER
// the driven turn. The banner itself contains one `›` (`ezio › provider · …`),
// so a prompt-after-turn must add at least one MORE — assert >= 2 occurrences,
// and that a prompt appears in the pane output AFTER the banner line.
const bannerMatch = /ezio[^\n]*›[^\n]*\n/.exec(mountLog);
if (!bannerMatch) { cleanup(); console.error("FAIL: no M7 banner line in mount pane\n" + mountLog.slice(-2000)); process.exit(1); }
const afterBanner = mountLog.slice(bannerMatch.index + bannerMatch[0].length);
const promptCount = (mountLog.match(/›/g) || []).length;
// >= 2 total `›` (banner + >= 1 post-turn prompt) AND a `›` rendered after the
// banner line — proves the per-turn prompt, not just the banner glyph.
if (promptCount < 2 || !afterBanner.includes("›")) {
	cleanup();
	console.error("FAIL: no post-turn `›` prompt after the driven turn (banner-only)\n" + mountLog.slice(-2000));
	process.exit(1);
}
console.log("OK: M7 banner on ready + post-turn `›` prompt rendered in the mounted ezio pane");
```

Place these before the final `process.exit(0)`, AFTER the existing handback proof
(so a turn has been driven). The hax binary used by the e2e is
`../ai-ezio/vendor/hax/build/hax` — rebuilt in Task 3, so the M7 status/usage
events are emitted. (Note: ANSI may interleave in the pty log; match the `›` glyph
loosely as above rather than exact escape sequences.)

- [ ] **Step 2: Build + run the e2e**

Run: `cd /Users/vuphan/Dev/ai-whisper && pnpm -r build && pnpm run e2e:ai-ezio-mount`
Expected: the existing OK lines plus `OK: M7 banner + prompt rendered...`, exit 0.
If the banner text isn't present, confirm the e2e's `AI_EZIO_HAX_BIN` points at the
rebuilt binary and that `meson compile` ran in Task 3.

- [ ] **Step 3: Commit (ai-whisper)**

```sh
cd /Users/vuphan/Dev/ai-whisper
git add scripts/ai-ezio-mount-relay-e2e.mjs
git commit -m "M7 e2e: assert mounted ezio pane renders banner + prompt"
```

---

### Task 6: UPSTREAM note, pin submodule, full gate, finish

**Files:**
- Modify: `UPSTREAM.md` (ai-ezio)
- Modify: `docs/milestones.md` (ai-ezio)

- [ ] **Step 1: Note the emitter surface change in `UPSTREAM.md`**

Add a bullet to the emitter-patch description: M7 widens the emitter to carry
`status.effort` (+ auto-emit on ready in mount mode) and `assistant_turn_finished.usage`
— still confined to `src/protocol/emit.{c,h}` + a few lines in `agent.c`; candidate
for upstream as part of the observer/emitter seam.

- [ ] **Step 2: Mark M7 in `docs/milestones.md`**

Add an `## M7 — Mounted ezio REPL parity ✅` section summarizing banner/prompt/usage
(rendered from protocol events; engine stays protocol-native), linking this plan
and the spec.

- [ ] **Step 3: Full verification gate**

ai-ezio:
```sh
cd /Users/vuphan/Dev/ai-ezio
meson compile -C vendor/hax/build && meson test -C vendor/hax/build
pnpm -r build && pnpm -r test
```
ai-whisper:
```sh
cd /Users/vuphan/Dev/ai-whisper
pnpm -r build && pnpm typecheck && pnpm lint && pnpm test && pnpm run e2e:ai-ezio-mount && pnpm run e2e:ai-ezio-workflow
```
Expected: all green — including `e2e:ai-ezio-workflow`, which re-verifies the M6
full spec-driven-development run is unchanged by the adapter rendering. Fix any lint findings inline with scoped
`// eslint-disable-next-line <rule> -- <reason>` (M5/M6 precedent). Prettier
repo-wide drift is pre-existing and NOT a gate; eslint is the enforced gate.

- [ ] **Step 4: Commit docs (ai-ezio)**

```sh
cd /Users/vuphan/Dev/ai-ezio
git add UPSTREAM.md docs/milestones.md
git commit -m "M7: UPSTREAM emitter note + milestone marker"
```

- [ ] **Step 5: Finish both branches**

Announce: "I'm using the finishing-a-development-branch skill to complete this work."
Then follow superpowers:finishing-a-development-branch for EACH repo (ai-ezio first
— it provides the engine/protocol the adapter builds against — then ai-whisper):
present the verified-green summary and the merge options (the M6 precedent: verify
on the branch, then `git checkout master && git merge --ff-only m7-mounted-repl-parity`,
then push). Do not merge without the full gate green. **Pin the new hax emitter
commit as the submodule base if ai-ezio tracks `vendor/hax` by pinned commit**
(per `UPSTREAM.md`) — rebuild and re-run `meson test` after pinning.

---

## Edge cases & test coverage summary

- **Backend didn't report a token field** (hax `-1`, or `cached <= 0`) → that field
  is omitted from `usage`; `usage` is omitted entirely when none qualify (Task 2
  C test + adapter "skips unreported" test).
- **Empty `effort`** → banner shows `provider · model` with no trailing `· ` (adapter
  "omits the effort segment" test).
- **status auto-emitted on ready in mount mode** → proven at the engine level
  (Task 3 `test_mount_repl`: real hax + mock asserts `status` is the event right
  after `ready`, carrying provider/model/effort); the adapter renders the banner
  before any turn. In non-mount protocol sessions the banner only appears if a
  `status` control is sent (unchanged M4 behavior).
- **Banner rendered once** → the adapter guards on `bannerRendered`, so a later
  M4 `status` control does not duplicate the banner (adapter "renders the banner
  only once" test).
- **Usage from the real mock turn path — present AND omitted** → engine-level
  `test_mount_repl` drives two mock turns: turn 1 scripts counts
  (`usage in=100 out=50 cached=10`) → asserts `assistant_turn_finished.usage` =
  `{contextTokens:150, outputTokens:50, cachedTokens:10}`; turn 2 scripts none
  (`-1` counts) → asserts the second `assistant_turn_finished` has **no `usage`
  key**. Catches an `agent.c`/mock-`EV_DONE` wiring regression in either direction
  — neither the direct emitter unit test nor a present-only engine test would.
- **No usage on a turn** → the `›` prompt is still rendered (REPL look preserved).
- **Post-turn prompt, not just banner glyph** → the mount e2e asserts ≥2 `›`
  occurrences and a `›` after the banner line, proving a per-turn prompt.
- **M6 behavior unchanged** → the full gate runs **both** e2e
  (`e2e:ai-ezio-mount` + `e2e:ai-ezio-workflow`), re-verifying the M6 SDD run.
- **Human REPL + mount-chrome suppression unchanged** → `test_mount_chrome` still
  passes; `display_usage`/banner suppression in mount mode is untouched (we emit
  protocol data, we don't re-enable the human rendering).
- **Back-compat** → all protocol fields optional; the JSONL codec passes unknown/
  absent fields through; M4 `status` control still answered.

## Out of scope (per spec — do not implement)

Re-enabling hax's real REPL in a mount (PTY + scraping); `/help`, conversation-reset
UI, live in-place repaint/cursor management, dock-bounce/notification; surfacing the
banner/usage to the dashboard/operator view.
