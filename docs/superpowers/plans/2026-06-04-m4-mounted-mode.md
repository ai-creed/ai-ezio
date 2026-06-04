# M4 — Mounted mode implementation plan

- **Date:** 2026-06-04
- **Status:** ready for execution
- **Source spec:** `docs/superpowers/specs/2026-06-04-m4-mounted-mode-design.md` (approved)
- **Builds on:** M3 (`docs/superpowers/specs/2026-06-03-m3-protocol-mvp-design.md`,
  `2026-06-04-m3b-protocol-full-mvp-design.md`)
- **References:** `docs/protocol.md`, `docs/skills.md`, `UPSTREAM.md`
- **Canonical copy:** `~/.ai-pref-nsync/local-docs/ai-ezio/plans/` (synced mirror)

## Goal

Add the remaining controls (`copy_last_response`, `new_conversation`, `status`),
a clean mounted posture (`--mount-mode` chrome suppression), a **general**
slash-command seam in hax (with `/skills` as the first downstream consumer), and
the **engine-visibility bridge** (`HAX_EXTRA_SKILLS_DIR`) so ezio's own skills
reach the model. Each step is test-first. M4 deliberately widens the hax patch
beyond M3's `emit.c`-only surface; every addition stays a small documented seam.

## Ground rules

1. **C style:** hax rules (4-space, snake_case, SPDX, `clang-format -i`,
   `make lint`).
2. **Engine boundary (M4 widens it):** allowed hax surface this milestone —
   `--mount-mode` (`main.c`/`hax_opts`), chrome gates (`agent.c`), the control
   dispatcher (`emit.c` + small `agent.c` integration), `new_conversation`/
   `status` hooks (`agent.c`), stored-last-content (`emit.c`), the slash
   registration seam (`slash.{c,h}`) + a downstream `/skills` file, and the
   `HAX_EXTRA_SKILLS_DIR` knob (`agent_env.c`). Anything beyond → stop.
2b. **Upstreamable seams stay general:** `slash_register` and
   `HAX_EXTRA_SKILLS_DIR` are general hax features (any embedder); ai-ezio-specific
   logic (`/skills` content) stays in a downstream file.
3. **No-fd interactive REPL stays byte-for-byte unchanged** for normal use
   (`repl-regression.py` must still pass). Chrome gates apply only when
   `--mount-mode` is set.
4. **Launch-path parity:** both ai-ezio spawn points (`packages/cli`,
   `packages/harness`) set `HAX_EXTRA_SKILLS_DIR`; the harness also passes
   `--mount-mode`.
5. **Submodule workflow:** C lands on the `vendor/hax` `emitter` branch, pushed to
   `ai-creed/hax`; then bump the submodule pointer in ai-ezio.

## Current state (what M4 edits)

- `vendor/hax/src/slash.{c,h}` — static `COMMANDS[]`, `find_command`,
  `slash_dispatch`; **no runtime registration API** (the seam to add).
  `struct slash_ctx { struct agent_state *state; }`.
- `vendor/hax/src/agent_env.c` — `append_skills`/`collect_skills` enumerate
  project `.agents/skills` + `xdg_hax_config_path("skills")` into the "# Skills"
  prompt section (the bridge point).
- `vendor/hax/src/agent.c` — `agent_print_banner` (startup), `display_usage`
  (per turn), the "resume with:" exit line (chrome to gate); `agent_run` loop +
  the M3 control-fd input swap calling `emit_read_submit`.
- `vendor/hax/src/protocol/emit.{c,h}` — `emit_read_submit` (between-turns
  reader), `emit_state` (has `turn_id`; add last-content buffer).
- `vendor/hax/src/main.c` — getopt; `hax_opts` (has `protocol_fd`/`control_fd`;
  add `mount_mode`).
- `packages/protocol` — `events.ts` (add `StatusEvent`), `controls.ts` (status/
  new_conversation/copy_last_response control types already exist).
- `packages/harness/src/{spawn,session}.ts` — `spawnHax`, `Session`.
- `packages/cli/src/cli.ts` — launcher (passthrough today).

---

## Phase 0 — prerequisites

Confirm `vendor/hax` on `emitter` (rebased `e2a7eaf`); `clang-format` available;
`make -C vendor/hax lint` clean. No code yet.

---

## Step 1 — `--mount-mode` flag + chrome gates [C, test-first]

1. **Test first (C):** a `protocol/mount_chrome` test (sibling of
   `observer_e2e`) spawns the real hax with `--mount-mode` + fds and stdout/stderr
   **captured to a pipe**, drives a mock turn, asserts the capture has **no**
   banner and **no** usage/"resume with:" lines; a contrast run **without**
   `--mount-mode` (but with the fds) **does** contain them. Red.
2. `main.c`/`agent_core.h`: add `--mount-mode` → `opts.mount_mode` (int, default 0).
3. `agent.c`: gate `agent_print_banner`, `display_usage`, and the
   `"resume with:"` line on `!opts->mount_mode`. (The prompt is already skipped in
   the control-fd path.)
4. `clang-format`; green.

*Risk: low — additive gates; the no-fd path (`mount_mode==0`) is unchanged.*

## Step 2 — general slash-command registration seam [C, test-first, upstreamable]

1. **Test first (C):** a `slash_register` test registers a throwaway command and
   asserts `slash_dispatch("/<cmd>")` routes to it (returns `SLASH_HANDLED` and
   the handler ran). Red.
2. `slash.h`: add `void slash_register(const struct slash_cmd *cmd)` (or a
   `name/summary/run` signature) + document the runtime registry. `slash.c`:
   keep a small dynamic/static registry of externally-registered commands;
   `find_command` / `slash_dispatch` consult built-ins **and** the registry.
3. `clang-format`; green. Keep it tiny + general (the spec's extensibility ask).

*Risk: low-med — must not change built-in dispatch behavior; test built-ins still work.*

## Step 3 — downstream `/skills` handler [C, test-first]

1. **Test first (C):** `HAX_EXTRA_SKILLS_DIR` is a **skills directory** (the
   parent that holds `<name>/SKILL.md` subdirs), exactly like the other honored
   dirs — *not* a file path. Set up a temp ai-ezio-global skills dir
   `<temp>/ai-ezio/skills/` containing a skill `<temp>/ai-ezio/skills/<name>/SKILL.md`,
   set `HAX_EXTRA_SKILLS_DIR=<temp>/ai-ezio/skills` (the directory), AND a project
   `.agents/skills/<name>/SKILL.md`; invoke the `/skills` handler and assert its
   output lists **both** the ai-ezio-global and the project skill (ai-ezio-global
   inclusion is required — omission fails). Red.
2. New downstream file `src/protocol/skills_cmd.{c,h}`: a `slash_run_skills`
   handler that enumerates the same dirs the engine reads — project
   `.agents/skills/`, hax-global, and `HAX_EXTRA_SKILLS_DIR` (the ai-ezio dir
   ai-ezio sets) — parses each `SKILL.md` (reuse the M2 frontmatter shape) and
   prints a list. Register it via Step 2's seam during agent init.
3. `clang-format`; green.

*Note:* `/skills` reads `HAX_EXTRA_SKILLS_DIR` for the ai-ezio dir so its listing
matches exactly what the engine injects (Step 4). Terminal output only (not a
protocol event), per spec.

## Step 4 — `HAX_EXTRA_SKILLS_DIR` engine-visibility bridge [C, test-first]

1. **Test first (C):** extend the `agent_env` skills test (or add one) — with
   `HAX_EXTRA_SKILLS_DIR` pointing at a fixture dir containing a skill, the built
   "# Skills" prompt section **includes** that skill. Red.
2. `agent_env.c` `append_skills`: after the project + hax-global dirs, also
   `collect_skills(getenv("HAX_EXTRA_SKILLS_DIR"))` when set. General knob.
3. `clang-format`; green.

## Step 5 — control dispatch: copy_last_response / new_conversation / status [C, test-first]

1. **Test first (C):** extend the fd-driver tests (a `protocol/controls_e2e`
   sibling) over real fds:
   - `copy_last_response` after a completed turn re-emits the prior
     `assistant_turn_finished` content with the prior `turnId` and **zero** new
     `user_turn_started`/`assistant_turn_started`;
   - `copy_last_response` **before any turn** → turn-less
     `error{message:"no previous response"}`;
   - `new_conversation` → `idle`, and a following `submit` starts fresh;
   - `status` → a `status` event with `model`/`provider`/`protocol`/`sessionId`/
     `state:"idle"`. Red.
2. `emit.h`/`emit.c`: add a last-content buffer to `emit_state`, set it in the
   `on_turn_finished` observer callback. Generalize `emit_read_submit` →
   `emit_read_control` returning a tagged result `{SUBMIT(text), NEW_CONVERSATION,
   STATUS, COPY_LAST(handled-inline), SHUTDOWN}`; `copy_last_response` is handled
   inline (re-emit or the turn-less error); `submit` returns text.
3. `agent.c` dispatch point (the M3 input swap): on `NEW_CONVERSATION` call
   `agent_new_conversation(&state)` then emit `idle`; on `STATUS` gather
   `sess.model` / `p->name` / sessionId and call an `emit_status(...)` helper.
4. Add the `status` JSON to `emit.c` (a new `emit_status` writing the payload).
5. `clang-format`; green. Engine suite stays green (M3 tests unaffected).

## Step 6 — protocol `StatusEvent` [TS, test-first]

1. **Test first:** codec round-trip for `StatusEvent`. Red.
2. `packages/protocol/src/events.ts`: add `StatusEvent` (`type:"status"`, `model`,
   `provider`, `protocol`, `sessionId`, `state`, `contextPercent?`); include in
   `ProtocolEvent`. Re-export. Green.

## Step 7 — harness control methods + launch wiring [TS, test-first]

1. **Test first:** harness unit/e2e (fake engine extended) — `copyLastResponse()`
   returns the stored content with no new turn; `newConversation()` resolves at
   the fresh `idle`; `status()` resolves the `StatusEvent`. Plus a unit asserting
   `spawnHax` sets `HAX_EXTRA_SKILLS_DIR` (to the ai-ezio-global dir) **and** passes
   `--mount-mode`. Red.
2. `session.ts`: add `copyLastResponse(): Promise<TurnResult>` (send control →
   resolve the re-emitted `assistant_turn_finished`, or reject `TurnError` on the
   no-previous-response error), `newConversation(): Promise<void>` (send → await
   `idle`), `status(): Promise<StatusEvent>` (send → await the `status` event).
3. `spawn.ts`: pass `--mount-mode`; set `HAX_EXTRA_SKILLS_DIR` in the child env via
   a shared `aiEzioGlobalSkillsDir()` helper (new, in harness — the lowest package
   both cli and harness use).
4. Extend the fake engine to answer `copy_last_response`/`new_conversation`/
   `status`. Green.

## Step 8 — public `ai-ezio --mount-mode` + CLI extra-skills env [TS, test-first]

1. **Test first:** (a) run the real `ai-ezio` CLI bin with
   `--mount-mode --protocol-fd --control-fd` (mock) + captured child stdout/stderr;
   assert `--mount-mode` reaches hax and the capture is chrome-suppressed; (b) a
   unit asserting the cli launch (both human-REPL and mount paths) sets
   `HAX_EXTRA_SKILLS_DIR`. Red.
3. `cli.ts`: when mounted flags are present, spawn hax forwarding
   `--mount-mode`/`--protocol-fd`/`--control-fd` with fds 3/4 inherited (stdio
   array passing the fd numbers); for all spawns (human REPL + mount), set
   `HAX_EXTRA_SKILLS_DIR` via the shared helper. Green.

## Step 9 — docs

- `docs/protocol.md`: document the `status` **event** payload + M4 idle/null
  semantics; confirm `copy_last_response`/`new_conversation` behavior.
- `docs/skills.md`: remove the engine-visibility caveat — the ai-ezio-global dir
  is now engine-visible via `HAX_EXTRA_SKILLS_DIR`; update the table + drop the
  `doctor` "not yet injected" note.
- `UPSTREAM.md`: record the new hax seams (slash registration, extra-skills knob,
  `--mount-mode`, control hooks) in the downstream change surface.

## Step 10 — verification, submodule bump, commit

1. C: `meson compile`/`meson test -C vendor/hax/build` (incl. mount_chrome,
   slash_register, /skills ai-ezio-global, agent_env extra-dir, controls_e2e);
   `make -C vendor/hax lint`.
2. TS: `pnpm -r build && pnpm -r test` (codec StatusEvent; harness methods +
   spawn-env unit; cli mount-mode + extra-skills unit/e2e).
3. Smoke/regression: `proto-smoke.py`; `repl-regression.py` vs the `e2a7eaf`
   baseline (no-fd REPL byte-for-byte); `pnpm run smoke:install`.
4. Push `emitter` to the fork; bump the `vendor/hax` pointer; commit ai-ezio
   (submodule + TS + docs).

**M4 done when (spec):** `ai-ezio --mount-mode` runs chrome-suppressed; a client
drives a full session using all M3+M4 controls; `/skills` lists the honored dirs
(incl. ai-ezio-global) via the general seam; an ai-ezio-global skill is both
listed and injected into the model prompt; the no-fd interactive REPL is
byte-for-byte unchanged.

## File inventory (guardrail budget)

**hax (`emitter`):**
- Edited: `main.c`, `agent_core.h` (`--mount-mode`); `agent.c` (chrome gates +
  control dispatch integration + slash registration call); `slash.{c,h}`
  (registration seam); `agent_env.c` (`HAX_EXTRA_SKILLS_DIR`); `protocol/emit.{c,h}`
  (control dispatcher, last-content, `emit_status`); `meson.build` + `tests/meson.build`.
- New: `src/protocol/skills_cmd.{c,h}` (downstream `/skills`); C tests
  `tests/protocol/{mount_chrome,slash_register,skills_cmd,controls_e2e}.c`
  (names indicative).

**ai-ezio (`packages/`, docs):**
- `packages/protocol/src/events.ts` (+codec test); `packages/harness/src/{spawn,
  session}.ts` + a shared `aiEzioGlobalSkillsDir()` helper (+tests, fake-engine);
  `packages/cli/src/cli.ts` (+tests).
- `docs/protocol.md`, `docs/skills.md`, `UPSTREAM.md`; submodule pointer bump.

## Testing strategy (deterministic, `HAX_PROVIDER=mock`)

- **C:** mount-mode chrome (captured stdout); slash seam routing; `/skills` lists
  the ai-ezio-global fixture; `agent_env` injects `HAX_EXTRA_SKILLS_DIR` skill
  into the prompt; controls over fds (copy_last_response incl. before-any-turn
  error, new_conversation, status).
- **TS:** `StatusEvent` codec; harness `copyLastResponse`/`newConversation`/
  `status`; `spawnHax` sets env + `--mount-mode`; public `ai-ezio --mount-mode`
  chrome-suppressed; both launch paths set `HAX_EXTRA_SKILLS_DIR`.
- **Regression:** no-fd interactive REPL byte-for-byte unchanged; `/skills` only
  changes output when typed.
- **Per-step TDD:** failing test first for every new seam/control.

## Verification commands

```sh
make -C vendor/hax lint
meson compile -C vendor/hax/build && meson test -C vendor/hax/build --print-errorlogs
pnpm -r build && pnpm -r test
python3 scripts/proto-smoke.py
# no-fd REPL regression vs the synced base (rebuild baseline at e2a7eaf):
python3 scripts/repl-regression.py <e2a7eaf-baseline> vendor/hax/build/hax
pnpm run smoke:install
```

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Chrome gates accidentally affect the no-fd REPL | Gate strictly on `opts->mount_mode`; the byte-for-byte no-fd regression must still pass. |
| Slash registry changes built-in dispatch | Keep built-ins first/unchanged; a test asserts an existing command (e.g. `/help`) still works. |
| `/skills` listing drifts from the engine's prompt dirs | Both read project + hax-global + `HAX_EXTRA_SKILLS_DIR`; tests assert the ai-ezio-global fixture appears in both `/skills` and the prompt. |
| `HAX_EXTRA_SKILLS_DIR` set by only one launch path | A unit per path (`spawnHax`, cli) asserts the env is set; shared helper = one source of truth. |
| Control dispatcher corrupts the turn loop | Controls handled only between turns; `interrupt` stays on the tick; controls_e2e covers each control + a following normal turn. |
| Public `ai-ezio --mount-mode` fd inheritance | cli uses an explicit stdio array forwarding fds 3/4; the public-cli test exercises a real mounted turn. |

## Execution order (summary)

Phase 0 → S1 (mount-mode + chrome) → S2 (slash seam) → S3 (/skills) → S4
(extra-skills bridge) → S5 (controls dispatch) → S6 (StatusEvent) → S7 (harness
methods + launch wiring) → S8 (public cli mount-mode + env) → S9 (docs) → S10
(verify, push fork, bump submodule, commit). Test-first each step; keep the
upstreamable seams general and the no-fd REPL unchanged.
