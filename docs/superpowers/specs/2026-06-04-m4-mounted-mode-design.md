# M4 — Mounted mode design spec

- **Date:** 2026-06-04
- **Status:** approved (brainstorm), pre-implementation
- **Milestone:** M4 (Mounted mode)
- **Parent spec:** `docs/superpowers/specs/2026-06-03-ai-ezio-design.md`
- **Builds on:** M3 (Protocol MVP) — `docs/superpowers/specs/2026-06-03-m3-protocol-mvp-design.md`,
  `2026-06-04-m3b-protocol-full-mvp-design.md`
- **References:** `docs/protocol.md`, `docs/milestones.md` (M4), `docs/skills.md`,
  `UPSTREAM.md`
- **Canonical copy:** `~/.ai-pref-nsync/local-docs/ai-ezio/specs/` (this file is the synced mirror)

## Purpose & scope reframe

M3 already delivers the core mounted capability — a programmatic client submits
over fd 4 and receives the authoritative handback over fd 3, no clipboard, no
scraping (the milestones.md "done when" for M4 is, strictly, already met). So M4
is **the remaining controls + a clean mounted posture + an extensible slash-command
seam**, not the core loop:

1. `--mount-mode` (explicit mounted posture; suppress residual chrome).
2. The three remaining controls: `copy_last_response`, `new_conversation`, `status`.
3. A **general, upstreamable slash-command seam** in hax, with `/skills` as the
   first downstream consumer (interactive `/skills` was moved here from M2).

## Decisions (locked in brainstorm)

| Decision | Choice |
| --- | --- |
| `--mount-mode` | Thin flag: explicit mounted posture + suppress banner/usage chrome. Most suppression is already achieved (control-fd path skips the prompt; harness ignores child stdout; non-tty disables raw mode) |
| Control dispatch | The between-turns input-source swap becomes a small dispatcher: `submit`→run, `copy_last_response`→re-emit, `new_conversation`→reset, `status`→emit. `interrupt` stays on the stream tick |
| `copy_last_response` | `emit.c` stores the last `assistant_turn_finished.content` and re-emits that event on the control (no clipboard; settled by the M3-review ruling) |
| `new_conversation` | Calls hax's existing `agent_new_conversation()` (small `agent.c` hook) |
| `status` | Emits a `status` event; payload `{model, provider, protocol, sessionId, state, contextPercent?}` (see below) |
| `/skills` | A **general** slash-command registration seam in hax (upstreamable, like `agent_observer`); a downstream C handler registers `/skills`. Extensible for future commands |
| Ezio skills → engine-visible | A **general** hax knob (`HAX_EXTRA_SKILLS_DIR` env) makes hax read an additional skills dir for the model prompt; ai-ezio sets it to the ai-ezio-global dir at launch, so ezio's own skills are **injected into the model** (not just listed). Removes the M2 engine-visibility caveat |
| Engine boundary | M4 **deliberately widens** the hax patch beyond M3's `emit.c`-only guardrail — each addition stays a small, documented seam |

## Components

### 1. `--mount-mode` flag (chrome)

A new CLI flag (alongside `--protocol-fd`/`--control-fd`). Mounted suppression is
mostly already in place; `--mount-mode` makes it explicit and additionally
silences the startup banner and the per-turn usage/"resume with" lines so the
child's stdout stays quiet. It does **not** change the protocol — events still go
on fd 3, controls on fd 4. (Presence of `--control-fd` already drives headless
input; `--mount-mode` is the posture/chrome switch.)

### 2. Between-turns control dispatch

Today the input-source swap (`emit_read_submit`) returns only a `submit`'s text.
M4 generalizes it to read **any** control. The split, to keep each piece on its
right side of the boundary:

- `copy_last_response` → handled **inline in the reader** (emit.c only — it has
  the stored content); re-emit and keep reading.
- `submit` → reader returns the text → the agent loop runs the user turn.
- `new_conversation` → reader returns a tag → the agent loop calls
  `agent_new_conversation()` (needs agent state).
- `status` → reader returns a tag → the agent loop gathers session info and calls
  an emit helper (needs `model`/`provider`/`sessionId`).
- EOF → reader returns a shutdown tag → clean exit.

So the reader (emit.c) returns a small tagged result; only the controls that need
agent state (`new_conversation`, `status`) cross back into `agent.c`.

`interrupt` continues to ride the stream tick (mid-turn). The other controls are
handled **between turns** (at the input boundary), which is the only safe point
to act on them.

### 3. `copy_last_response` (emit.c)

`emit_state` gains a stored copy of the last `assistant_turn_finished.content`
(captured in the `on_turn_finished` observer callback). On a `copy_last_response`
control, the emitter re-emits an `assistant_turn_finished` carrying that stored
content (with the prior `turnId`). If no turn has completed yet, it emits an
`error{message:"no previous response"}` (turn-less). No new turn runs; no
clipboard. Self-contained in `emit.c`.

### 4. `new_conversation` (agent.c)

On the control, the agent loop calls hax's existing
`agent_new_conversation(&state)` (clears history, resets the transcript). The
emitter then emits an `idle` so the client knows the engine is ready for the next
`submit` in a fresh conversation. Small `agent.c` integration at the dispatch
point.

### 5. `status` (agent.c + emit.c)

On the control, the agent gathers session info and the emitter writes a `status`
event:

```json
{"type":"status","model":"...","provider":"...","protocol":"0.1.0",
 "sessionId":"...","state":"idle","contextPercent":null}
```

- `model` = `sess.model`; `provider` = `p->name`; `protocol` =
  `AI_EZIO_PROTOCOL_VERSION`; `sessionId` = the session id/hint.
- `state` is `"idle"` in M4: `status` is dispatched between turns (the only point
  the input loop runs), so the engine is idle when it answers. Mid-turn `status`
  (→ `"busy"`, live `contextPercent`) is a future enhancement.
- `contextPercent` is optional/`null` in M4 (hax doesn't always know the context
  window); wired later when reliably available.

`status` is added to the protocol **events** (hax → harness, fd 3); the `status`
**control** (harness → hax, fd 4) already exists as typed groundwork.

### 6. General slash-command seam + `/skills` (hax)

- **Upstreamable seam:** hax gains a small registration mechanism for slash
  commands — e.g. a registry of `{name, help, run(args)}` consulted by
  `slash_dispatch` before falling through to "send to model". General-purpose
  (any embedder can add commands); mirrors the `agent_observer`/`provider`/`tool`
  seam pattern. This is the extensible foundation the user asked for.
- **Downstream `/skills` handler:** a small downstream C command registers
  `/skills`; when invoked in the REPL it lists discovered skills (its own
  enumeration of the three honored dirs from `docs/skills.md`: project
  `.agents/skills/`, ai-ezio-global, hax-global) and prints them to the terminal.
- **Surface:** `/skills` is a **human-REPL** command — it renders to the terminal
  (stdout), like other slash commands. It is **not** a protocol control; a
  machine client gets skills via `ai-ezio skill list`/`doctor` (M2). It works
  whether the line came from the TTY or a mounted `submit` (both flow through
  `slash_dispatch`), but its output is terminal text, so it's meaningful for
  humans.

### 7. Ezio's own skills → engine-visible (the bridge)

M2 gave ai-ezio its own skills dir (`${XDG_CONFIG_HOME:-$HOME/.config}/ai-ezio/skills/`)
but flagged a caveat: hax builds the model's "# Skills" prompt section from only
the dirs *it* reads (project + hax-global), so an ai-ezio-global skill was
**listed** but **not injected into the model**. `docs/skills.md` deferred the
bridge to "mounted mode (M3/M4) … via a future hax knob." M4 delivers it:

- **General hax knob (upstreamable):** hax honors one **additional** skills
  directory from an env var (`HAX_EXTRA_SKILLS_DIR`), enumerated into the
  "# Skills" prompt section alongside its existing dirs. General-purpose — any
  embedder can point hax at more skills.
- **ai-ezio wiring:** both launch paths — the CLI human REPL
  (`packages/cli`) and the mounted harness spawn (`packages/harness`) — set
  `HAX_EXTRA_SKILLS_DIR` to the resolved ai-ezio-global skills dir.
- **Result:** ezio's own skills are now **listed *and* loaded into the model** —
  engine-visible. The M2 caveat is removed; `docs/skills.md` is updated (the
  ai-ezio-global row becomes engine-visible, the caveat/`doctor` note dropped),
  and `/skills` (Component 6) now lists exactly the dirs the engine reads.

## Engine seam details (grounded in hax source)

- `agent.h` already exposes `void agent_new_conversation(struct agent_state *st)`.
- `slash.c` / `slash_dispatch(line, ctx)` returns `SLASH_NOT_A_COMMAND` for
  non-commands — the natural place to consult a custom-command registry first.
- `emit_read_submit` (today) is the between-turns reader → generalize to a
  control dispatcher returning a tagged result.
- `emit_state` already stores `turn_id`; add a stored last-content buffer for
  `copy_last_response`, set from `on_turn_finished`.
- Status fields come from `struct agent_session` (`model`) and `struct provider`
  (`name`), both in scope at the dispatch point.
- `agent_env.c` already enumerates skills (`append_skills`/`collect_skills`) from
  the project + hax-global dirs into the "# Skills" prompt section — the natural
  place to also read `HAX_EXTRA_SKILLS_DIR` (the engine-visibility bridge).

## Engine-boundary note

M4 widens the hax patch beyond M3's `emit.c`-only surface:
`--mount-mode` flag (`main.c`), the control-dispatch generalization
(`emit.c` + a small `agent.c` integration), the `new_conversation`/`status`
hooks (`agent.c`), the stored-last-content + re-emit (`emit.c`), the
slash-command seam + downstream `/skills` (`slash.c` + a new downstream file),
and the `HAX_EXTRA_SKILLS_DIR` knob (`agent_env.c`). Each is a small, documented
seam; the slash seam and the extra-skills knob are upstreamable. This is the
expected cost of mounted mode and is recorded in `UPSTREAM.md`.

## Testing

- **Deterministic:** `HAX_PROVIDER=mock`.
- **C (engine):**
  - the slash seam: registering a command makes `slash_dispatch` route to it.
  - `/skills` listing — **REQUIRED to cover the ai-ezio-global dir, not just
    project**: with a fixture skill in the **ai-ezio-global** dir (point its
    resolution at a temp `${XDG_CONFIG_HOME}/ai-ezio/skills/<name>/SKILL.md`),
    assert `/skills` output includes that ai-ezio-global skill. (Also covers a
    project `.agents/skills/<name>/` skill.) A regression where `/skills` omits
    ai-ezio-global entries must fail this test.
  - the engine-visibility bridge: with `HAX_EXTRA_SKILLS_DIR` pointed at a fixture
    dir containing a skill, the model's "# Skills" prompt section includes that
    skill (assert via `agent_env` build output / the `HAX_TRANSCRIPT` mirror) —
    proving ezio's own skills reach the model, not just the listing.
  - controls over real fds: `copy_last_response` re-emits the prior
    `assistant_turn_finished.content` with **zero** new turns
    (no `user_turn_started`/`assistant_turn_started`); a `copy_last_response`
    **before any completed turn** yields a turn-less `error{message:"no previous
    response"}`; `new_conversation` → `idle` and a following turn starts fresh;
    `status` → a `status` event with the expected fields.
  - **`--mount-mode` chrome suppression — REQUIRED:** spawn hax with
    `--mount-mode` + the fds and stdout/stderr **captured** (not ignored), drive a
    mock turn, and assert the child's stdout/stderr contain **no** startup banner
    and **no** per-turn usage/"resume with:" lines (chrome suppressed). Contrast:
    the same run **without** `--mount-mode` does print them — so a regression that
    keeps emitting chrome under `--mount-mode` fails this test.
- **TS (harness + protocol):**
  - `StatusEvent` type + codec round-trip; harness methods
    `copyLastResponse()`, `newConversation()`, `status()`;
  - fake-engine / real-hax e2e: `copyLastResponse` returns the stored content
    without a new turn; `newConversation` resets; `status` resolves the payload.
- **Regression:** the no-fd **interactive** REPL stays byte-for-byte unchanged
  for normal use; a separate check exercises `/skills` rendering (the new slash
  path) and confirms it only affects output when `/skills` is typed.

## Done when

- `ai-ezio --mount-mode` runs with chrome suppressed; a client drives a full
  session over the fds using **all** M3+M4 controls: `submit`, `interrupt`,
  `copy_last_response` (re-emits prior content, no new turn, no clipboard),
  `new_conversation` (fresh conversation), and `status` (payload event).
- `/skills` works in the human REPL via the general slash seam, listing the
  honored skill dirs; the seam is general enough to register another command.
- A skill placed in the **ai-ezio-global** dir is both listed by `/skills` and
  **injected into the model's prompt** (via `HAX_EXTRA_SKILLS_DIR`) — ezio's own
  skills are engine-visible, and `docs/skills.md`'s caveat is removed.
- The no-fd interactive REPL remains byte-for-byte unchanged for normal use.

## Out of scope for M4

- Mid-turn `status` (`state:"busy"`, live `contextPercent`) — future.
- Surfacing `/skills` output over the protocol to machine clients (it's a
  human-REPL command; machines use `skill list`/`doctor`).
- ai-whisper adapter (M5) and workflow integration (M6); non-fd transports.
- Tool *execution* outcome reporting (still out, from M3).

## Risks

| Risk | Mitigation |
| --- | --- |
| Slash seam grows hax surface | Keep it a tiny generic registry + dispatch check; the `/skills` logic is downstream; document in `UPSTREAM.md`. Reuse hax's existing skill-dir knowledge. |
| `copy_last_response` before any turn | Emit a turn-less `error{message:"no previous response"}`; covered by a test. |
| Control dispatch corrupts the turn loop | Controls handled only between turns at the input boundary; `interrupt` stays on the tick; e2e covers each control + a following normal turn. |
| `/skills` C enumeration drifts from TS `skill list` | Both read the same three documented dirs; a test asserts a fixture skill appears in `/skills`. Acceptable minor duplication (different surfaces). |
| `--mount-mode` chrome suppression changes the no-fd REPL | `--mount-mode` only affects the mounted path; the no-fd interactive REPL regression must still pass byte-for-byte. |
| `HAX_EXTRA_SKILLS_DIR` unset on some launch path → ezio skills invisible | Both launch paths set it (CLI human REPL + mounted harness spawn); a test asserts the fixture skill reaches the prompt. Running the raw hax binary directly (no ai-ezio) simply doesn't get the extra dir — expected. |
