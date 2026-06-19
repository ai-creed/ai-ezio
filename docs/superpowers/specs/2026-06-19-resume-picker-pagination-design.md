# Resume-picker pagination — design

**Status:** approved (brainstorm)
**Date:** 2026-06-19
**Scope:** Paginate the interactive resume picker (`runResumePicker` in
`@ai-ezio/surface`) so a long session list (can be 100+ items) is shown ~15 at a
time, with `[` / `]` to page and `Ctrl+A` to toggle a show-all view. Works in
**both** standalone and mounted ezio with no per-mode code change.
**Predecessor:** `2026-06-18-ezio-resume-rename-commands-design.md` (introduced the
picker, its relocation to `@ai-ezio/surface`, and the whole-chunk raw-key delivery
in both modes).

## Motivation

`runResumePicker` renders **every** session row in one frame. `hax --list-sessions`
returns all of a cwd's sessions (mtime-descending — `session.c` `qsort
cmp_mtime_desc`), which for an active project is easily 50–100+. The single-frame
render is hard to scan and writes a frame as tall as the list (worse in a mounted
pane). Pagination bounds the view to ~15 rows and gives fast page navigation while
keeping a "show everything" escape hatch.

## Goals

- Show **15** rows per page; a header shows `page X/Y · N sessions`.
- `[` = previous page, `]` = next page (**hard pages** — see §1).
- `Ctrl+A` toggles a **show-all** view (every row, today's behavior) and back.
- Rows keep their **global** number (page 2 = 16–30); the 1-9 digit-jump is removed.
- One shared picker serves standalone (in-REPL `/resume` + startup `--resume`) and
  mounted `/resume`; pagination lands **only** in `resume-picker.ts`.

## Non-goals

- Adapting `pageSize` to the terminal height — fixed 15 (noted as future work).
- Search/filter within the picker — out of scope.
- Changing the list's source or order — `--list-sessions` is already
  mtime-descending; the picker renders that order unchanged.
- Renaming/deleting sessions from the picker — out of scope (the prior spec's
  non-goal stands).

## §1 — State & key model

`PickerState` gains two fields; `index` remains the **global, 0-based** cursor:

```ts
export interface PickerState {
	index: number; // global cursor (0-based across the whole list)
	count: number; // total rows
	pageSize: number; // 15
	showAll: boolean; // false initially; Ctrl+A toggles
}
```

Derived (pure, computed where needed): `page = Math.floor(index / pageSize)`,
`pageCount = Math.max(1, Math.ceil(count / pageSize))`,
`pageStart = page * pageSize`, `pageEnd = Math.min(count - 1, pageStart + pageSize - 1)`.

`decodeChunk` gains three tokens. Because the picker is fed **whole** input chunks
(escape sequences arrive whole), a bare `[` / `]` keystroke is its own one-byte
chunk and never collides with a CSI sequence (`\x1b[…`):

| Chunk | Token |
|---|---|
| `"["` | `pageprev` |
| `"]"` | `pagenext` |
| `"\x01"` (Ctrl+A) | `toggleall` |

`KeyToken` becomes `"up" | "down" | "enter" | "cancel" | "pageprev" | "pagenext" |
"toggleall" | "other"` — the `{ digit }` variant is **removed** (digit-jump dropped).

`applyKey(state, token): { index: number; showAll: boolean; done?: "select" | "cancel" }`
— **hard pages**:

- `up`: `index = max(showAll ? 0 : pageStart, index - 1)`.
- `down`: `index = min(showAll ? count - 1 : pageEnd, index + 1)`.
- `pagenext` (`]`): if not `showAll` and `pageStart + pageSize < count` →
  `index = pageStart + pageSize` (first row of the next page); else no-op.
- `pageprev` (`[`): if not `showAll` and `page > 0` → `index = pageStart - pageSize`
  (first row of the previous page); else no-op.
- `toggleall` (Ctrl+A): `showAll = !showAll`; `index` unchanged — the cursor is
  preserved, so toggling back returns to the page that holds it.
- `enter` → `done: "select"`; `cancel` (Esc / `q` / Ctrl-C / Ctrl-D) → `done: "cancel"`.
- `other` → no change.

(`applyKey` now also returns `showAll` so the caller threads the toggle; `count` and
`pageSize` come in via `state`.)

## §2 — Rendering (variable-height frame)

Replace the static `PICKER_TITLE` constant and the all-rows `renderFrame` with a
pure `renderView(rows, state, nowMs, titles): string` that builds three parts:

1. **Header:**
   - paged: `Resume a session  (page {page+1}/{pageCount} · {count} sessions)`
   - show-all: `Resume a session  (showing all {count} sessions)`
   - single page (`pageCount === 1`, not show-all): `Resume a session  ({count} session{s})`
2. **Visible rows:** the slice `rows[pageStart .. pageEnd]` (or all rows when
   `showAll`), each rendered by `oneLine` with its **global** 1-based number (`i+1`)
   and the `❯` cursor on the row where `i === index`. (Existing `oneLine` /
   `formatRow` / title-merge unchanged.)
3. **Footer (key hints):**
   - paged, multi-page: `↑/↓ move · [ ] page · Ctrl+A all · Enter select · Esc cancel`
   - single page: `↑/↓ move · Ctrl+A all · Enter select · Esc cancel` (no `[ ] page`)
   - show-all: `↑/↓ move · Ctrl+A pages · Enter select · Esc cancel`

`renderView` returns the frame text (the parts joined by `\n`, with a trailing
`\n`); it does **not** embed the cursor-reset. Because the frame height now varies
(short last page, show-all = every row, single page), the in-place redraw cannot
assume a constant height. `runResumePicker` tracks the **previous** frame's line
count and, before each redraw, prepends a reset that climbs exactly that many lines
and clears to end of screen:

```ts
const reset = first ? "" : `\x1b[${prevLines}A\r\x1b[0J`;
deps.write(reset + view);
prevLines = (view.match(/\n/g)?.length ?? 0); // climb the same count next redraw
```

(The climb count = number of `\n` in the frame, which equals the number of lines the
cursor advanced — same invariant the old constant-height code relied on.)

`runResumePicker` loop becomes: initialize `state = { index: 0, count: rows.length,
pageSize: 15, showAll: false }`; first draw (no reset); then per key: `decode →
applyKey → state.index/showAll = result → if done return → redraw`.

## §3 — Both modes (no per-mode code change)

The picker is the single `runResumePicker` in `@ai-ezio/surface`, consumed by all
three entry points, each of which already feeds it a **whole-chunk raw key stream**:

- standalone in-REPL `/resume` → `makeStandaloneOverlay` → `borrowChunks` (over
  `stdinChunks`);
- standalone startup `--resume` → `resumeViaPicker` → `stdinChunks(process.stdin)`;
- mounted `/resume` → the adapter's resume thunk → host `runInteractiveOverlay`
  (raw stdin chunks routed to the picker).

The new keys (`[`, `]`, `Ctrl+A` = `\x01`) are **single bytes**, so they cannot be
split by chunking and `decodeChunk` reads them directly; while the overlay owns
input, nothing upstream intercepts them. Therefore pagination is implemented
**entirely in `resume-picker.ts`** — no change to `@ai-ezio/cli`'s standalone
runtime or to ai-whisper's adapter / `live-session.ts`. ai-whisper only rebuilds to
pick up the new `@ai-ezio/surface` bundle (the stale-bundle rollout from the prior
spec). Capping the frame at ~17 lines is also safer for the mounted pane than the
current all-rows render.

## §4 — Error handling / edge cases

- **Empty list:** `runResumePicker` returns `undefined` before rendering (unchanged).
- **≤15 sessions:** single page — header drops the `page X/Y` indicator, footer drops
  the `[ ] page` hint, `[`/`]` are no-ops.
- **Short last page** (<15 rows): only real rows render; the prev-line-count redraw
  absorbs the height change when paging between a full and a short page (and when
  toggling show-all).
- **Cancel mid-picker** (Esc/`q`/Ctrl-C/EOF): unchanged — returns `undefined`, raw
  mode restored by the caller (`makeStandaloneOverlay` / `runInteractiveOverlay`).
- **Huge show-all:** renders every row (the explicit "show all" the user asked for);
  may exceed the viewport and scroll — acceptable and opt-in.

## §5 — Testing (both modes proven)

- **Surface, pure (mode-agnostic):**
  - `decodeChunk`: `[`→`pageprev`, `]`→`pagenext`, `\x01`→`toggleall`; arrows / enter
    / cancel unchanged; a bare `[` decodes to `pageprev`, not confused with an arrow.
  - `applyKey`: `up`/`down` clamp to the **page** bounds (not the whole list) when
    `!showAll`; `pagenext`/`pageprev` jump to page boundaries and no-op at the ends;
    `toggleall` flips `showAll` and preserves `index`; in `showAll`, `up`/`down` span
    `0..count-1` and `[`/`]` are inert; `enter`/`cancel` set `done`.
  - `renderView`: header text for paged / show-all / single-page; only the page slice
    is rendered; rows carry global numbers; cursor on the right row; footer hints per
    mode; the frame's line count matches what the redraw climbs.
  - `runResumePicker` integration (injected keys): `]` to page 3 then `enter` returns
    the page-3 row's id; `Ctrl+A` then navigate + `enter` over the full list; the
    redraw reset climbs the prior frame's line count across a page→short-last-page
    transition and a show-all toggle.
- **Standalone delivery (`@ai-ezio/cli`):** extend the `buildStandaloneKeySources`
  test to assert `[` / `]` / `\x01` pass through `borrowChunks` as whole chunks
  (decoding to `pageprev` / `pagenext` / `toggleall`).
- **Mounted delivery (ai-whisper):** extend the `runInteractiveOverlay` test to
  assert `[` / `]` / `\x01` reach the overlay's key stream as whole chunks. No adapter
  code change; ai-whisper rebuilds to bundle the new surface.

## File & module boundaries

**ai-ezio**
- `packages/surface/src/resume-picker.ts` — `PickerState` (+`pageSize`,`showAll`),
  `decodeChunk` (+3 tokens, −digit), `applyKey` (page-aware, returns `showAll`),
  `renderView` (replaces `renderFrame`/`PICKER_TITLE`), `runResumePicker`
  (state + variable-height redraw).
- `packages/surface/src/resume-picker.test.ts` — the §5 surface tests.
- `packages/cli/src/repl/standalone-runtime.test.ts` — extend the key-source test.

**ai-whisper**
- `test/live-session-runtime.test.ts` — extend the overlay test for the new keys.
- (rebuild only — no source change to the adapter / live-session / shared.)
