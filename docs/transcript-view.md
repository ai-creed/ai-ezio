# Ctrl+T transcript view — guideline

**Project:** ai-ezio · **Date:** 2026-06-11 · **Status:** shipped (standalone); ai-whisper wiring is a pending downstream follow-up
**Canonical copy:** `~/.ai-pref-nsync/local-docs/ai-ezio/knowledge-references/2026-06-11-ctrl-t-transcript-view-guide.md`
**Design spec:** `docs/superpowers/specs/2026-06-11-ezio-transcript-view-design.md`
(this in-repo copy is the committable mirror of that canonical doc.)

## What it is

The transcript view is ezio's stand-in for hax's interactive **Ctrl+T** screen. It
shows the **model-perspective transcript** — exactly what the model sees:

- the full **system prompt**,
- every **advertised tool schema**,
- every **conversation item** in order: user messages, assistant messages,
  tool-call JSON args, tool results, reasoning blocks, and turn boundaries.

It is plain text (no ANSI), rendered by hax itself, paged on demand. It is a
high-value debugging affordance for "why did the model do that" — you see the
literal context, not a prettified conversation scroll.

## Why ezio has to reproduce it

Under the unified architecture hax is always **headless** (stdin/stdout/stderr
ignored, speaks only the protocol). hax's native Ctrl+T lives inside its raw-mode
TUI input loop, which never runs when headless — so the keybind is structurally
unreachable. ezio rebuilds the affordance on the TS side, fed by hax's own data
via the `HAX_TRANSCRIPT` mirror (no hax C change; hax stays the single source of
truth for the rendering).

## How to open it (standalone ezio)

Two equivalent entry points in the standalone REPL:

- **`Ctrl+T`** — intercepted in the line reader (`input-reader.ts`, byte `0x14`) as
  an out-of-band signal; it does not submit, interrupt, or echo.
- **`/transcript`** — slash command, same action, discoverable and keybind-free.
  (Summary: "view the model-perspective transcript (same as Ctrl+T)".)

Either one pages the mirror file, then redraws the prompt. A Ctrl+T pressed
mid-turn is handled at the next settled boundary (the REPL loop blocks on the
turn), so the pager never fights the live renderer for stdout.

## What you see / pager behaviour

- **Interactive TTY:** raw mode is suspended, the file opens in your pager, and raw
  mode is restored when you quit — restore is in a `finally`, so a pager crash
  can't strand the terminal. On a pager failure it falls back to an inline dump so
  content is never lost.
- **Pager choice:** `$PAGER` if set and non-blank, else **`less -R`**. Spawned with
  the file on inherited stdio.
- **No TTY (piped/non-interactive):** the file is dumped inline to stdout.
- **No turns yet (file missing/empty):** a dim `─ no transcript yet ─` notice; no
  pager is spawned.

## Where the mirror lives (the seam contract)

hax mirrors its live transcript to the path named by the **`HAX_TRANSCRIPT`** env
var (line-buffered, so it is always current for a read). ezio wires that env at
spawn:

- **Path:** `<ezioStateDir>/transcripts/<repoKey>/<uuid>.txt`
  where `ezioStateDir` = `$XDG_STATE_HOME/ezio` (default `~/.local/state/ezio`) and
  `repoKey` is the cwd-derived key (same scheme as the session recorder's durable
  store). One file per hax process.
- **Harness seam:** `Session.start({ transcriptPath })` injects
  `HAX_TRANSCRIPT=<transcriptPath>` into the hax child env (`spawn.ts`
  `haxSpawnEnv`), and the session re-exposes it read-only as
  **`Session.transcriptPath`**. Consumers read the path from the harness rather
  than re-deriving the env contract.
- **Pre-spawn id (load-bearing):** the filename uses a caller-minted id
  (`crypto.randomUUID()`) generated **before** spawn, because the env var must be
  set before hax starts, while the protocol `ready.sessionId` is only known after.
  The dir is `mkdir -p`'d before spawn.

The file is inspectable directly: `cat`/`grep`/`less` the path any time.

## Lifecycle (handled by hax, reflected automatically)

- **`/new`** → hax resets the mirror; the view shows only the new conversation.
- **`--continue` / `--resume`** → hax rebuilds the mirror with the replayed
  history, so a resumed session's view shows the prior conversation immediately
  (not empty).
- **`/compact`** → hax re-seeds the mirror with the full post-compact history (no
  stale append-only tail); the view matches the live compacted state.

## Troubleshooting

- **"no transcript yet"** → no turns have run, or `HAX_TRANSCRIPT` was not wired
  (no `transcriptPath` passed to `Session.start`). Check `Session.transcriptPath`
  is defined.
- **Pager doesn't open** → check `$PAGER` / that `less` is installed; ezio falls
  back to `less -R`, then to an inline dump.
- **Terminal left in a weird state after quitting the pager** → shouldn't happen
  (raw-mode restore is in `finally`); if it does, it's a regression in
  `showTranscript`'s restore path.
- **Mounted mode (ai-whisper) shows nothing / is stale** → the mounted path runs
  ai-whisper's bundle, not ezio's CLI. Either the integration below isn't wired,
  or ai-whisper needs a rebuild (see
  `docs/superpowers/knowledge-references/2026-06-11-whisper-stale-ezio-bundle.md`).

## Mounted mode (ai-whisper) — integration follow-up

In mounted mode ezio's standalone CLI is **not in the path**; ai-whisper is the
host process that drives the harness, so it owns the keybind and the pager. The
harness seam this feature adds (`Session.transcriptPath`) is exactly what
ai-whisper consumes. The wiring is small (~10 lines), mirroring the standalone
`showTranscript`:

1. **Mint + pass the path.** Before `session.start`, mint a pre-spawn id, build
   `<stateDir>/transcripts/<repoKey>/<id>.txt`, `mkdir -p` its dir, and pass it as
   `transcriptPath`. hax then mirrors there.
2. **Intercept Ctrl+T.** In ai-whisper's line-buffered input loop
   (`live-session.ts` `feedLineBufferedInput`), recognise byte `0x14` as an
   out-of-band signal (don't submit it).
3. **Page the file.** Open `session.transcriptPath` in `$PAGER`/`less -R` on
   inherited stdio; suspend/restore ai-whisper's raw mode around it (in a
   `finally`). Reuse the same missing/empty → notice and no-TTY → inline-dump
   fallbacks.
4. **Optional `/transcript` command** routed to the same handler.

Templates to copy (both exported + unit-tested, pure over injected seams so they
port cleanly): `startWithTranscript()` in `standalone-runtime.ts` for step 1 (the
mint→mkdir→start sequence, with no dependency on `ready`), and
`showTranscript` / `resolvePager` / `transcriptFilePath` in
`packages/cli/src/repl/transcript-view.ts` for steps 3–4.

> Propagation caveat: because ai-whisper **bundles** `@ai-ezio/*` at build time,
> this change only takes effect after ai-whisper is rebuilt and its global binary
> reinstalled — see the stale-bundle gotcha referenced above.

## Design rationale (one line)

Chosen approach is **B1**: reuse hax's `HAX_TRANSCRIPT` mirror (no fork change, hax
owns the rendering). Alternatives — re-rendering ezio's turn-level session recorder
(weaker, no system prompt/tools/reasoning), re-parsing hax's private session
`.jsonl` (couples to hax's on-disk schema), or a new `get_transcript` protocol
control (cleanest long-term, deferred) — are recorded in the design spec.
