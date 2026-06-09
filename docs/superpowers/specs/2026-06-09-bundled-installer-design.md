# ai-ezio single-command bundled install + bootstrap

**Status:** Revised after autonomous SDD review round 1 (5 findings resolved), 2026-06-09
**Date:** 2026-06-09
**Topic:** Distribution / installer (proposed next milestone — "M10: distribution")
**Author:** ezio + Vu

---

## 1. Summary

Make ai-ezio installable with one command — `npm install -g ai-ezio` — and give
first-time users an interactive, default-yes opt-in to also install and
auto-configure the two sibling ecosystem tools, **ai-cortex** (memory) and
**ai-whisper** (workflows), as one flow. All ezio-owned configuration is written
automatically; anything ezio cannot own or supply is detected and printed as
actionable guidance. The flow is **idempotent and reconciling**: if cortex/whisper
are already installed, it does not reinstall them or clobber existing config — it
reconciles what it can and guides where it cannot.

## 2. Background — verified facts

These were verified against the live machine and the sibling repos; they shape the
whole design.

- **Nothing under `ai-ezio` / `@ai-ezio` is published to npm yet** (`npm view
  ai-ezio` → 404; `@ai-ezio/hax-darwin-arm64` → 404). The repo root is
  `ai-ezio-monorepo`, `private: true`. Completing publishable packaging is step
  zero; the chosen release target (§4.6 — public, unscoped npm) is what makes the
  required `npm install -g ai-ezio` command valid.
- **ezio already has the packaging skeleton**: `packaging/hax-<os>-<cpu>/` per-
  platform binary packages (only `darwin-arm64` carries a committed binary today)
  and an `mcp.json` config system at `${XDG_CONFIG_HOME:-$HOME/.config}/ai-ezio/
  mcp.json` consumed by `@ai-ezio/mcp-host`.
- **cortex and whisper integrate with ezio in opposite directions:**
  - **ai-cortex** is a stdio **MCP server ezio connects to** (`ai-cortex mcp`).
    Public, unscoped npm package (`ai-cortex`), Node/TS, no API key, self-manages
    `~/.cache/ai-cortex` + `~/.config/ai-cortex`. "Auto-config" = one `mcpServers`
    entry in ezio's `mcp.json`.
  - **ai-whisper** is a **CLI orchestrator that drives ezio** (it mounts ezio as
    an agent); it is **not** an MCP server ezio connects to. Public npm package
    (`ai-whisper`, bin `whisper`), Node/TS. The dependency direction is
    `whisper → ezio → cortex`, never the reverse, so bundling creates no npm cycle.
- **npm does not hoist a global package's nested deps to the shared global root.**
  Verified: `/opt/homebrew/lib/node_modules` has zero `@`-scoped dirs at the root;
  cortex's `@modelcontextprotocol/sdk` lives at
  `ai-cortex/node_modules/@modelcontextprotocol`, not at the root. Therefore a
  `@ai-ezio/hax-*` optional dep pulled in by `npm i -g ai-ezio` lands nested under
  `ai-ezio/node_modules` and is **not** visible to a sibling global `ai-whisper`.
- **whisper bundles ezio's exact `resolve-hax` logic** (verified at
  `ai-whisper/packages/cli/dist/bin/whisper.js:9310`) and that resolver honors the
  **`AI_EZIO_HAX_BIN` env override first**, before package resolution. So bridging
  whisper → ezio's binary is a one-variable env bridge, not a publishing/hoisting
  problem.
- **cortex's `history install-hooks` / `memory install-prompt-guide` are for
  making cortex capture claude/codex sessions** — irrelevant to ezio (ezio captures
  its own sessions via its built-in session-recorder). The wizard does **not** run
  them; it prints them as optional guidance for users who also use claude/codex.

## 3. Goals / Non-goals

### Goals

- `npm install -g ai-ezio` yields a working standalone ezio (CLI + matching hax
  binary), no peers required.
- A first-run interactive wizard (and explicit `ai-ezio init`) offers, default-yes,
  to install + wire ai-cortex and ai-whisper.
- ezio-owned auto-config is written automatically: cortex `mcp.json` entry + a
  durable `AI_EZIO_HAX_BIN` bridge so `whisper collab mount ezio` resolves ezio's
  engine in any new shell. A child process cannot mutate its parent shell, so the
  current shell needs a one-time `source`/restart that the wizard prints explicitly;
  the bridge persists automatically for all future shells.
- Smart, idempotent detection/reconciliation: never reinstall present peers, never
  auto-upgrade, never clobber existing config; reconcile where possible, guide where
  not.

### Non-goals

- Literally bundling cortex/whisper as dependencies inside the ai-ezio package
  (rejected — see §4, Approach B).
- Supplying secrets or third-party prerequisites (whisper's `ANTHROPIC_API_KEY`,
  external authenticated `claude`/`codex` CLIs) — detected + guided, never invented.
- Editing other tools' config files (`~/.claude/settings.json`,
  `~/.codex/config.toml`) — printed as guidance only.
- Supporting > 2 mounted agents or any non-macOS/Linux target.
- Windows fd/semantics.

## 4. Decisions

1. **Approach A — meta-installer wizard inside the `ai-ezio` package** (chosen).
   - **Approach B** (declare cortex/whisper as `optionalDependencies` of ai-ezio)
     rejected: no opt-in, peer bins not on PATH (npm non-hoisting), near-cycle with
     whisper, heavy per-install native builds.
   - **Approach C** (separate `create-ai-ezio` installer) rejected: changes the
     entry command away from `npm install -g ai-ezio` and adds a package to maintain.
2. **First-run wizard** (not npm postinstall prompting): `npm i -g` lays down files
   non-interactively/CI-safe; the interactive opt-in runs on first launch or via
   `ai-ezio init`.
3. **Self-contained + guide** auto-config reach: write only ezio-owned files (+ the
   explicit ezio↔whisper env bridge, with consent for the shell-profile line);
   detect-and-guide for everything else.
4. **Full scope for whisper**: install whisper *and* write a durable `AI_EZIO_HAX_BIN`
   bridge so ezio is mountable by whisper — immediately in any new shell; the current
   shell needs a one-time `source`/restart that the wizard prints (§5.4 — resolves
   reviewer finding 3).
5. **Smart detect + reconcile** is a first-class path, not an edge case (the author's
   own machine already has both peers + a hand-written `mcp.json`).
6. **Publish target: public, unscoped npm** (resolves reviewer finding 1; no longer
   deferred). `ai-ezio` publishes as the public unscoped package `ai-ezio`; the four
   `@ai-ezio/hax-<os>-<cpu>` binary packages publish as public scoped packages
   (`publishConfig.access = "public"`). This is precisely what makes the required
   `npm install -g ai-ezio` valid.

## 5. Architecture

### 5.1 Packaging topology (completing the M1-deferred bit)

Mirror ai-whisper's proven publish model:

- **Publish `ai-ezio` from `packages/cli`.** It already owns the `bin`
  (`ai-ezio`/`ezio`) and `name: "ai-ezio"`. Bundle the `@ai-ezio/*` TS libs (harness,
  protocol, mcp-host, surface, session-recorder) into the cli dist via esbuild (a
  `scripts/bundle.mjs` mirroring whisper's), so we publish **one** package, not six.
- **`@ai-ezio/hax-<os>-<cpu>` stay external + published**, each carrying its prebuilt
  binary, `os`/`cpu`-guarded so npm installs only the matching one (standard prebuilt
  pattern; skeleton already exists). Declared as `optionalDependencies` of `ai-ezio`,
  published with `publishConfig.access = "public"`.
- CI cross-compile fills the three non-`darwin-arm64` binaries (currently only
  `darwin-arm64` is committed).
- **Result:** `npm i -g ai-ezio` → working ezio + its hax binary, standalone.

**Published manifest (resolves reviewer finding 2).** Bundling code does *not* by
itself remove manifest dependencies — `pnpm pack` today rewrites the five
`workspace:*` `@ai-ezio/*` runtime deps into registry deps that will never be
published, yielding an uninstallable tarball. The published `ai-ezio` manifest is
therefore specified explicitly:

- **`dependencies`: empty.** The five `@ai-ezio/*` workspace libs
  (harness/protocol/mcp-host/surface/session-recorder) are inlined by esbuild and
  removed from `dependencies`; no `workspace:*` or `@ai-ezio/*` runtime dep survives in
  the shipped manifest.
- **Third-party runtime deps: bundled, not declared.** The libs pull in only pure-JS,
  bundleable third-party deps — `@modelcontextprotocol/sdk` (mcp-host) and `cli-table3`,
  `marked`, `marked-terminal`, `string-width` (surface); protocol/harness/
  session-recorder add none. esbuild inlines all of them and none is declared as a
  runtime `dependency`. (whisper already bundles this exact `@modelcontextprotocol/sdk`
  path, so it is proven bundleable. ezio's libs use no native modules.) **Policy:** if a
  future dep proves non-bundleable (e.g. ships native bindings), promote it to a real
  `dependencies` entry rather than leave it dangling — no current dep needs that.
- **`optionalDependencies`: only the four `@ai-ezio/hax-*` platform packages** — the
  sole runtime deps the published package declares.
- **Pack guard (CI).** A check runs `npm pack` on the publishable package and asserts
  the tarball's `package.json` has (a) zero `@ai-ezio/*` under `dependencies`, (b) zero
  `workspace:*` specifiers anywhere, and (c) only the four `@ai-ezio/hax-*` under
  `optionalDependencies`. Incomplete bundling fails the build instead of shipping an
  uninstallable package.

Package.json changes (`packages/cli`): keep `name: "ai-ezio"`, `bin`, `files`; add
`publishConfig.access = "public"`; **empty `dependencies`** post-bundle; keep the four
`@ai-ezio/hax-*` under `optionalDependencies`; add the `scripts/bundle.mjs` build step.

### 5.2 Bootstrap module + first-run flow

New bootstrap code in `packages/cli/src/bootstrap/`, invoked via explicit
`ai-ezio init` or auto-triggered on first interactive launch (marker-gated, runs
once). Proposed small, single-purpose modules:

- `detect.ts` — environment + peer presence/version detection (pure; fs/exec/env/
  PATH/TTY all injected).
- `versions.ts` — `MIN_CORTEX` / `MIN_WHISPER` table + compatibility check.
- `install-peers.ts` — package-manager detection + install of *missing* opted-in
  peers (exec seam).
- `reconcile-mcp.ts` — `mcp.json` read / merge / repair (pure).
- `bridge.ts` — `AI_EZIO_HAX_BIN` symlink + env persistence.
- `init.ts` — orchestrates: opt-in prompt → install-missing → reconcile → bridge →
  marker + summary report.

CLI surface: `ai-ezio init [--yes] [--no-cortex] [--no-whisper] [--reconfigure]`.
`ai-ezio doctor` extended to report the wired state and point at
`ai-ezio init --reconfigure`.

**First-run gate (at the CLI launch layer).** The bare-launch dispatcher (the
`packages/cli` launcher, *not* the `init` subcommand) decides whether to auto-run the
wizard **before** entering the REPL: if the launch is an interactive **TTY** *and* the
run-once **marker is absent** → run the wizard once with **default-yes** offers, write
the marker, then continue into the REPL; otherwise (marker present, non-TTY, or a
`-p`/one-shot invocation) → skip straight to normal launch. TTY-ness and the marker
path are **injectable seams**, so this decision is unit/e2e testable without a real
terminal.

**Flow:**

1. **Detect** (read-only): TTY/CI; owning package manager (npm vs pnpm); whether
   `ai-cortex` / `whisper` exist (PATH + global list) and their versions; parse any
   existing `mcp.json`; confirm ezio's own hax resolves.
2. **Interactive opt-in** (TTY only), default yes per peer. Already-present peers are
   shown as `✓ already installed (vX)` and not offered for reinstall.
3. **Non-interactive / CI**: honor flags; with no flags + no TTY, take the safe
   default (wire what's present, print how to run `init`) and **never hang**.
4. **Install only missing opted-in peers** via the owning manager.
5. **Reconcile config** (§5.4).
6. **Write marker + summary**: installed / wired / skipped, plus copy-paste next
   steps for untouched prerequisites.

### 5.3 Detection + reconciliation (install side)

Governing principle: **detect real state, install only what's missing, never
auto-upgrade, guide on version conflict.**

- **Presence detection** per peer: bin on PATH (`ai-cortex`, `whisper`) + owning
  manager's global list; capture installed version.
- **Already present → never reinstall, never auto-upgrade.** Record version, wire.
- **Missing + opted-in → install latest** via the owning manager.
- **Version-constraint gate** (`versions.ts`): compare installed vs minimum required
  for the integration features ezio relies on (the `cortex__*` MCP tools its
  session-recorder calls; whisper's bundled `AI_EZIO_HAX_BIN` resolver):
  - compatible → wire;
  - **below minimum → do not upgrade** (could break the user's setup); print e.g.
    `Detected ai-cortex 0.x; ezio needs ≥ Y for <feature>. To upgrade: npm i -g
    ai-cortex@latest`, then wire what still works;
  - unreadable version → best-effort wire + note.

### 5.4 Config generation (the files)

**ezio's `mcp.json`** — ezio owns it, but the user may have hand-edited it: read →
merge → never clobber. Preserve every existing `mcpServers`, `toolPolicy`,
`hostPrivateTools`, and unknown key.

- No cortex entry → add a **portable** one: `{"command":"ai-cortex","args":["mcp"]}`
  when `ai-cortex` is on PATH; else a resolved-node fallback.
- Cortex entry exists **and still launches** → **leave untouched**, with an *optional*
  `you have a hardcoded path — switch to portable form? [y/N]` defaulting to no.
- Cortex entry exists **but is broken** (path gone) → offer to repair to portable.
- Malformed JSON → back up to the first free **collision-safe** name (`mcp.json.bak`,
  then `mcp.json.bak.1`, `.2`, … — an existing backup is **never** overwritten), then
  repair or print the intended entry. Never lose data, even across repeated
  malformed-file recovery (resolves reviewer finding 4).
- Re-running never duplicates entries.

**`AI_EZIO_HAX_BIN` bridge** (whisper) — whisper checks this var first, and (verified)
whisper loads a `.env` **only from its current working directory** — there is no fixed
user-level dotenv source, and a child `ai-ezio init` process cannot mutate its parent
shell. So the bridge is *durable for future shells* but cannot retroactively fix the
shell already running; the wizard makes that one-time step explicit (resolves reviewer
finding 3):

- Always (re)create/refresh a **stable ezio-owned symlink** at an XDG data path (e.g.
  `~/.local/share/ai-ezio/hax`) → robust against npm-nested paths that move on upgrade.
  This symlink is the single canonical bridge target.
- **Idempotent managed export (resolves reviewer finding A).** Persistence detection is
  **file-based, not process-env-based** — the parent shell's env is unreliable (it is
  unset in a fresh shell and after `--reconfigure` in the same shell, so keying off
  `process.env.AI_EZIO_HAX_BIN` would append a *duplicate* line on every rerun). ezio
  instead manages **exactly one** export line, delimited by a stable sentinel marker
  (e.g. `# >>> ai-ezio (managed) >>>` … `# <<< ai-ezio <<<`). On every run /
  `--reconfigure`:
  - marker present → **rewrite the value in place** (picks up a moved symlink; never a
    second line);
  - marker absent → append the managed block **once**, with consent (default yes).
  Any number of reruns leaves at most one managed export. The profile is the only
  non-ezio-owned file touched, and only with consent; if declined, print the exact line.
- **Respect a user-owned *profile* export — durability is proven only by a profile
  line (resolves reviewer finding C).** If a non-managed `AI_EZIO_HAX_BIN` export line
  already exists **in the profile file** (outside our marker), it is both durable and
  user-owned → leave it untouched, do **not** add a competing managed block, and note it
  in the summary.
- **A process-only env value is transient — never a substitute for persistence.** A set
  `process.env.AI_EZIO_HAX_BIN` with **no backing profile line** (e.g.
  `AI_EZIO_HAX_BIN=/tmp/hax ai-ezio init`) vanishes when that process exits, so it does
  **not** prove durability and must **not** suppress the managed block — otherwise future
  shells stay unwired, contradicting the durability goal (§3). In that case the wizard
  still writes/updates the managed export (with consent) and reports that the current env
  value is temporary and will be superseded by the durable managed export. The managed
  marker (or a user-owned profile *line*) — **not** the environment — is the sole source
  of truth for "is the bridge durably persisted?"
- **Shell-safe serialization (resolves reviewer finding B).** The persisted value is
  **POSIX-single-quote escaped** — wrap in `'…'`, encoding any embedded `'` as `'\''` —
  so a path with spaces or shell metacharacters (`/tmp/AI Ezio/hax`, `$`, `"`,
  backticks) survives intact in sh/bash/zsh and never truncates. The same escaping
  applies to the printed current-shell line.
- **Current shell:** because the running shell does not inherit the just-written
  profile, the wizard **prints an explicit one-time action** — `source <profile>` (or
  open a new terminal), or paste the (shell-escaped) `export …` line now — after which
  `whisper collab mount ezio` resolves ezio's engine. The "mountable by whisper"
  guarantee is therefore *immediate for new shells, one `source` away for the current
  shell* — it is **not** claimed to need zero user action in the live shell.

> **Note (resolves reviewer finding D):** an earlier draft offered to also write
> `AI_EZIO_HAX_BIN` into a workspace `.env`. That is **removed** — it contradicted the
> "shell profile is the only non-ezio-owned file touched" decision (§4.3) and broadened
> the blast radius beyond the approved "Self-contained + guide" reach. Users who prefer
> not to edit their profile decline the consent prompt and get the exact `export` line
> printed instead (the "Current shell" path above), so no capability is lost.

## 6. Error handling / edge cases

The bootstrap treats every external step as fallible and **degrades to guidance
rather than failing**:

- **No TTY / CI** → never hang; flags or safe default.
- **Peer install fails** (network, `EACCES` on the global prefix, native build
  failure for `better-sqlite3`/`node-pty`) → non-fatal: report which failed, keep
  wiring what succeeded, print targeted remediation.
- **No detectable package manager** → skip auto-install, print manual `npm i -g …`.
- **Malformed `mcp.json`** → **collision-safe** backup (`mcp.json.bak`, `.bak.1`, … —
  never overwriting an earlier backup) + repair/print; no data loss across repeated
  recovery.
- **ezio's own hax unresolvable** (missing platform pkg / unsupported arch) → bridge
  can't be written and ezio itself is degraded → loud error pointing at
  `ai-ezio doctor`.
- **Shell profile ambiguous** (multiple shells / none) → don't guess which file to
  edit; print the `export` line. In every case the current shell still needs an
  explicit one-time `source`/restart (the wizard prints it) — a written profile only
  affects future shells.
- **whisper present but its prereqs missing** (`ANTHROPIC_API_KEY`, `claude`/`codex`
  CLIs) → still write the bridge (ezio's job), then print whisper's prereq guidance.
- **Re-run / partial-failure recovery** → idempotent across the board: peer detection
  re-reads real state (not the bootstrap-completion marker), `mcp.json` reconciliation
  never duplicates entries, and the bridge updates its single **managed** profile export
  in place rather than appending — so `init --reconfigure` from any shell converges and
  never accretes duplicate lines.

## 7. Testing strategy

Mirrors ezio's injectable-seam + vitest style (same approach as `resolve-hax.ts`):

- **Unit** (seams injected — fs, spawn/exec, env, PATH lookup, TTY/CI):
  - manager detection (npm vs pnpm);
  - presence + version detection (installed / missing / unreadable);
  - version-constraint gate (compatible / below-min asserts guide text + *no* install
    call / unknown);
  - `mcp.json` reconciler (empty → add portable; valid cortex → untouched; broken →
    repair; preserves other servers/policy/unknown keys; idempotent re-run → no dup;
    **malformed → collision-safe backup**, and **repeated** malformed-file recovery
    yields multiple distinct, non-overwriting backups `.bak`, `.bak.1`, … — regression
    for reviewer finding 4);
  - bridge writer: symlink (re)created; consented append vs decline-prints-line;
    ambiguous-profile-prints-line; **no-duplicate rerun** — running twice (and
    `--reconfigure` with the env var unset) against a profile that already holds the
    managed marker yields **exactly one** managed export, value rewritten in place when
    the symlink path changes (regression for finding A); **shell-safe serialization** —
    paths with spaces and shell metacharacters (`/tmp/AI Ezio/hax`, `$`, `"`, `'`,
    backticks) round-trip to the exact value when the profile is `source`d under sh and
    zsh (regression for finding B); **user-owned profile line respected** — a
    pre-existing non-managed `AI_EZIO_HAX_BIN` *line in the profile* is left intact and
    not duplicated; **transient env never suppresses persistence** — `init` with
    `process.env.AI_EZIO_HAX_BIN` set but **no** backing profile line still writes the
    managed block (exactly one) and flags the env value as temporary, proving durability
    is decided by the profile, not the environment (regression for finding C);
  - opt-in flag parsing + never-hang default.
- **Single-package install smoke — the primary distribution contract (resolves
  reviewer finding 5).** Rewrite `scripts/smoke-install.mjs` to `npm pack` **only** the
  publishable `ai-ezio` package (bundled) **plus** the host `@ai-ezio/hax-<os>-<cpu>`
  package — exactly **two** tarballs — and install them into a clean temp prefix with
  `AI_EZIO_HAX_BIN` unset, **no vendor/hax**, and **no separately supplied `@ai-ezio/*`
  TS workspace tarballs**. Then assert `ai-ezio --version --json` and a mock
  (`HAX_PROVIDER=mock`) `-p` one-shot both succeed. If bundling is incomplete (any
  unresolved `@ai-ezio/*` or third-party import), install/run fails. This **replaces**
  the current four-tarball form (protocol + harness + cli + binary), which can pass
  while the real single published package is uninstallable.
- **Bootstrap e2e** (gated, alongside `cli-mount-smoke.mjs`): `ai-ezio init --yes`
  against **stubbed installers** into a temp HOME → assert resulting `mcp.json` +
  bridge + marker, and that pre-existing peers are detected and **skip install**.
- **First-run launch gate (resolves reviewer finding E) — at the CLI launch layer, not
  just `init`.** Drive the **bare-launch dispatcher** with an injected TTY + temp HOME:
  (a) **first launch, no marker** → the wizard **auto-triggers** and presents
  **default-yes** cortex/whisper offers (assert the offers fire *and* their default
  answers), then the marker is written; (b) **second launch, marker present** → the
  wizard **does not run** and ezio proceeds straight to normal launch. This closes the
  gap where the explicit `init --yes` e2e could pass while automatic triggering, the
  default answers, or marker suppression were silently broken.
- **Out of automated CI**: real network `npm i -g` of the peers (slow/flaky/native
  builds) — manual/optional smoke only.

## 8. Open items to confirm during planning

Both prior contract-level open items are now **resolved** in this revision: the publish
target is committed (§4.6 — public, unscoped npm; reviewer finding 1) and the whisper
bridge mechanism is committed (§5.4 — durable shell-profile export + explicit
current-shell `source`; reviewer finding 3). The only remaining item is a value to
pin, not a contract decision:

- **`MIN_CORTEX` / `MIN_WHISPER` values** — pin to the versions that first shipped the
  features ezio relies on (cortex's `cortex__*` MCP tool surface; whisper's bundled
  `AI_EZIO_HAX_BIN` resolver). A value lookup during implementation, not a design
  decision.

## 9. Out of scope / future

- Auto-upgrading peers (explicitly avoided; guidance only).
- A `create-ai-ezio` scaffolder (Approach C).
- Bundling claude/codex or wiring cortex's claude/codex hooks (guidance only).

## 10. Worked example — the author's current machine

State: `ai-cortex@0.14.2` and `ai-whisper@0.5.5` already global; a hand-written
`mcp.json` with a hardcoded `node /opt/homebrew/.../cli.js mcp` cortex entry +
partial `toolPolicy`.

`ai-ezio init` would:

1. Detect both peers present → **install nothing**.
2. Version-gate both → compatible → proceed to wire.
3. `mcp.json`: cortex entry exists and still launches → **left untouched**; offer
   (default no) to switch the hardcoded path to portable `ai-cortex mcp`; preserve the
   existing `toolPolicy`.
4. Bridge: no managed marker in the profile yet → create the ezio-owned symlink and
   (with consent) append one **managed**, shell-escaped `export AI_EZIO_HAX_BIN='…'`
   block (durable for new shells; a later `init --reconfigure` rewrites it in place,
   never duplicating), then **print the one-time `source ~/.zshrc` / new-terminal
   step** so the *current* shell can resolve the engine for `whisper collab mount ezio`.
5. Print: cortex's optional `history install-hooks` / `install-prompt-guide` as a
   pointer for claude/codex use; whisper's `ANTHROPIC_API_KEY` + `claude`/`codex`
   prereqs if unmet.
6. Write the bootstrap marker + summary.

Net: no reinstalls, no clobbered config, ezio wired to cortex and mountable by whisper
(immediately in new shells; one `source` away in the current one).
