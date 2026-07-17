# UX slice 1 — acceptance verification evidence (B3, F1, burst guard)

**Date**: 2026-07-17
**Spec**: `docs/superpowers/specs/2026-07-15-ux-slice1-mounted-polish-design.md`
(§5 verification tasks B3 and F1; §1 short-burst label policy)
**Code under verification**: master `2ad7035` (implementation commits
`7387ad1..00a885f` + test-guard commits `4a70fc5`, `2ad7035`)
**Engine**: the 0.4.1-pinned hax binary resolved through the
`AI_EZIO_HAX_BIN` bridge (`~/.local/share/ai-ezio/hax` → npm
`@ai-creed/hax-darwin-arm64@0.4.1`) — i.e. the released engine, not a dev
build. Provider: real `codex` (auto-selected; no `HAX_PROVIDER` override).

This document exists so the acceptance evidence is a committed, reviewable
artifact rather than living only in workflow handback text.

## B3 — per-request transcript footers (real turn per surface)

Pass condition (spec, corrected): the footer line's plain-text **content and
placement** after its request's items — the mirror is deliberately color-off,
so no styling check applies.

### Standalone surface

Method: the real REPL (`packages/cli/bin/ai-ezio.mjs`) driven over a Python
PTY; one real turn ("Reply with exactly: pong"), then Ctrl+T with
`PAGER=cat` so the transcript pages inline; output captured and matched.

Result (verbatim script output):

```
footer-in-transcript: '2s · ~$0.0031 · in 434 $0.0011 · cache 7.5k $0.0019 · out 5 $0.0001'
footer-after-items: True
new-spinner-label-seen: 'thinking…'
new-stats-line-seen: '2s · 7.9k / 266k (2%)'
B3-STANDALONE PASS
```

The footer appears after the request's items, plain text, with the
per-category split (this run hit prompt cache, so a `cache` category is
present — richer than the minimal example shape, same footer contract).
Incidental live evidence of this slice's renderer: the `thinking…` spinner
label and the duration-led stats line `2s · 7.9k / 266k (2%)` rendered on a
real TTY.

### Mounted surface

Method: `ai-ezio --mount-mode --protocol-fd=3 --control-fd=4` (the exact
production mount posture), one real turn submitted over the control fd,
`HAX_TRANSCRIPT` wired; the mirror — the same file the mounted Ctrl+T /
`/transcript` view pages verbatim — checked for footer content + placement.

Result (verbatim script output):

```
B3-MOUNTED PASS: real mounted turn; footer in mirror: "2s · ~$0.0071 · in 2.7k $0.0070 · out 5 $0.0001"
```

Footer present, plain text, placed after the assistant item.

**B3 verdict: PASS on both surfaces.** (A missing footer would have been an
engine/transcript-wiring bug to triage; none found.)

## F1 — rapid picker paging under tmux without DEC 2026 support

The no-DEC-2026 condition is established two ways, both recorded in the run
output below:

1. **Server-side**: a dedicated tmux server (`-L f1nosync`, started with
   `-f /dev/null`) with `terminal-features` set to the empty list — the
   `sync` feature (tmux's DEC 2026 support) is therefore unsupported for
   every terminal on that server. The setting is echoed in the run output.
2. **App-side**: the picker/renderer sources emit no `\e[?2026` sequence at
   all (grep over `packages/surface/src` + `packages/cli/src`: zero
   matches; repaints are plain cursor-up + clear-line). There is no
   synchronized-update protection in play on either side.

Method: detached 100×40 session on that server, 25 seeded sessions in the
cwd store (PAGE_SIZE = 15 → two pages; an earlier attempt with exactly 15
sessions was discarded — it filled one page and paging was inert). The
resume picker (`ai-ezio --resume`) paged rapidly 40 times mixing `[` / `]`
and real PageUp/PageDown keys (`PPage`/`NPage`), with a `capture-pane`
snapshot after every keypress — sampling tmux's screen model, which applies
inner-app bytes immediately (no client-side batching), the strictest
observation point for intermediate states. A snapshot missing the picker
frame/hints line counts as an intermediate blank frame.

Result (verbatim run output):

```
tmux: tmux 3.6a, dedicated server -L f1nosync, started with -f /dev/null
terminal-features setting: 'terminal-features' (empty list = sync/DEC-2026 unsupported for every terminal)
app-side: zero \e[?2026 emissions in packages/surface+cli sources (picker repaints via cursor-up + clear-line only)
initial-paged-hint: PgUp/PgDn page
captures=40 framesMissingPagedHints=0
first-row-sequence:  17.  2.  2.  17.  17.  17.  2.  2.  17.  2.  2.  17.  17.  17.  2.  2.  17.  2.  2.  17.  17.  17.  2.  2.  17.  2.  2.  17.  17.  17.  2.  2.  17.  2.  2.  17.  17.  17.  2.  2.
```

The first-row alternation (2 ↔ 17) proves real page flips on every key
form — including the real PgUp/PgDn escape sequences, live-verifying Task
4's aliases and the `[ ]/PgUp/PgDn page` hint. Zero of 40 captures showed a
blank or hint-less frame.

**F1 verdict (snapshot layer): flicker did not reproduce under the mandated
no-DEC-2026 condition.**

### Intermediate-frame observation (closing the snapshot-sampling gap)

Post-keypress snapshots observe only settled screens, so two further layers
establish that an *intermediate* blank frame cannot occur and was not
observed:

**Layer 1 — write-boundary atomicity at the source.** The real
`runResumePicker` driven directly with an instrumented `deps.write` and 40
rapid paging keys (`]`, `[`, and the PgUp/PgDn CSI sequences). Every repaint
is emitted as `reset + view` in a single `write()`
(`resume-picker.ts:216-220`); the analysis asserts destructive bytes
(cursor-up + clear-to-end) never appear in a write that lacks the full
replacement frame:

```
write() calls total: 42
repaint writes (contain cursor-up+clear-to-end): 40
repaint writes MISSING their replacement frame in the same write: 0
F1-WRITE-BOUNDARY PASS: clear and replacement frame are atomic in every repaint write
```

No flush boundary ever separates a clear from its repaint, so no terminal —
with or without DEC 2026 — has an intermediate blank state to display.

**Layer 2 — attached no-sync client, continuous byte trace.** A real client
attached (inside a PTY) to the empty-`terminal-features` server, ~33
pagings/second driven while every byte chunk the client receives is recorded
with a timestamp — a continuous terminal trace, not sampling:

```
server terminal-features: 'terminal-features' (empty = sync/DEC-2026 unsupported)
attached-client trace: 44 read chunks, 31229 bytes, continuous (50ms poll, timestamps per chunk)
chunks containing erase sequences (ED/EL): 43
erase chunks WITHOUT replacement content in the same chunk: 1
  split at chunk 0: gap to next content chunk = 0.29ms
F1-ATTACHED-TRACE PASS: all splits closed within the stated gaps
```

Of 43 erase-bearing chunks, every paging repaint carried its replacement
content in the same client read; the single split was chunk 0 — the initial
attach redraw, before the picker's first paint — closed in 0.29 ms.

**F1 verdict: under the mandated no-DEC-2026 condition, no intermediate
blank frame is producible (source-atomic repaints) nor was any observed at
an attached client's continuous byte stream → per the spec's conditional,
no repaint change is made.**

## Short-burst label guard (spec §1)

`packages/surface/src/spinner-model.test.ts` ("never flashes a short tool
burst's label") asserts the frame on the model **while the tool phase is
live**, sampled at 100 ms into the burst AND at the last pre-finish instant
(3299 ms of a 3000–3300 ms burst), then again after the finish. A tool
label appearing anywhere inside the burst fails the guard. Suite: 11/11
(`2ad7035`).

## Reproduction notes

The B3/F1 driver scripts are session scratch (PTY driver, mount driver,
tmux loop) — the methods above are described completely enough to re-derive
them; each is ~40 lines against public entry points (`bin/ai-ezio.mjs`,
`--mount-mode` fds, `--resume`). Real-provider runs cost ≈ $0.01 total.
