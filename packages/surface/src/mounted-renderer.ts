/**
 * Mounted ezio pane renderer. Owns ALL presentation for a mounted ezio session —
 * banner, turn-long tool-aware spinner, markdown (at turn end), tool calls
 * (invocation + output preview + colored diffs), duration-led stats line, prompt,
 * errors — driven entirely by protocol events (engine stays protocol-native; no
 * PTY, no scraping). Pure unit: feed it events via `handle()`, it writes ANSI to
 * stdout. Timer + UTF-8 detection are injectable seams so spinner idle-safety
 * and the prompt fallback are deterministically testable.
 */
import type { ProtocolEvent } from "@ai-ezio/protocol";
import stringWidth from "string-width";
import { renderMarkdown } from "./render-markdown.js";
import { createSpinnerModel, fmtDuration } from "./spinner-model.js";
import { BOLD, BRIGHT_MAGENTA, CYAN, DIM, ESC, FG_DEFAULT, GREEN, RED, RESET } from "./style.js";

// Cell width of the `▌ ` stripe (box glyph + space) — body wraps after it.
const STRIPE_COLS = 2;
// Visible cell width of the input prompt — both `❯ ` (utf8) and `> ` (ascii).
const PROMPT_CELLS = 2;
const CLEAR_LINE = `\r${ESC}[2K`;
const CURSOR_UP = `${ESC}[1A`;
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
	/** Injectable clock (tests); defaults to Date.now. */
	now?: () => number;
}) {
	const utf8 = input.utf8 ?? true;
	const setI = input.setInterval ?? ((cb, ms) => globalThis.setInterval(cb, ms));
	const clrI = input.clearInterval ?? ((h) => globalThis.clearInterval(h as never));
	const nowFn = input.now ?? (() => Date.now());
	const w = (s: string) => input.stdout.write(s);
	const prompt = utf8 ? `${BRIGHT_MAGENTA}${BOLD}❯${RESET} ` : "> ";

	let bannerRendered = false;
	let lastUsage: UsageT | undefined;
	let turnStartAt = -1;
	let lastElapsedMs = -1;
	let turnErrored = false;
	// spinner — state lives in the pure model; this block owns only the
	// interval, the visible-row bookkeeping, and the parked-row discipline.
	let model = createSpinnerModel({ utf8 });
	let spinHandle: unknown = null;
	let spinFrame = 0;
	let spinVisible = false;
	let spinnerRowOpen = false;

	const clearSpinnerRow = () => {
		if (spinVisible) {
			w(CLEAR_LINE);
			spinVisible = false;
		}
	};
	// Every content write goes through this guard: the spinner row is cleared
	// first and marked closed, so the next tick re-parks one line below the
	// new content instead of overwriting it.
	const writeContent = (s: string) => {
		clearSpinnerRow();
		spinnerRowOpen = false;
		w(s);
	};
	const tick = () => {
		const cols = (input.stdout as NodeJS.WriteStream).columns ?? 80;
		const row = model.frame(nowFn(), spinFrame++, cols);
		if (row === null) {
			clearSpinnerRow();
			return; // idle-safety: a stale interval draws nothing
		}
		if (!spinnerRowOpen) {
			w("\n"); // park one line below the last content (upstream's rule)
			spinnerRowOpen = true;
		}
		w(`${CLEAR_LINE}${DIM}${row}${RESET}`);
		spinVisible = true;
	};
	const startSpinnerInterval = () => {
		if (spinHandle !== null) return;
		spinFrame = 0;
		tick();
		spinHandle = setI(tick, 80);
	};
	const stopSpinnerInterval = () => {
		if (spinHandle !== null) {
			clrI(spinHandle);
			spinHandle = null;
		}
		clearSpinnerRow();
		spinnerRowOpen = false;
	};

	const renderBanner = (provider: string, model: string, effort: string) => {
		// Banner uses hax's dim `›` (matches `hax › codex · …`); the magenta `❯`
		// is reserved for the input prompt below.
		const tail = effort ? `${provider} · ${model} · ${effort}` : `${provider} · ${model}`;
		writeContent(`${CYAN}▌${RESET} ${BOLD}ezio${RESET} ${DIM}› ${tail}${RESET}\n`);
	};

	// Per-turn stats, narrow→wide (upstream 8a32185): this turn's wall time,
	// then the window gauge. out/cached moved to the transcript's per-request
	// footers; /usage keeps the full payload. A figure is labeled only when
	// nothing else identifies it — the gauge shape self-identifies, a bare
	// count does not (upstream abc0831).
	const statsLine = (u: UsageT | undefined, elapsedMs: number): string => {
		const parts: string[] = [];
		if (elapsedMs >= 0) parts.push(fmtDuration(elapsedMs));
		if (u && typeof u.contextTokens === "number") {
			if (typeof u.contextLimit === "number" && u.contextLimit > 0)
				parts.push(
					`${fmtTokens(u.contextTokens)} / ${fmtTokens(u.contextLimit)} (${Math.floor((u.contextTokens * 100) / u.contextLimit)}%)`,
				);
			else parts.push(`context ${fmtTokens(u.contextTokens)}`);
		}
		return parts.length > 0 ? `${DIM}${parts.join(" · ")}${RESET}` : "";
	};

	const renderToolStart = (name: string, args?: string) => {
		const tail = args ? ` · ${truncate(args)}` : "";
		writeContent(`\n${DIM}⏺ ${name}${tail}${RESET}`);
	};

	const renderToolFinish = (status: "ok" | "error", output?: string, isDiff?: boolean) => {
		if (isDiff && output) {
			for (const line of output.split("\n")) {
				if (line.length === 0) continue;
				const color = line.startsWith("+") ? GREEN : line.startsWith("-") ? RED : DIM;
				writeContent(`\n${color}${line}${RESET}`);
			}
			return;
		}
		const color = status === "error" ? RED : DIM;
		const lines = (output ?? "").split("\n").filter((l) => l.length > 0);
		if (lines.length === 0) {
			if (status === "error") writeContent(`\n${RED}  (error)${RESET}`);
			return;
		}
		for (const l of lines.slice(0, PREVIEW_LINES))
			writeContent(`\n${color}  ${truncate(l, 120)}${RESET}`);
		if (lines.length > PREVIEW_LINES)
			writeContent(`\n${DIM}  …(+${lines.length - PREVIEW_LINES})${RESET}`);
	};

	// Re-render a just-submitted operator line as hax's bright-magenta `▌ ` stripe
	// + magenta body, char-wrapping at every visual row. The line-buffered runtime
	// erases its plain echo first, then calls this. `cols` is the live tty width;
	// the ASCII fallback uses `|` so it never emits a stray box glyph on a non-UTF-8
	// terminal. Wrapping is by terminal CELL width (string-width: wide CJK/emoji = 2,
	// combining marks = 0) — matching how the terminal actually wraps — not by raw
	// code-point count, which would misplace continuation rows for non-ASCII input.
	// (This is char-wrap by cell width; hax's submitted_emit additionally does
	// word-wrap with a phantom-column rule, which is not reproduced here.)
	const echoUserInput = (text: string, cols: number): void => {
		const stripe = utf8 ? "▌ " : "| ";
		const width = Math.max(1, cols - STRIPE_COLS); // body cols after the stripe
		const cps = Array.from(text); // code points, so surrogate pairs stay intact
		const rows: string[] = [];
		let row = "";
		let used = 0; // cells consumed on the current row
		for (const cp of cps) {
			const w = stringWidth(cp);
			// Break before a glyph that would overflow the row — but never on an
			// empty row (a single glyph wider than the body still has to land).
			if (used + w > width && row !== "") {
				rows.push(row);
				row = "";
				used = 0;
			}
			row += cp;
			used += w;
		}
		if (row !== "" || rows.length === 0) rows.push(row);
		const block = rows.map((r) => `${BRIGHT_MAGENTA}${stripe}${r}${FG_DEFAULT}`).join("\n");
		writeContent(`${block}\n`);
	};

	// Total cell width of a string (wide CJK/emoji = 2, combining marks = 0).
	const cellWidth = (s: string): number => {
		let n = 0;
		for (const cp of s) n += stringWidth(cp);
		return n;
	};

	// Visual rows the plain keystroke echo of `❯ <text>` occupies at `cols`,
	// honoring embedded newlines (Alt+Enter): the prompt prefixes only the first
	// logical line; continuation lines start at column 0.
	const echoRows = (text: string, cols: number): number => {
		const width = Math.max(1, cols);
		let total = 0;
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const cells = (i === 0 ? PROMPT_CELLS : 0) + cellWidth(lines[i] ?? "");
			total += Math.max(1, Math.ceil(cells / width));
		}
		return total;
	};

	// On submit, erase the plain keystroke echo of the input line (prompt + typed
	// text, across wrap/continuation rows) and repaint it as the magenta ▌ block —
	// so every submitted line, command or prompt, reads as a hax-style user turn.
	// Cursor is assumed to sit at the end of the echoed text (the runtime suppresses
	// Enter's newline echo on submit). Reads the live tty width itself.
	const echoSubmittedInput = (text: string): void => {
		const cols = (input.stdout as NodeJS.WriteStream).columns ?? 80;
		const rows = echoRows(text, cols);
		let erase = CLEAR_LINE;
		for (let i = 1; i < rows; i++) erase += `${CURSOR_UP}${CLEAR_LINE}`;
		writeContent(erase);
		echoUserInput(text, cols);
	};

	// Draw a fresh input prompt on its own line. Used by the runtime after a
	// locally-handled slash command (no idle event follows to draw it).
	const renderPrompt = (): void => void writeContent(`\n${prompt}`);

	// Out-of-band host notice (e.g. subagent report lines) — routed through the
	// same guard as event content so it can never land on a live spinner row.
	// Callers pass newline-terminated lines; the string is written verbatim.
	const notify = (line: string): void => void writeContent(line);

	return {
		echoUserInput,
		echoSubmittedInput,
		renderPrompt,
		notify,
		handle(event: ProtocolEvent): void {
			model = model.reduce(event, nowFn());
			switch (event.type) {
				case "ready":
					// A fresh `ready` signals a new (or respawned) hax process. Reset the
					// one-shot banner flag so the next `status` event re-renders the banner
					// for the resumed session. In --mount-mode hax auto-emits `status` right
					// after `ready`, so the repaint is driven by the event stream — no
					// explicit call is needed in the runtime.
					bannerRendered = false;
					break;
				case "status":
					if (!bannerRendered) {
						renderBanner(event.provider, event.model, event.effort ?? "");
						bannerRendered = true;
					}
					break;
				case "user_turn_started":
					turnStartAt = nowFn();
					turnErrored = false;
					lastElapsedMs = -1;
					startSpinnerInterval();
					break;
				case "assistant_delta":
					// Suppressed from the pane — markdown renders at turn end. (The
					// live-session still forwards deltas to onProviderOutput.)
					break;
				case "tool_call_started":
					renderToolStart(event.name, event.args);
					break;
				case "tool_call_finished":
					renderToolFinish(event.status, event.output, event.isDiff);
					break;
				case "assistant_turn_finished":
					stopSpinnerInterval();
					lastUsage = event.usage;
					if (turnStartAt >= 0) lastElapsedMs = nowFn() - turnStartAt;
					turnStartAt = -1;
					if (event.content)
						writeContent(
							`\n${renderMarkdown(event.content, { width: (input.stdout as NodeJS.WriteStream).columns })}\n`,
						);
					break;
				case "idle":
					stopSpinnerInterval();
					if (!turnErrored && (lastUsage !== undefined || lastElapsedMs >= 0)) {
						const u = statsLine(lastUsage, lastElapsedMs);
						if (u) writeContent(`\n${u}`);
					}
					lastUsage = undefined;
					lastElapsedMs = -1;
					renderPrompt();
					break;
				case "error":
					stopSpinnerInterval();
					if (event.turnId) turnErrored = true;
					writeContent(`\n${RED}▌ ${event.message}${RESET}`);
					// A turn-scoped error (carries turnId) still drains to
					// assistant_turn_finished → idle, and idle draws the prompt — so
					// drawing one here too would double it. A non-turn / fatal error
					// has no following idle, so draw the prompt to keep the pane usable.
					if (!event.turnId) renderPrompt();
					break;
				default:
					break;
			}
		},
	};
}
