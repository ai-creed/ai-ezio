# ezio Surface Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract ezio's presentation surface (markdown renderer + mounted pane renderer) out of `ai-whisper/packages/adapter-ai-ezio` into a new `@ai-ezio/surface` package in the ai-ezio repo, and make the markdown renderer robust (tables, nested lists, fenced code, blockquotes) via `marked` + `marked-terminal`.

**Architecture:** A new ESM/`tsc --build`/`vitest` package `@ai-ezio/surface` mirrors `@ai-ezio/protocol`'s shape. It owns `style.ts` (ANSI palette), `render-markdown.ts` (robust `marked-terminal` renderer), and `mounted-renderer.ts` (moved verbatim, imports rewired). ai-whisper's `adapter-ai-ezio` consumes it via a `file:` dependency; the dependency direction (`ai-whisper → ai-ezio`) is unchanged. This is a **display-only** refactor — the capture pipeline, handback timing, provider, relay, and protocol controls are untouched.

**Tech Stack:** TypeScript (NodeNext, strict, composite), pnpm workspaces, vitest, `marked@^15`, `marked-terminal@^7`, `@types/marked-terminal@^6` (dev), esbuild (ai-whisper CLI bundle).

---

## Source of truth

Approved spec: `docs/superpowers/specs/2026-06-06-ezio-surface-extraction-design.md`.

## Repos & absolute paths

- **ai-ezio repo root:** `/Users/vuphan/Dev/ai-ezio` (this repo; new package lives here).
- **ai-whisper repo root:** `/Users/vuphan/Dev/ai-whisper` (sibling; consumer rewiring lives here).

The `adapter-ai-ezio` already pulls ai-ezio packages via `file:` deps (e.g. `"@ai-ezio/protocol": "file:../../../ai-ezio/packages/protocol"`); `@ai-ezio/surface` follows the same pattern.

## File structure (what gets created / modified)

**ai-ezio (`/Users/vuphan/Dev/ai-ezio`):**

- Create `packages/surface/package.json` — name `@ai-ezio/surface`; deps `marked`, `marked-terminal`, `@ai-ezio/protocol`; devDep `@types/marked-terminal`.
- Create `packages/surface/tsconfig.json` — extends `../../tsconfig.base.json`.
- Create `packages/surface/src/style.ts` — consolidated ezio ANSI palette.
- Create `packages/surface/src/render-markdown.ts` — robust `marked-terminal` renderer.
- Create `packages/surface/src/mounted-renderer.ts` — pane renderer (moved from ai-whisper, imports rewired).
- Create `packages/surface/src/index.ts` — re-exports `renderMarkdown`, `createMountedRenderer`, and the style module.
- Create `packages/surface/src/style.test.ts`, `render-markdown.test.ts`, `mounted-renderer.test.ts`.
- (Optional fallback) Create `packages/surface/src/marked-terminal.d.ts` — ambient shim, ONLY if `@types/marked-terminal` version-skews against `marked@^15`.
- Modify `tsconfig.json` (repo root) — add `{ "path": "packages/surface" }` to `references`.
- (No change to `pnpm-workspace.yaml` — already globs `packages/*`.)

**ai-whisper (`/Users/vuphan/Dev/ai-whisper`):**

- Modify `packages/adapter-ai-ezio/package.json` — add `"@ai-ezio/surface": "file:../../../ai-ezio/packages/surface"`.
- Modify `packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts` — import `createMountedRenderer` from `@ai-ezio/surface`.
- Delete `packages/adapter-ai-ezio/src/render-markdown.ts` and `packages/adapter-ai-ezio/src/mounted-renderer.ts`.
- Delete `packages/adapter-ai-ezio/test/render-markdown.test.ts` and `.../test/mounted-renderer.test.ts` **if they exist** (none present at plan time — coverage was via the mount e2e).
- Modify `packages/cli/package.json` — declare `marked` + `marked-terminal` in `dependencies` (bundle externalizes them).
- Modify `scripts/ai-ezio-mount-relay-e2e.mjs` — add a markdown-table pane assertion.
- Create `scripts/bundle-selfcontained-smoke.mjs` — pack + clean-install + `whisper --version` smoke test.
- Modify `package.json` — add a `smoke:bundle` script wiring the new smoke test.

## Style baseline (both repos use the project's own)

ai-ezio TypeScript baseline: **tabs** for indentation, **double quotes**, **semicolons**, multiline trailing commas. All code blocks below use tabs. ai-whisper matches the same TS conventions in its packages.

---

## Task 1: Scaffold the `@ai-ezio/surface` package

**Files:**
- Create: `/Users/vuphan/Dev/ai-ezio/packages/surface/package.json`
- Create: `/Users/vuphan/Dev/ai-ezio/packages/surface/tsconfig.json`
- Modify: `/Users/vuphan/Dev/ai-ezio/tsconfig.json`

- [ ] **Step 1: Create `package.json`**

```json
{
	"name": "@ai-ezio/surface",
	"version": "0.1.0",
	"description": "ai-ezio presentation surface: robust markdown renderer + mounted pane renderer",
	"license": "MIT",
	"type": "module",
	"exports": {
		".": {
			"types": "./dist/index.d.ts",
			"import": "./dist/index.js"
		}
	},
	"files": [
		"dist"
	],
	"scripts": {
		"build": "tsc --build",
		"test": "vitest run"
	},
	"dependencies": {
		"@ai-ezio/protocol": "workspace:*",
		"marked": "^15",
		"marked-terminal": "^7"
	},
	"devDependencies": {
		"@types/marked-terminal": "^6"
	}
}
```

- [ ] **Step 2: Create `tsconfig.json` (mirrors protocol)**

```json
{
	"extends": "../../tsconfig.base.json",
	"compilerOptions": {
		"rootDir": "src",
		"outDir": "dist"
	},
	"include": ["src/**/*.ts"],
	"exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 3: Add the project reference to the repo-root `tsconfig.json`**

Edit `/Users/vuphan/Dev/ai-ezio/tsconfig.json` so its `references` array includes the new package:

```json
{
	"files": [],
	"references": [
		{ "path": "packages/protocol" },
		{ "path": "packages/surface" },
		{ "path": "packages/harness" },
		{ "path": "packages/cli" }
	]
}
```

- [ ] **Step 4: Install so the workspace + `marked` deps materialize**

Run (from ai-ezio root): `pnpm install`
Expected: pnpm links `@ai-ezio/protocol` into `packages/surface/node_modules` and adds `marked`, `marked-terminal`, `@types/marked-terminal` to the store. No build yet.

- [ ] **Step 5: Commit**

```bash
cd /Users/vuphan/Dev/ai-ezio
git add packages/surface/package.json packages/surface/tsconfig.json tsconfig.json pnpm-lock.yaml
git commit -m "feat(surface): scaffold @ai-ezio/surface package"
```

---

## Task 2: `style.ts` — consolidated ANSI palette (TDD)

**Files:**
- Create: `/Users/vuphan/Dev/ai-ezio/packages/surface/src/style.ts`
- Test: `/Users/vuphan/Dev/ai-ezio/packages/surface/src/style.test.ts`

This consolidates the ESC constants duplicated in `render-markdown` and `mounted-renderer`. The critical invariant: `ESC` is the real escape byte `"\u001b"`, NEVER the empty string (the M8 bug that made every code ship as printable text).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { BOLD, BRIGHT_MAGENTA, CYAN, DIM, ESC, FG_DEFAULT, GREEN, RED, RESET } from "./style.js";

describe("style palette", () => {
	it("ESC is the real escape byte, never empty (M8 regression guard)", () => {
		expect(ESC).toBe("\u001b");
		expect(ESC).not.toBe("");
	});

	it("every color constant begins with a real ESC + CSI", () => {
		for (const code of [RESET, DIM, BOLD, CYAN, RED, GREEN, BRIGHT_MAGENTA, FG_DEFAULT]) {
			expect(code.startsWith("\u001b[")).toBe(true);
		}
	});

	it("uses the ezio-specific SGR numbers", () => {
		expect(CYAN).toBe("\u001b[36m");
		expect(BRIGHT_MAGENTA).toBe("\u001b[95m");
		expect(FG_DEFAULT).toBe("\u001b[39m");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/vuphan/Dev/ai-ezio && pnpm --filter @ai-ezio/surface test`
Expected: FAIL — `Cannot find module './style.js'` (file not created yet).

- [ ] **Step 3: Write the implementation**

```ts
/**
 * ezio ANSI palette, consolidated. Both render-markdown (marked-terminal color
 * callbacks) and mounted-renderer (banner / prompt / stripe / tool output)
 * import from here, eliminating the duplicated ESC constants that previously
 * lived in each file.
 *
 * INVARIANT: ESC is the real escape byte "\u001b" — never "" (the M8 bug, which
 * made every SGR code ship as printable text like "[36m").
 */

export const ESC = "\u001b";
export const RESET = `${ESC}[0m`;
export const DIM = `${ESC}[2m`;
export const BOLD = `${ESC}[1m`;
export const ITAL = `${ESC}[3m`;
export const CYAN = `${ESC}[36m`;
export const RED = `${ESC}[31m`;
export const GREEN = `${ESC}[32m`;
// Bright magenta (95), matching hax's PROMPT_UTF8 (ANSI_BRIGHT_MAGENTA) — the
// purple `❯` AND the submitted-prompt `▌ ` stripe. Regular magenta (35) is duller.
export const BRIGHT_MAGENTA = `${ESC}[95m`;
// Reset foreground only (not bold/etc), matching hax's submitted_emit row-end.
export const FG_DEFAULT = `${ESC}[39m`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/vuphan/Dev/ai-ezio && pnpm --filter @ai-ezio/surface test`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/vuphan/Dev/ai-ezio
git add packages/surface/src/style.ts packages/surface/src/style.test.ts
git commit -m "feat(surface): add consolidated ANSI style palette"
```

---

## Task 3: `render-markdown.ts` — robust marked-terminal renderer (TDD)

**Files:**
- Create: `/Users/vuphan/Dev/ai-ezio/packages/surface/src/render-markdown.ts`
- Test: `/Users/vuphan/Dev/ai-ezio/packages/surface/src/render-markdown.test.ts`

The renderer must cover the original raw-pipe table bug plus nested lists, fenced code, blockquotes, links, plain text, and malformed input. Tests are **structural** (box-drawing glyphs + cell text), not brittle exact-ANSI, so they don't depend on chalk's color detection.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./render-markdown.js";

describe("renderMarkdown", () => {
	it("renders a table as a bordered grid containing its cell values", () => {
		const md = "| Name | Role |\n| --- | --- |\n| Ada | Eng |";
		const out = renderMarkdown(md, { width: 80 });
		// cell text present
		expect(out).toContain("Ada");
		expect(out).toContain("Role");
		// at least one box-drawing border glyph (asserted regardless of color)
		expect(/[│┌─┐└┘├┤┬┴┼]/u.test(out)).toBe(true);
	});

	it("colors inline code cyan", () => {
		const out = renderMarkdown("use `npm test` now", { width: 80 });
		expect(out).toContain("npm test");
		expect(out).toContain("\u001b[36m"); // CYAN
	});

	it("indents nested lists", () => {
		const md = "- top\n  - nested";
		const out = renderMarkdown(md, { width: 80 });
		expect(out).toContain("top");
		expect(out).toContain("nested");
		const nestedLine = out.split("\n").find((l) => l.includes("nested")) ?? "";
		const topLine = out.split("\n").find((l) => l.includes("top")) ?? "";
		// nested item is indented further than the top-level item
		const indent = (s: string) => s.length - s.replace(/^[\s│]*/u, "").length;
		expect(indent(nestedLine)).toBeGreaterThan(indent(topLine));
	});

	it("preserves fenced code block content", () => {
		const md = "```\nconst x = 1;\n```";
		const out = renderMarkdown(md, { width: 80 });
		expect(out).toContain("const x = 1;");
	});

	it("renders a blockquote and a link", () => {
		const out = renderMarkdown("> quoted\n\n[site](https://example.com)", { width: 80 });
		expect(out).toContain("quoted");
		expect(out).toContain("site");
		expect(out).toContain("https://example.com");
	});

	it("passes plain text through", () => {
		const out = renderMarkdown("just words here", { width: 80 });
		expect(out).toContain("just words here");
	});

	it("degrades malformed markdown to text without throwing", () => {
		expect(() => renderMarkdown("| broken | table\n no pipes here **unclosed", { width: 80 })).not.toThrow();
		const out = renderMarkdown("| broken | table\n no pipes here **unclosed", { width: 80 });
		expect(out).toContain("broken");
	});

	it("trims trailing blank lines", () => {
		const out = renderMarkdown("hello", { width: 80 });
		expect(out.endsWith("\n")).toBe(false);
	});

	it("falls back to width 80 when no width given and no tty", () => {
		// no opts, no throw even when process.stdout.columns is undefined
		expect(() => renderMarkdown("hello")).not.toThrow();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/vuphan/Dev/ai-ezio && pnpm --filter @ai-ezio/surface test`
Expected: FAIL — `Cannot find module './render-markdown.js'`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Robust markdown → ANSI renderer for the mounted ezio pane and the future
 * standalone `ezio --rich`. Renders the FINAL assistant text through marked +
 * marked-terminal, so all CommonMark/GFM is covered: tables (bordered via
 * cli-table3), nested lists, fenced code, blockquotes, links. Malformed input
 * degrades to plain text rather than throwing.
 *
 * Width-aware: prose and wide tables reflow/wrap to the pane width instead of
 * overflowing. Trailing blank lines are trimmed so block spacing stays tight.
 */
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { BOLD, BRIGHT_MAGENTA, CYAN, DIM, RESET } from "./style.js";

export function renderMarkdown(md: string, opts?: { width?: number }): string {
	const width = opts?.width ?? process.stdout.columns ?? 80;
	const marked = new Marked();
	marked.use(
		markedTerminal({
			width,
			reflowText: true,
			tab: 2,
			// ezio palette via plain ANSI wrappers (not chalk) so color is stable
			// regardless of chalk's tty/NO_COLOR detection in tests.
			code: (s: string) => `${DIM}${s}${RESET}`,
			codespan: (s: string) => `${CYAN}${s}${RESET}`,
			blockquote: (s: string) => `${DIM}${s}${RESET}`,
			strong: (s: string) => `${BOLD}${s}${RESET}`,
			heading: (s: string) => `${BOLD}${BRIGHT_MAGENTA}${s}${RESET}`,
			firstHeading: (s: string) => `${BOLD}${BRIGHT_MAGENTA}${s}${RESET}`,
		}),
	);
	let out: string;
	try {
		out = marked.parse(md, { async: false }) as string;
	} catch {
		// Robust by construction: never throw on malformed input.
		return md;
	}
	// Trim trailing blank lines so block spacing stays tight (M8 tidiness).
	return out.replace(/\n+$/u, "");
}
```

> **Note on `markedTerminal` typing:** with `@types/marked-terminal` installed, the style callbacks and the `marked.use(...)` argument type-check under strict NodeNext. If the published `@types/marked-terminal@^6` version-skews against `marked@^15` and `marked.use(markedTerminal(...))` raises a type error, apply the Task 3a fallback below. Do not loosen `strict`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/vuphan/Dev/ai-ezio && pnpm --filter @ai-ezio/surface test`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/vuphan/Dev/ai-ezio
git add packages/surface/src/render-markdown.ts packages/surface/src/render-markdown.test.ts
git commit -m "feat(surface): robust marked-terminal markdown renderer"
```

---

## Task 3a (conditional): ambient declaration fallback for `marked-terminal`

Only do this task **if** Task 5's `tsc --build` fails with TS7016 (`could not find a declaration file for module 'marked-terminal'`) — i.e. the `@types/marked-terminal` package is missing or version-skewed against `marked@^15`. The preferred path is the `@types/marked-terminal` devDependency from Task 1; this is the escape hatch.

**Files:**
- Create: `/Users/vuphan/Dev/ai-ezio/packages/surface/src/marked-terminal.d.ts`

- [ ] **Step 1: Create the ambient shim**

```ts
// Fallback only: silences TS7016 when @types/marked-terminal is unavailable or
// version-skewed against the installed marked. Options become `any`-typed; prefer
// the @types/marked-terminal devDependency when it resolves cleanly.
declare module "marked-terminal";
```

- [ ] **Step 2: Re-run the build**

Run: `cd /Users/vuphan/Dev/ai-ezio && pnpm --filter @ai-ezio/surface build`
Expected: PASS (no TS7016). If the `@types` package already resolved, skip this task entirely and do not create the file.

- [ ] **Step 3: Commit (only if the file was needed)**

```bash
cd /Users/vuphan/Dev/ai-ezio
git add packages/surface/src/marked-terminal.d.ts
git commit -m "build(surface): ambient marked-terminal declaration fallback"
```

---

## Task 4: `mounted-renderer.ts` — move with rewired imports (TDD)

**Files:**
- Create: `/Users/vuphan/Dev/ai-ezio/packages/surface/src/mounted-renderer.ts`
- Test: `/Users/vuphan/Dev/ai-ezio/packages/surface/src/mounted-renderer.test.ts`

Moved verbatim from `ai-whisper/packages/adapter-ai-ezio/src/mounted-renderer.ts`, with three changes only: (1) ANSI constants now import from `./style.js`; (2) `renderMarkdown` import stays local (`./render-markdown.js`); (3) the `assistant_turn_finished` path passes the tty width into `renderMarkdown`. The public API is unchanged.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import type { ProtocolEvent } from "@ai-ezio/protocol";
import { createMountedRenderer } from "./mounted-renderer.js";

function collect(events: ProtocolEvent[], cols = 80): string {
	let out = "";
	const stdout = {
		write: (s: string) => {
			out += s;
			return true;
		},
		columns: cols,
	} as unknown as NodeJS.WriteStream;
	const noop = () => 0;
	const r = createMountedRenderer({
		stdout,
		setInterval: noop,
		clearInterval: () => {},
	});
	for (const e of events) r.handle(e);
	return out;
}

describe("createMountedRenderer", () => {
	it("renders the banner on first status event with real ESC bytes", () => {
		const out = collect([
			{ type: "status", provider: "anthropic", model: "claude", effort: "" } as ProtocolEvent,
		]);
		expect(out).toContain("ezio");
		// real-ESC regression guard: a real escape byte, not literal "[36m" text
		expect(out).toContain("\u001b[");
	});

	it("renders markdown (incl. a table) at assistant_turn_finished", () => {
		const out = collect([
			{ type: "status", provider: "p", model: "m", effort: "" } as ProtocolEvent,
			{
				type: "assistant_turn_finished",
				content: "| A | B |\n| --- | --- |\n| 1 | 2 |",
			} as ProtocolEvent,
		]);
		expect(out).toContain("A");
		expect(out).toContain("1");
		// table border glyph proves the robust renderer ran (no raw `| --- |`)
		expect(/[│┌─]/u.test(out)).toBe(true);
	});

	it("exposes the unchanged public API (handle + echoUserInput)", () => {
		const stdout = { write: () => true, columns: 80 } as unknown as NodeJS.WriteStream;
		const r = createMountedRenderer({ stdout, setInterval: () => 0, clearInterval: () => {} });
		expect(typeof r.handle).toBe("function");
		expect(typeof r.echoUserInput).toBe("function");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/vuphan/Dev/ai-ezio && pnpm --filter @ai-ezio/surface test`
Expected: FAIL — `Cannot find module './mounted-renderer.js'`.

- [ ] **Step 3: Write the implementation**

Copy the body verbatim from `/Users/vuphan/Dev/ai-whisper/packages/adapter-ai-ezio/src/mounted-renderer.ts`, then apply exactly the changes shown. The full file:

```ts
/**
 * Mounted ezio pane renderer. Owns ALL presentation for a mounted ezio session —
 * banner, thinking spinner, markdown (at turn end), tool calls (invocation +
 * output preview + colored diffs), usage line, prompt, errors — driven entirely
 * by protocol events (engine stays protocol-native; no PTY, no scraping). Pure
 * unit: feed it events via `handle()`, it writes ANSI to stdout. Timer + UTF-8
 * detection are injectable seams so spinner idle-safety and the prompt fallback
 * are deterministically testable.
 */
import type { ProtocolEvent } from "@ai-ezio/protocol";
import { renderMarkdown } from "./render-markdown.js";
import { BOLD, BRIGHT_MAGENTA, CYAN, DIM, ESC, FG_DEFAULT, GREEN, RED, RESET } from "./style.js";

// Cell width of the `▌ ` stripe (box glyph + space) — body wraps after it.
const STRIPE_COLS = 2;
const CLEAR_LINE = `\r${ESC}[2K`;
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PREVIEW_LINES = 4;
const ARG_MAX = 80;

// Mirrors hax's format_tokens (vendor/hax/src/agent.c) — binary k/M with the
// same rounding: 595 -> "595", 8900 -> "8.7k", 262144 -> "256k".
function fmtTokens(n: number): string {
	if (n < 0) return "?";
	if (n < 1024) return String(n);
	if (n < 10 * 1024) return `${(n / 1024).toFixed(1)}k`;
	if (n < 1024 * 1024) return `${Math.floor((n + 512) / 1024)}k`;
	if (n < 10 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}M`;
	return `${Math.floor((n + 512 * 1024) / (1024 * 1024))}M`;
}

function truncate(s: string, max = ARG_MAX): string {
	const oneLine = s.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

type UsageT = NonNullable<Extract<ProtocolEvent, { type: "assistant_turn_finished" }>["usage"]>;

export function createMountedRenderer(input: {
	stdout: NodeJS.WritableStream;
	utf8?: boolean;
	setInterval?: (cb: () => void, ms: number) => unknown;
	clearInterval?: (handle: unknown) => void;
}) {
	const utf8 = input.utf8 ?? true;
	const setI = input.setInterval ?? ((cb, ms) => globalThis.setInterval(cb, ms));
	const clrI = input.clearInterval ?? ((h) => globalThis.clearInterval(h as never));
	const w = (s: string) => input.stdout.write(s);
	const prompt = utf8 ? `${BRIGHT_MAGENTA}${BOLD}❯${RESET} ` : "> ";

	let bannerRendered = false;
	let lastUsage: UsageT | undefined;
	// spinner
	let spinHandle: unknown = null;
	let spinFrame = 0;
	let spinVisible = false;
	let spinRunning = false;

	const stopSpinner = () => {
		if (spinHandle !== null) {
			clrI(spinHandle);
			spinHandle = null;
		}
		spinRunning = false;
		if (spinVisible) {
			w(CLEAR_LINE);
			spinVisible = false;
		}
	};
	const tick = () => {
		if (!spinRunning) return; // idle-safety: a stale interval writes nothing
		w(`${CLEAR_LINE}${DIM}${SPIN[spinFrame++ % SPIN.length]} thinking…${RESET}`);
		spinVisible = true;
	};
	const startSpinner = () => {
		spinFrame = 0;
		spinRunning = true;
		tick();
		spinHandle = setI(tick, 80);
	};

	const renderBanner = (provider: string, model: string, effort: string) => {
		// Banner uses hax's dim `›` (matches `hax › codex · …`); the magenta `❯`
		// is reserved for the input prompt below.
		const tail = effort ? `${provider} · ${model} · ${effort}` : `${provider} · ${model}`;
		w(`${CYAN}▌${RESET} ${BOLD}ezio${RESET} ${DIM}› ${tail}${RESET}\n`);
	};

	const usageLine = (u: UsageT): string => {
		const parts: string[] = [];
		if (typeof u.contextTokens === "number") {
			let s = `context ${fmtTokens(u.contextTokens)}`;
			if (typeof u.contextLimit === "number" && u.contextLimit > 0)
				s += ` / ${fmtTokens(u.contextLimit)} (${Math.floor((u.contextTokens * 100) / u.contextLimit)}%)`;
			parts.push(s);
		}
		if (typeof u.outputTokens === "number") parts.push(`out ${fmtTokens(u.outputTokens)}`);
		if (typeof u.cachedTokens === "number" && u.cachedTokens > 0)
			parts.push(`cached ${fmtTokens(u.cachedTokens)}`);
		return parts.length > 0 ? `${DIM}${parts.join(" · ")}${RESET}` : "";
	};

	const renderToolStart = (name: string, args?: string) => {
		const tail = args ? ` · ${truncate(args)}` : "";
		w(`\n${DIM}⏺ ${name}${tail}${RESET}`);
	};

	const renderToolFinish = (status: "ok" | "error", output?: string, isDiff?: boolean) => {
		if (isDiff && output) {
			for (const line of output.split("\n")) {
				if (line.length === 0) continue;
				const color = line.startsWith("+") ? GREEN : line.startsWith("-") ? RED : DIM;
				w(`\n${color}${line}${RESET}`);
			}
			return;
		}
		const color = status === "error" ? RED : DIM;
		const lines = (output ?? "").split("\n").filter((l) => l.length > 0);
		if (lines.length === 0) {
			if (status === "error") w(`\n${RED}  (error)${RESET}`);
			return;
		}
		for (const l of lines.slice(0, PREVIEW_LINES)) w(`\n${color}  ${truncate(l, 120)}${RESET}`);
		if (lines.length > PREVIEW_LINES) w(`\n${DIM}  …(+${lines.length - PREVIEW_LINES})${RESET}`);
	};

	// Re-render a just-submitted operator line as hax's bright-magenta `▌ ` stripe
	// + magenta body, hard-wrapping at every visual row (hax submitted_emit). The
	// line-buffered runtime erases its plain echo first, then calls this. `cols` is
	// the live tty width; the ASCII fallback uses `|` so it never emits a stray
	// box glyph on a non-UTF-8 terminal.
	const echoUserInput = (text: string, cols: number): void => {
		const stripe = utf8 ? "▌ " : "| ";
		const width = Math.max(1, cols - STRIPE_COLS); // body cols after the stripe
		const cps = Array.from(text); // code points, so surrogate pairs wrap as one
		const rows: string[] = [];
		for (let i = 0; i < cps.length; i += width) rows.push(cps.slice(i, i + width).join(""));
		if (rows.length === 0) rows.push("");
		const block = rows.map((r) => `${BRIGHT_MAGENTA}${stripe}${r}${FG_DEFAULT}`).join("\n");
		w(`${block}\n`);
	};

	return {
		echoUserInput,
		handle(event: ProtocolEvent): void {
			switch (event.type) {
				case "status":
					if (!bannerRendered) {
						renderBanner(event.provider, event.model, event.effort ?? "");
						bannerRendered = true;
					}
					break;
				case "user_turn_started":
					startSpinner();
					break;
				case "assistant_delta":
					// Suppressed from the pane — markdown renders at turn end. (The
					// live-session still forwards deltas to onProviderOutput.)
					break;
				case "tool_call_started":
					stopSpinner();
					renderToolStart(event.name, event.args);
					break;
				case "tool_call_finished":
					renderToolFinish(event.status, event.output, event.isDiff);
					break;
				case "assistant_turn_finished":
					stopSpinner();
					lastUsage = event.usage;
					if (event.content)
						w(`\n${renderMarkdown(event.content, { width: (input.stdout as NodeJS.WriteStream).columns })}\n`);
					break;
				case "idle":
					stopSpinner();
					if (lastUsage) {
						const u = usageLine(lastUsage);
						if (u) w(`\n${u}`);
						lastUsage = undefined;
					}
					w(`\n${prompt}`);
					break;
				case "error":
					stopSpinner();
					w(`\n${RED}▌ ${event.message}${RESET}\n${prompt}`);
					break;
				default:
					break;
			}
		},
	};
}
```

The diff vs the ai-whisper original is exactly: removed the local `ESC`/`RESET`/`DIM`/`BOLD`/`CYAN`/`RED`/`GREEN`/`BRIGHT_MAGENTA`/`FG_DEFAULT` constant block (now imported from `./style.js`); kept `STRIPE_COLS`/`CLEAR_LINE`/`SPIN`/`PREVIEW_LINES`/`ARG_MAX` local; and changed the `assistant_turn_finished` write to pass `{ width: (input.stdout as NodeJS.WriteStream).columns }` into `renderMarkdown`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/vuphan/Dev/ai-ezio && pnpm --filter @ai-ezio/surface test`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/vuphan/Dev/ai-ezio
git add packages/surface/src/mounted-renderer.ts packages/surface/src/mounted-renderer.test.ts
git commit -m "feat(surface): move mounted pane renderer with rewired imports"
```

---

## Task 5: `index.ts` re-exports + full build/test gate

**Files:**
- Create: `/Users/vuphan/Dev/ai-ezio/packages/surface/src/index.ts`

- [ ] **Step 1: Write the barrel module**

```ts
/**
 * @ai-ezio/surface — ezio's presentation surface: the robust markdown renderer
 * and the mounted pane renderer, plus the shared ANSI palette. Consumed by
 * ai-whisper's adapter-ai-ezio today and by the future standalone `ezio --rich`.
 */
export { renderMarkdown } from "./render-markdown.js";
export { createMountedRenderer } from "./mounted-renderer.js";
export * as style from "./style.js";
```

- [ ] **Step 2: Build the package (proves typing resolves — TS7016 guard)**

Run: `cd /Users/vuphan/Dev/ai-ezio && pnpm --filter @ai-ezio/surface build`
Expected: PASS, emits `packages/surface/dist/{index,style,render-markdown,mounted-renderer}.js` + `.d.ts`.
If it FAILS with TS7016 on `marked-terminal`, do Task 3a, then re-run.

- [ ] **Step 3: Run the whole ai-ezio build + test graph (no regressions)**

Run: `cd /Users/vuphan/Dev/ai-ezio && pnpm -r build && pnpm -r test`
Expected: PASS — `@ai-ezio/surface` builds and its tests pass; protocol / harness / cli unaffected. (hax / meson untouched.)

- [ ] **Step 4: Commit**

```bash
cd /Users/vuphan/Dev/ai-ezio
git add packages/surface/src/index.ts packages/surface/dist
git commit -m "feat(surface): index barrel; package builds and tests green"
```

(If `dist/` is gitignored in this repo, omit it from the `git add` — commit only `src/index.ts`.)

---

## Task 6: ai-whisper — wire the `file:` dependency and swap the live-session import

**Files:**
- Modify: `/Users/vuphan/Dev/ai-whisper/packages/adapter-ai-ezio/package.json`
- Modify: `/Users/vuphan/Dev/ai-whisper/packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts`

- [ ] **Step 1: Add the `file:` dependency**

In `packages/adapter-ai-ezio/package.json`, add to `dependencies` (alongside the existing `@ai-ezio/harness` / `@ai-ezio/protocol` file deps):

```json
		"@ai-ezio/surface": "file:../../../ai-ezio/packages/surface"
```

Resulting `dependencies` block:

```json
	"dependencies": {
		"@ai-whisper/shared": "workspace:*",
		"@ai-ezio/harness": "file:../../../ai-ezio/packages/harness",
		"@ai-ezio/protocol": "file:../../../ai-ezio/packages/protocol",
		"@ai-ezio/surface": "file:../../../ai-ezio/packages/surface"
	}
```

- [ ] **Step 2: Swap the import in `create-ai-ezio-live-session.ts`**

Change line 8 from:

```ts
import { createMountedRenderer } from "./mounted-renderer.js";
```

to:

```ts
import { createMountedRenderer } from "@ai-ezio/surface";
```

No other change in this file — the `createMountedRenderer({ stdout: input.stdout })` call site (line ~30) is unchanged; the public API is identical.

- [ ] **Step 3: Install to materialize the `file:` dep into the store**

Run: `cd /Users/vuphan/Dev/ai-whisper && pnpm install`
Expected: pnpm resolves `@ai-ezio/surface` from the sibling repo and links it into the adapter's `node_modules`.

- [ ] **Step 4: Commit**

```bash
cd /Users/vuphan/Dev/ai-whisper
git add packages/adapter-ai-ezio/package.json packages/adapter-ai-ezio/src/create-ai-ezio-live-session.ts pnpm-lock.yaml
git commit -m "refactor(adapter-ai-ezio): consume @ai-ezio/surface for mounted renderer"
```

---

## Task 7: ai-whisper — delete the moved source (and any moved tests)

**Files:**
- Delete: `/Users/vuphan/Dev/ai-whisper/packages/adapter-ai-ezio/src/render-markdown.ts`
- Delete: `/Users/vuphan/Dev/ai-whisper/packages/adapter-ai-ezio/src/mounted-renderer.ts`
- Delete (if present): `.../test/render-markdown.test.ts`, `.../test/mounted-renderer.test.ts`

- [ ] **Step 1: Remove the moved modules and any sibling tests**

Run:

```bash
cd /Users/vuphan/Dev/ai-whisper
git rm packages/adapter-ai-ezio/src/render-markdown.ts packages/adapter-ai-ezio/src/mounted-renderer.ts
# tests may not exist (coverage was via the mount e2e) — remove only if tracked:
git rm --ignore-unmatch \
	packages/adapter-ai-ezio/test/render-markdown.test.ts \
	packages/adapter-ai-ezio/test/mounted-renderer.test.ts
```

- [ ] **Step 2: Verify nothing else imports the deleted modules**

Run:

```bash
cd /Users/vuphan/Dev/ai-whisper
grep -rn "mounted-renderer\|render-markdown" packages --include='*.ts' | grep -v node_modules | grep -v dist
```

Expected: NO matches (the only consumer was `create-ai-ezio-live-session.ts`, rewired in Task 6). If a match appears, rewire that import to `@ai-ezio/surface` before proceeding.

- [ ] **Step 3: Typecheck the adapter**

Run: `cd /Users/vuphan/Dev/ai-whisper && pnpm --filter @ai-whisper/adapter-ai-ezio typecheck`
Expected: PASS — no dangling references to the deleted files.

- [ ] **Step 4: Commit**

```bash
cd /Users/vuphan/Dev/ai-whisper
git add -A packages/adapter-ai-ezio
git commit -m "refactor(adapter-ai-ezio): drop moved renderer source (now in @ai-ezio/surface)"
```

---

## Task 8: ai-whisper — declare `marked` + `marked-terminal` in the CLI bundle deps

**Files:**
- Modify: `/Users/vuphan/Dev/ai-whisper/packages/cli/package.json`

**Why:** `scripts/bundle.mjs` inlines `@ai-ezio/*` TS packages (so `@ai-ezio/surface` is in the bundle), but its `externalizeNpmDeps` plugin keeps every bare npm import (`marked`, `marked-terminal`) **external**. Without declaring them in the CLI's `dependencies`, the published artifact throws `ERR_MODULE_NOT_FOUND` on `marked` at runtime — the exact class of bug that broke 0.5.0 on `@ai-ezio/harness`.

- [ ] **Step 1: Add the two runtime deps**

In `packages/cli/package.json` `dependencies`, add `marked` and `marked-terminal` (keep alphabetical-ish ordering consistent with the file):

```json
		"marked": "^15",
		"marked-terminal": "^7",
```

Resulting `dependencies` (additions shown in context):

```json
	"dependencies": {
		"@anthropic-ai/sdk": "^0.88.0",
		"better-sqlite3": "^11.8.1",
		"commander": "^13.1.0",
		"fastify": "^5.2.1",
		"ink": "^7.0.3",
		"marked": "^15",
		"marked-terminal": "^7",
		"nanoid": "^5.1.5",
		"node-pty": "^1.1.0",
		"ollama": "^0.6.3",
		"react": "^19.2.6",
		"zod": "^3.24.2"
	}
```

- [ ] **Step 2: Install**

Run: `cd /Users/vuphan/Dev/ai-whisper && pnpm install`
Expected: `marked` + `marked-terminal` added to the CLI package's resolved deps.

- [ ] **Step 3: Commit**

```bash
cd /Users/vuphan/Dev/ai-whisper
git add packages/cli/package.json pnpm-lock.yaml
git commit -m "build(cli): declare marked + marked-terminal (externalized bundle deps)"
```

---

## Task 9: ai-whisper — mount e2e gains a markdown-table assertion

**Files:**
- Modify: `/Users/vuphan/Dev/ai-whisper/scripts/ai-ezio-mount-relay-e2e.mjs`

So the original raw-pipe bug cannot regress: drive assistant content containing a markdown table through the mock provider and assert the pane shows a border glyph + the cell text.

- [ ] **Step 1: Extend the mock script to emit a table turn**

The e2e currently writes a tool-turn mock script (around line 23):

```js
writeFileSync(
	mockScriptPath,
	`tool bash {"command":"echo ${TOOL_MARKER}"}\nend-turn\ntext Done\nend-turn\n`,
);
```

Replace the final `text Done\nend-turn\n` turn with a markdown-table turn so the same run exercises table rendering. Use a recognizable cell marker:

```js
const TABLE_CELL = "M8_TABLE_CELL";
writeFileSync(
	mockScriptPath,
	`tool bash {"command":"echo ${TOOL_MARKER}"}\nend-turn\n` +
		`text | Col | Val |\\n| --- | --- |\\n| ${TABLE_CELL} | 2 |\nend-turn\n`,
);
```

(If the mock DSL's `text` directive does not interpret `\n`, instead emit the table as a single logical assistant message per the DSL's multi-line convention used elsewhere in the repo — inspect adjacent mock scripts under `vendor/hax` / `scripts` and match their escaping. The assertion in Step 2 is what matters.)

- [ ] **Step 2: Add the pane assertion (after the existing tool-output assertion, ~line 144)**

```js
// M-surface: the table turn must render as a bordered grid — the cell text AND a
// box-drawing glyph — proving @ai-ezio/surface's robust renderer ran (no raw `| --- |`).
await sleep(500); // let the table turn flush to the pane
const hasCell = mountLog.includes(TABLE_CELL);
const hasBorder = /[│┌─]/u.test(mountLog);
if (!hasCell || !hasBorder) {
	cleanup();
	console.error(
		`FAIL: markdown table not rendered as a grid in the mounted pane (cell=${hasCell}, border=${hasBorder})\n` +
			mountLog.slice(-2500),
	);
	process.exit(1);
}
console.log("OK: markdown table renders as a bordered grid (cell + box glyph) in the mounted ezio pane");
```

- [ ] **Step 3: Run the mount e2e (requires the ai-ezio hax binary built)**

Run: `cd /Users/vuphan/Dev/ai-whisper && pnpm run build && pnpm run e2e:ai-ezio-mount`
Expected: PASS — all existing OK lines plus `OK: markdown table renders as a bordered grid ...`.

- [ ] **Step 4: Commit**

```bash
cd /Users/vuphan/Dev/ai-whisper
git add scripts/ai-ezio-mount-relay-e2e.mjs
git commit -m "test(e2e): assert markdown table renders as a grid in the mounted pane"
```

---

## Task 10: ai-whisper — bundle self-containment smoke test

**Files:**
- Create: `/Users/vuphan/Dev/ai-whisper/scripts/bundle-selfcontained-smoke.mjs`
- Modify: `/Users/vuphan/Dev/ai-whisper/package.json`

Catches the 0.5.0/0.5.1 class of bug (`ERR_MODULE_NOT_FOUND`): after building the CLI, `npm pack`, install the tarball into a clean temp dir with **no** `@ai-ezio` / workspace symlinks, and run `whisper --version`.

- [ ] **Step 1: Write the smoke script**

```js
#!/usr/bin/env node
// Bundle self-containment smoke test. Proves the published artifact resolves
// every inlined/externalized dependency from the tarball alone — no workspace
// symlinks, no `@ai-ezio/*` file: deps in scope. Catches the ERR_MODULE_NOT_FOUND
// class of bug (e.g. an externalized `marked` not declared in CLI dependencies).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliRoot = join(process.cwd(), "packages/cli");
const tmp = mkdtempSync(join(tmpdir(), "whisper-pack-smoke-"));

const run = (cmd, args, cwd) =>
	execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

try {
	// 1) Build then pack the CLI package into the temp dir.
	run("npm", ["pack", "--pack-destination", tmp], cliRoot);
	const tarball = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
	if (!tarball) throw new Error("npm pack produced no tarball");

	// 2) Install the tarball into a clean project (no workspace, no @ai-ezio symlinks).
	run("npm", ["init", "-y"], tmp);
	run("npm", ["install", join(tmp, tarball)], tmp);

	// 3) Run the published bin — must not throw ERR_MODULE_NOT_FOUND.
	const binPath = join(tmp, "node_modules", ".bin", "whisper");
	const out = run(binPath, ["--version"], tmp);
	if (!out.trim()) throw new Error("whisper --version produced no output");

	console.log(`OK: bundle self-contained — whisper --version => ${out.trim()}`);
} catch (err) {
	console.error("FAIL: bundle is not self-contained\n" + (err.stderr || err.message || String(err)));
	process.exitCode = 1;
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
```

- [ ] **Step 2: Wire a script entry in the root `package.json`**

Add to `scripts`:

```json
		"smoke:bundle": "node scripts/bundle-selfcontained-smoke.mjs"
```

- [ ] **Step 3: Run the smoke test (after a CLI build)**

Run: `cd /Users/vuphan/Dev/ai-whisper && pnpm run build && pnpm run smoke:bundle`
Expected: PASS — `OK: bundle self-contained — whisper --version => 0.5.x`.
A FAIL with `ERR_MODULE_NOT_FOUND: marked` means Task 8 was not applied or did not take — fix the CLI deps and re-run.

- [ ] **Step 4: Commit**

```bash
cd /Users/vuphan/Dev/ai-whisper
git add scripts/bundle-selfcontained-smoke.mjs package.json
git commit -m "test(smoke): repeatable bundle self-containment check (npm pack + clean install)"
```

---

## Task 11: Full verification gate (both repos)

No new files — this task runs the complete acceptance gate from the spec and confirms green output before claiming done.

- [ ] **Step 1: ai-ezio build + test**

Run: `cd /Users/vuphan/Dev/ai-ezio && pnpm -r build && pnpm -r test`
Expected: PASS — surface builds + tests pass; protocol/harness/cli unaffected.

- [ ] **Step 2: ai-whisper full gate**

Run:

```bash
cd /Users/vuphan/Dev/ai-whisper
pnpm install
pnpm -r build && pnpm typecheck && pnpm lint && pnpm test
```

Expected: PASS — including `adapter-ai-ezio-live-session.test.ts`, `live-session-runtime.test.ts`, and `ai-ezio-relay-integration.test.ts` (the live-session delegates to the surface renderer; behavior unchanged).

- [ ] **Step 3: ai-whisper e2e**

Run:

```bash
cd /Users/vuphan/Dev/ai-whisper
pnpm run e2e:ai-ezio-mount && pnpm run e2e:ai-ezio-workflow
```

Expected: PASS — mount e2e shows the new table-grid OK line; workflow e2e reaches `done`.

- [ ] **Step 4: Bundle smoke test**

Run: `cd /Users/vuphan/Dev/ai-whisper && pnpm run smoke:bundle`
Expected: PASS — `OK: bundle self-contained`.

- [ ] **Step 5: Hard-constraint acceptance (live SDD runs)**

Re-prove the working workflows are intact (the capture path is untouched, but the spec requires re-proving):
- A live **claude/ezio** SDD run reaches `done` with **zero empty handbacks**.
- A live **codex/ezio** SDD run reaches `done` with **zero empty handbacks**.
- A markdown table in a real ezio pane renders as a tidy grid.

- [ ] **Step 6: Final commit / branch wrap-up**

If on a feature branch, ensure all task commits are present and the working tree is clean:

```bash
cd /Users/vuphan/Dev/ai-ezio && git status
cd /Users/vuphan/Dev/ai-whisper && git status
```

Expected: both clean. Proceed to PR/merge per `superpowers:finishing-a-development-branch`.

---

## Self-review (plan vs spec)

**Spec coverage:**

- Surface package exists/builds/tests (spec §Architecture, success criterion 1) → Tasks 1–5.
- `style.ts` consolidates palette, real ESC byte (spec §Components/style.ts) → Task 2.
- Robust markdown via marked + marked-terminal, width-aware, trailing-trim, malformed fallback (spec §render-markdown) → Task 3.
- **Typing strategy for `marked-terminal` (TS7016)** (spec §Typing strategy) → `@types/marked-terminal` devDep in Task 1 + Task 3a ambient-shim fallback.
- mounted-renderer moved verbatim, imports rewired, width passed, public API unchanged (spec §mounted-renderer) → Task 4.
- ai-whisper rewiring: file: dep, import swap, delete moved files/tests (spec §ai-whisper changes) → Tasks 6–7.
- Declare marked/marked-terminal in CLI deps (spec §ai-whisper changes, bundle note) → Task 8.
- Structural renderer tests + real-ESC guard (spec §Testing) → Tasks 2–4 tests.
- Mount e2e table assertion (spec §Testing) → Task 9.
- Bundle self-containment smoke test (spec §Verification gate) → Task 10.
- Full verification gate incl. both e2e + live SDD runs (spec §Verification gate, success criteria 3–4) → Task 11.

**Placeholder scan:** every code/command step contains concrete content; the only conditional is Task 3a (explicitly gated on a TS7016 failure) and the "tests may not exist" deletion in Task 7 (handled with `git rm --ignore-unmatch`).

**Type/name consistency:** `renderMarkdown(md, { width })` signature is identical in Task 3 (definition), Task 4 (call site), and the tests. `createMountedRenderer({ stdout, utf8?, setInterval?, clearInterval? })` → `{ handle, echoUserInput }` is identical in Task 4 (definition), Task 6 (consumer), and the tests. Style constant names (`ESC`, `RESET`, `DIM`, `BOLD`, `ITAL`, `CYAN`, `RED`, `GREEN`, `BRIGHT_MAGENTA`, `FG_DEFAULT`) match across `style.ts`, its test, and `mounted-renderer.ts`.

## Out of scope (per spec — do NOT do here)

- Extracting the session-drive (hax-driving + stdin echo/line-edit/cancel) into surface.
- The `ezio --rich` standalone CLI (built right after this lands).
- hax's native C markdown renderer.
- Syntax highlighting inside fenced code blocks.
- Any change to the capture pipeline, handback timing, provider, relay, or protocol controls.
