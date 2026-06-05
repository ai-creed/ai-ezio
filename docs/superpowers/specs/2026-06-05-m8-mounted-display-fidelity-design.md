# M8 — Mounted ezio display fidelity (markdown · spinner · tool rendering)

- **Status:** approved (brainstorm 2026-06-05)
- **Milestone:** M8 (follow-up to M7) — make a mounted ezio feel like a real,
  human-friendly coding agent (hax-REPL parity for the daily driver)
- **Repos touched:** ai-ezio (hax emitter + protocol + docs) and ai-whisper (adapter)
- **References:** `docs/architecture.md`, `docs/protocol.md`, `UPSTREAM.md`,
  the M7 spec/plan (`2026-06-05-m7-mounted-repl-parity-*`).

## Problem

M7 gave the mounted ezio pane a banner, a per-turn usage line, and a `›` prompt —
a good start. But for daily coding use it still falls short of the hax REPL:
assistant text is dumped as **raw markdown** (literal `**`, backticks, list
dashes), **tool calls are invisible** (you can't see it run `bash` or edit a
file), there's **no "thinking" feedback** between submit and the first output, and
spacing is cramped (the usage line is glued onto the response with no separator).

The engine runs in `--mount-mode` with its REPL UI suppressed, so — as in M7 — we
**re-create the display on the adapter side from protocol events**, never
re-enabling hax's REPL or scraping a PTY. What's *pure presentation of data we
already have* is adapter-only (Tier 1); what needs engine-internal data (tool
args/output/diffs) is a minimal emitter extension (Tier 2).

## Decisions (locked in brainstorm)

| Decision | Choice |
| --- | --- |
| Markdown rendering | **Render the final `assistant_turn_finished.content` formatted at turn end** (full-text markdown→ANSI); show a thinking **spinner** during the turn. No live streaming of `assistant_delta` to the pane (it is still forwarded to `onProviderOutput` for relay capture). |
| Markdown renderer | **Hand-rolled, dependency-free** TS renderer (`render-markdown.ts`) over a markdown lib — full control, matches hax's look + ai-whisper's no-heavy-deps ethos; only the final text needs handling (not streaming). |
| Tool display | **hax-parity:** dim one-line invocation (`⏺ <name> · <args>`), a dim truncated output preview, and a full **colored unified diff** when the tool's output is a diff (edit/write). |
| Tool data source | Tool **args/result/isDiff** are surfaced by the **emitter** (M7-style staged fields), sourced from `agent.c`'s tool-dispatch path (where name, final args, result, and `tool->output_is_diff` are all available). |
| Delivery | **One spec, one plan, both tiers, merge once.** |
| Architecture | Extract a focused **`mounted-renderer.ts`** in the adapter that owns all pane presentation; the live-session stays thin and forwards events to it. |

## Architecture

```
hax (--mount-mode, protocol fds)
  └─ emitter: lifecycle + stream events + (M8) tool args/output/isDiff
        │ JSONL events (fd 3)
        ▼
ai-whisper adapter
  create-ai-ezio-live-session.ts  (thin: lifecycle, handlers, submit)
        └─ mounted-renderer.ts     (owns ALL stdout presentation)
              ├─ render-markdown.ts (full-text markdown → ANSI)
              ├─ banner / usage / prompt (from M7, moved in + separator fix)
              ├─ spinner (thinking indicator)
              └─ tool rendering (invocation + output preview + colored diff)
```

`mounted-renderer.ts` is a pure unit: construct it with a `stdout` sink, feed it
`ProtocolEvent`s via `handle(event)`, and it writes ANSI. No engine/PTY
dependency — fully testable by feeding event sequences and asserting the captured
stdout string. `create-ai-ezio-live-session.ts` keeps its `InteractiveSession
Controller` responsibilities (start/stop/writeUserInput/handlers/onTurnFinished)
and delegates every display concern to the renderer.

## Tier 1 — adapter rendering (no engine change)

Driven entirely by existing protocol events. All of this lives in
`mounted-renderer.ts` + `render-markdown.ts`.

- **Markdown at turn end.** On `assistant_turn_finished`, render `event.content`
  through `render-markdown.ts` and write it to the pane (after stopping the
  spinner, with a block separator). Stop writing raw `assistant_delta` to stdout;
  still forward deltas to `onProviderOutput` handlers (relay capture unaffected).
- **Thinking spinner.** After `user_turn_started`, show an animated braille
  spinner + `thinking…` on its own line; clear it (carriage-return + clear-line)
  on the first real output of the turn (a `tool_call_started` or the
  `assistant_turn_finished` content). Adapter-side timer (~80ms frames); the
  timer is **stopped/cleared on `idle`** and on any turn-ending event, so it is
  never left running across `idle` (no leaked interval). The timer is supplied
  through an **injectable seam** (`setInterval`/`clearInterval` or a clock passed
  to the renderer) so the idle-safety case is deterministically testable.
- **Block separators.** Exactly one blank line between logical blocks — banner,
  tool calls, assistant text, usage line, prompt — mirroring hax's `disp`
  "exactly one blank line" rule. **Fixes the M7 usage-glue bug** (usage line now
  starts on its own line).
- **Prompt parity.** Render hax's magenta-bold `❯` (`PROMPT_UTF8`) instead of the
  dim `›`, with an ASCII `>` fallback when the locale isn't UTF-8. UTF-8 detection
  is an **injectable seam** on the renderer (e.g. a `utf8?: boolean` option,
  defaulting to a locale probe) so both the `❯` and the `>` fallback paths are
  unit-testable without changing the process locale.
- **Error rendering.** `error` events render in red (`▌` stripe + message) **and
  are followed by a prompt**, so the pane returns to a usable state after an error.
- **`render-markdown.ts`** — hand-rolled, no dependency (~200 lines). Handles:
  ATX headers (`#`..`######`), bold/italic (`**`/`*`/`_`), inline code
  (`` `code` ``), fenced code blocks (```` ``` ````) rendered as a dim/indented
  block (no intra-block syntax highlight in v1), unordered/ordered lists
  (`-`/`*`/`N.`), blockquotes (`>`), and links (`[text](url)` → `text` dim-url).
  Unknown/edge markdown degrades to plain text. Pure `string → string`.

## Tier 2 — emitter extension + tool rendering

**Protocol (documented in `docs/protocol.md` first, optional/back-compat):**
- `tool_call_started` gains optional `args?: string` — a one-line summary of the
  tool call's arguments (e.g. the bash command, the file path).
- `tool_call_finished` gains optional `output?: string` and `isDiff?: boolean` —
  the tool's result text and whether it is a unified diff.

**hax emitter (minimal seam, M7-style — `emit.{c,h}` + `agent.c`):**
- The tool **result** is not a provider stream event; it is produced in
  `agent.c`'s dispatch loop, which holds the tool name, the final assembled args
  JSON, the result string, and the tool's `output_is_diff` flag. Stage these via
  new `emit_set_tool_args(...)` / `emit_set_tool_result(...)` (mirroring
  `emit_set_usage`) so the emitted `tool_call_started` carries `args` and
  `tool_call_finished` carries `output` + `isDiff`.
- Keep the surface tiny and document it in `UPSTREAM.md` (the emitter seam now
  also carries tool args/result — data hax already computes).

**Adapter tool rendering (in `mounted-renderer.ts`):**
- On `tool_call_started`: clear the spinner, write a dim one-liner
  `⏺ <name> · <args>` (args truncated to a sensible width).
- On `tool_call_finished`: when `isDiff`, render `output` as a colored unified
  diff (green `+` / red `-` lines, uncapped — like hax's diff tools); otherwise
  render a dim, truncated output preview (first N lines, `…(+M)` elision) with the
  call's `status` (`ok`/`error`, error in red).
- Tool blocks render **live** as their events arrive (so the user sees activity
  mid-turn); the final assistant prose still renders formatted at
  `assistant_turn_finished`.

## Testing

- **`render-markdown.ts`** (vitest): a fixture per construct (header, bold,
  inline code, fenced block, list, blockquote, link, mixed) → expected ANSI;
  plain text passes through; malformed markdown degrades gracefully.
- **`mounted-renderer.ts`** (vitest): feed event sequences, assert the captured
  stdout (and, where noted, observable side effects). Each of these is a REQUIRED
  committed case — the wording maps 1:1 to a behavioral requirement above:
  - **Banner once** — repeated `status` events render the banner exactly once.
  - **No-raw-delta (renderer layer):** feeding an `assistant_delta` writes
    **nothing** to the pane stdout (the renderer suppresses raw deltas). This is
    the renderer's half of the requirement; the `onProviderOutput` forwarding half
    is asserted at the live-session layer below (the renderer does not own
    handlers).
  - **Markdown at turn end:** `assistant_turn_finished.content` renders as the
    formatted markdown block (via `render-markdown.ts`).
  - **Spinner shown then cleared:** after `user_turn_started` the spinner is
    written; the first real output (a `tool_call_started` or the finished content)
    clears it (carriage-return + clear-line in stdout).
  - **Spinner idle-safety (req. "never left running across `idle`"):** drive
    `user_turn_started` → `idle` (or turn completion) and assert the spinner's
    timer/interval is stopped/cleared and no further spinner frames are written
    after `idle` (inject a fake timer/clock so the test asserts no post-idle
    frame and that the interval was cleared — no leaked timer).
  - **Tool rendering:** a `tool_call_started{args}` renders `⏺ name · args`; a
    `tool_call_finished{output,isDiff:true}` renders a colored unified diff; an
    `isDiff:false` output renders a dim truncated preview; an error status renders
    red.
  - **Usage separator (M7 glue-bug fix):** the usage line begins on its own line
    (preceded by a newline / block separator), not appended to the prior content.
  - **Prompt parity — UTF-8 and ASCII fallback:** with a UTF-8 locale the prompt
    is `❯`; with a non-UTF-8 locale (inject the locale/`isUtf8` seam) the prompt
    is the ASCII `>` fallback. Both committed.
  - **Error → prompt recovery (req. "render red then return to a prompt"):** an
    `error` event renders red AND is followed by a prompt glyph, so the pane is
    usable again after an error (assert both the red error and the trailing prompt).
- **`create-ai-ezio-live-session.ts`** (vitest, adapter integration): the
  live-session owns the `InteractiveSessionController` handler path, so the
  relay-capture half of the no-raw-delta requirement is asserted here — a
  registered `onProviderOutput` handler **receives** the `assistant_delta` text
  (proving deltas are still forwarded for relay capture even though the renderer
  suppresses them from the pane). Together with the renderer's "no-raw-delta"
  case above, this covers the full "stop writing raw deltas to stdout, still
  forward to `onProviderOutput`" requirement across the correct two layers.
- **hax** (`meson`): emitter unit test for `tool_call_started.args` /
  `tool_call_finished.output`/`isDiff`; extend the engine-level `test_mount_repl`
  to drive a scripted mock **tool** turn and assert the args/output/isDiff arrive
  over the protocol.
- **e2e** (`e2e:ai-ezio-mount`): extend to drive a tool turn (mock script) and
  assert the pane shows a `⏺ ` tool line + a diff/preview, plus the existing
  banner + post-turn prompt assertions. Both e2e (`mount` + `workflow`) stay in
  the gate so M6/M7 behavior is re-verified.

## Done when

A mounted ezio pane renders, entirely from protocol events (engine stays
protocol-native): assistant prose as **formatted markdown** at turn end, a
**thinking spinner** while working, **tool calls** as dim invocation lines with
output previews and **colored diffs**, a clean **usage line** on its own line, and
a magenta `❯` prompt — a daily-usable coding-agent UX comparable to the hax REPL.
codex/claude mounts and all M6/M7 behavior are unchanged; full verification gate
(hax `meson test`, ai-ezio build/test, ai-whisper build/typecheck/lint/test, both
e2e) green.

## Out of scope (YAGNI — named so we don't creep)

- Live streaming markdown (rejected — render-at-end chosen).
- Reasoning / "thinking-label" deltas, retry, and progress events (separate
  emitter fields; defer to a later milestone if wanted).
- Cursor-level in-place repaint of streamed text (hax's `disp` pixel-perfect
  redraw is a mount-mode non-goal).
- Syntax highlighting *inside* fenced code blocks (dim block only in v1).
- Re-enabling hax's real REPL / any PTY scraping.

## Risks

| Risk | Mitigation |
| --- | --- |
| Markdown renderer correctness/edge cases | Fixture-driven tests per construct; graceful degradation to plain text; v1 scope deliberately bounded (no intra-code highlight). |
| Tool-result emitter hook is genuinely new engine surface | Keep it at the `agent.c` dispatch seam via staged `emit_set_tool_*` (no new top-level loops); document in `UPSTREAM.md`; data is already computed by hax. |
| Render-at-end changes M5's "stream deltas to stdout" choice | Intended; relay capture still receives deltas via `onProviderOutput`. The pane shows a spinner during the turn instead of raw tokens. |
| Large tool output / diffs flood the pane | Truncate non-diff previews (first N lines + elision); diffs uncapped (matches hax) but still dim-framed; cap pathological sizes defensively. |
| Renderer logic creeps into the live-session | All presentation lives in `mounted-renderer.ts`; the live-session only forwards events + owns lifecycle. |
