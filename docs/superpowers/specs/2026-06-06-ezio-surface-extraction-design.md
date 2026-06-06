# ezio surface extraction + robust markdown — design spec

**Date:** 2026-06-06
**Status:** approved (brainstorm) → ready for implementation plan

## Goal

Extract ezio's **presentation surface** (the markdown renderer and the mounted
pane renderer) out of `ai-whisper/packages/adapter-ai-ezio` into a new
`@ai-ezio/surface` package in the **ai-ezio** repo, and make the markdown renderer
**robust** (tables, nested lists, fenced code, blockquotes) by rendering through
`marked` + `marked-terminal`. ai-whisper's adapter consumes the surface via a
`file:` dependency. This puts ezio's surfaces where they belong (ezio owns
surfaces; hax owns the engine) and unblocks the future `ezio --rich` standalone
mode — without rebuilding anything that already works.

## Motivation

A markdown **table** in the mounted ezio pane renders as raw `| --- | --- |`
pipes (see the review-matrix screenshot). The current `render-markdown.ts` is a
hand-rolled, line-based regex renderer with no support for tables or nested
structures. ezio is intended to be a daily-driver coding agent, so its rendering
must be robust and tidy.

Separately, the rich rendering lives in **ai-whisper** today only because mount
mode was its first consumer. The architecture is **hax = engine; ezio = surfaces
+ harness**. Standalone-rich ezio (a future `ezio --rich`) lives in the **ai-ezio**
repo and must reuse the same surfaces — but the dependency direction is
`ai-whisper → ai-ezio` and cannot reverse, so surfaces stuck in ai-whisper are
unusable from a standalone ezio CLI. They must live in ai-ezio.

## Hard constraint — no regression to working workflows

The core ai-whisper workflows already work end-to-end: **ezio paired with claude
or codex** as implementer/reviewer (claude/ezio and codex/ezio SDD runs reach
`done`). **This must not break.**

This refactor is **display-only**. It moves two pure display modules and makes
markdown robust. It does **NOT** touch:

- the capture pipeline (`capture-handback-text.ts` and the per-agent `/copy`
  changeCount signature calibration);
- the live-session handback timing or the `onTurnFinished` protocol handback;
- the provider, the mounted turn-owned relay, or the protocol controls.

The only behavioral change anywhere is *how assistant markdown looks*. Acceptance
(below) re-proves the workflow paths.

## Architecture

New package mirrors `@ai-ezio/protocol`'s shape (ESM, `tsc --build`, `vitest`,
single `.` export):

```
ai-ezio/packages/surface/
  package.json    name @ai-ezio/surface;
                  deps: marked@^15, marked-terminal@^7,
                        @ai-ezio/protocol (workspace:*)
                  devDeps: @types/marked-terminal@^6 (see typing strategy below)
  tsconfig.json
  src/
    index.ts             re-exports renderMarkdown, createMountedRenderer, style
    style.ts             ezio ANSI palette (ESC, DIM, CYAN, BRIGHT_MAGENTA, …)
    render-markdown.ts    robust marked-terminal renderer
    mounted-renderer.ts   pane renderer (moved verbatim, import path updated)
    render-markdown.test.ts
    mounted-renderer.test.ts
```

### Typing strategy — `marked-terminal` has no bundled declarations
`marked-terminal@7.3.0` ships only `index.js`/`index.cjs` with **no `.d.ts`**, so a
strict NodeNext compile of `import { markedTerminal } from "marked-terminal"`
fails with **TS7016** ("could not find a declaration file"). This would break the
`@ai-ezio/surface` build gate (success criterion 1). The fix:

- **Add `@types/marked-terminal@^6` as a `devDependency`** of `@ai-ezio/surface`.
  This is the canonical source of the `markedTerminal(options)` signature and is
  sufficient for the strict `tsc --build`.
- **Fallback if the community types lag `marked@^15`:** add a one-line ambient
  declaration `src/marked-terminal.d.ts` (`declare module "marked-terminal";`),
  which silences TS7016 at the cost of `any`-typed options. Prefer the `@types`
  package; use the ambient shim only if a version skew forces it.
- The `tsc --build` in the verification gate (`pnpm -r build`) is what proves the
  typing resolves — a missing declaration surfaces there, not at runtime.

Dependency direction is unchanged (`ai-whisper → ai-ezio`):

```
@ai-ezio/protocol  ─┐
                    ├─►  @ai-ezio/surface ──► marked, marked-terminal
@ai-ezio/harness ───┘            ▲
                                 │  file: dep
       ai-whisper/adapter-ai-ezio ┘   (keeps the collab glue)
```

`@ai-ezio/surface` depends on `@ai-ezio/protocol` (for `ProtocolEvent` types used
by `mounted-renderer`) via `workspace:*` inside the ai-ezio monorepo. It is added
to the ai-ezio `pnpm-workspace.yaml` (already `packages/*`, so no change needed)
and to the `pnpm -r build`/`test` graph.

## Components

### `style.ts` (new)
The ezio ANSI palette, consolidated: `ESC = "\u001b"` (the real escape byte — never the empty string, which was the M8 bug), `RESET`, `DIM`, `BOLD`,
`CYAN`, `RED`, `GREEN`, `BRIGHT_MAGENTA`, `FG_DEFAULT`, plus the glyphs already in
use (`▌`, `❯`, `›`, `⏺`, spinner frames). Both `render-markdown` (marked-terminal
color callbacks) and `mounted-renderer` (banner/prompt/stripe/tool) import from
here, eliminating the duplicated ESC constants currently in each file.

### `render-markdown.ts` (rewritten)
```ts
export function renderMarkdown(md: string, opts?: { width?: number }): string
```
- Renders through `new Marked()` + `markedTerminal(options)`, configured to the
  ezio palette: cyan inline code, dim fenced blocks, bold/magenta accents,
  `cli-table3` bordered tables.
- **Width-aware:** `width = opts?.width ?? process.stdout.columns ?? 80`, with
  `reflowText: true` so prose and wide tables wrap to the pane width instead of
  overflowing.
- Trims trailing blank lines so block spacing stays tight (keeps the M8
  "no usage-glue" tidiness).
- Robust by construction: `marked` parses all CommonMark/GFM; malformed input
  degrades to plain text rather than throwing.

### `mounted-renderer.ts` (moved, minimal change)
- Moves verbatim except: `import { renderMarkdown } from "./render-markdown.js"`
  stays local; ANSI constants now come from `./style.js`; and the
  `assistant_turn_finished` path passes the tty width:
  `renderMarkdown(event.content, { width: (input.stdout as NodeJS.WriteStream).columns })`.
- Public API (`createMountedRenderer({ stdout, utf8?, setInterval?, clearInterval? })`
  → `{ handle, echoUserInput }`) is unchanged, so its consumer (the live-session)
  changes only its import source.

## ai-whisper changes (consumer rewiring)

- `packages/adapter-ai-ezio/package.json`: add
  `"@ai-ezio/surface": "file:../../../ai-ezio/packages/surface"`.
- Delete `src/render-markdown.ts` and `src/mounted-renderer.ts` (moved).
- `src/create-ai-ezio-live-session.ts`: import `createMountedRenderer` from
  `@ai-ezio/surface` instead of `./mounted-renderer.js`. No logic change.
- Delete `test/render-markdown.test.ts` and `test/mounted-renderer.test.ts`
  (their successors live in `@ai-ezio/surface`).
- **Declare `marked` + `marked-terminal` in `packages/cli/package.json`
  `dependencies`** (NOT only in `@ai-ezio/surface`). The CLI bundle inlines
  `@ai-ezio/*` TS packages (`scripts/bundle.mjs`), so `@ai-ezio/surface` is in the
  bundle — but its `marked`/`marked-terminal` imports are *npm* deps that the
  bundle **externalizes**. Without the declaration the published artifact throws
  `ERR_MODULE_NOT_FOUND` on `marked` (the exact class of bug that broke 0.5.0 on
  `@ai-ezio/harness`). `@ai-ezio/surface` still lists them too — for its own build
  and the future standalone CLI.
- `pnpm install` to materialize the `file:` dep into the store.

## Testing

In `@ai-ezio/surface`:
- `render-markdown.test.ts` — **structural** assertions (not brittle exact-ANSI):
  a table contains its cell values **and** a border glyph (`│`/`┌`/`─`); inline
  code is cyan; nested lists indent; a fenced block preserves its content; a
  blockquote and a link render; plain text passes through; malformed markdown
  degrades to text. Box-drawing glyphs are asserted (present regardless of color),
  so tests don't depend on chalk's color detection.
- `mounted-renderer.test.ts` — moved; the "markdown at turn end" case updates to
  the new renderer output; the **real-ESC regression guard** (a code must contain
  `\u001b[…`, catching the `ESC=""` class of bug) is preserved.

In ai-whisper:
- `adapter-ai-ezio-live-session.test.ts`, `live-session-runtime.test.ts`, and
  `ai-ezio-relay-integration.test.ts` stay green (the live-session delegates to
  the surface renderer; behavior unchanged).
- The **mount e2e** gains a table assertion: drive assistant content containing a
  markdown table and assert the pane shows a border glyph + the cell text — so the
  original raw-pipe bug cannot regress.

## Verification gate

- **ai-ezio:** `pnpm -r build && pnpm -r test` — `@ai-ezio/surface` builds and its
  tests pass; protocol/harness/cli unaffected. (hax/meson untouched.)
- **ai-whisper:** `pnpm install` (refresh `file:` store) → `pnpm -r build &&
  pnpm typecheck && pnpm lint && pnpm test && pnpm run e2e:ai-ezio-mount &&
  pnpm run e2e:ai-ezio-workflow`.
- **Bundle self-containment smoke test** (catches the 0.5.0/0.5.1 class of bug):
  after building the CLI, `npm pack` the `ai-whisper` package, install the tarball
  into a clean temp dir (no `@ai-ezio` / workspace symlinks), and run
  `whisper --version` — it must succeed (no `ERR_MODULE_NOT_FOUND`). This proves
  every inlined/externalized dependency resolves from the published artifact alone.
  Worth landing as a repeatable `scripts/` check so it can't silently regress.
- **Hard-constraint acceptance:** a live **claude/ezio** SDD run and a live
  **codex/ezio** SDD run each reach `done` with **zero empty handbacks** (the
  capture path is untouched, but we re-prove it). A markdown table in a real ezio
  pane renders as a tidy grid.

## Edge cases

- Wide tables wrap/truncate to the pane width (`reflowText` + width); unknown
  width falls back to 80.
- `NO_COLOR` / non-tty: box structure still renders; color drops gracefully.
- Empty or malformed markdown → plain text (no throw).
- Fenced code with no language → dim block, no syntax highlight (acceptable v1).
- `marked-terminal` emits real ESC bytes via chalk at runtime; source files carry
  no literal-ESC hazard (the bytes are generated, not authored).

## Out of scope (deferred to follow-up specs)

- Extracting the **session-drive** (hax-driving + stdin echo/line-edit/cancel)
  into `@ai-ezio/surface`.
- The `ezio --rich` standalone CLI (built right after this lands and is verified).
- hax's native C markdown renderer (used by standalone non-rich `ezio`); a
  separate engine-side concern.
- Syntax highlighting inside fenced code blocks.

## Success criteria

1. `@ai-ezio/surface` exists, builds, and its tests pass; `render-markdown` +
   `mounted-renderer` (and their deps) no longer live in ai-whisper.
2. A markdown table renders as a bordered grid in the ezio pane.
3. The full ai-whisper verification gate is green, including both e2e.
4. Live claude/ezio and codex/ezio SDD workflows still complete to `done` with
   zero empty handbacks.
