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

## F1 — rapid picker paging under tmux

Method: tmux 3.6a, detached 100×40 session, 25 seeded sessions in the cwd
store (PAGE_SIZE = 15 → two pages; an earlier attempt with exactly 15
sessions was discarded — it filled one page and paging was inert). The
resume picker (`ai-ezio --resume`) paged rapidly 40 times mixing `[` / `]`
and real PageUp/PageDown keys (`PPage`/`NPage`), with a `capture-pane`
snapshot after every keypress. A snapshot missing the picker frame/hints
line would count as an intermediate blank frame.

Result (verbatim run output):

```
initial-paged-hint: PgUp/PgDn page
captures=40 framesMissingPagedHints=0
first-row-sequence:  17.  2.  2.  17.  17.  17.  2.  2.  17.  2.  2.  17.  17.  17.  2.  2.  17.  2.  2.  17.  17.  17.  2.  2.  17.  2.  2.  17.  17.  17.  2.  2.  17.  2.  2.  17.  17.  17.  2.  2.
```

The first-row alternation (2 ↔ 17) proves real page flips on every key
form — including the real PgUp/PgDn escape sequences, live-verifying Task
4's aliases and the `[ ]/PgUp/PgDn page` hint. Zero of 40 captures showed a
blank or hint-less frame.

**F1 verdict: flicker did not reproduce → per the spec's conditional, no
repaint change is made.**

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
