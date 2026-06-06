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
	// The options object IS type-checked against @types/marked-terminal's
	// TerminalRendererOptions (so the palette callbacks below are validated). Only
	// the RETURN type lags: @types/marked-terminal@6 is written for an older
	// `MarkedExtension` shape than marked@15 exposes, so `marked.use()` rejects it
	// (TS2559). Cast just the return at this seam — the smallest erosion that keeps
	// the build green without dropping option typing (the spec's typing-strategy
	// fallback for "community types lag marked@^15").
	const extension = markedTerminal({
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
	}) as unknown as Parameters<typeof marked.use>[0];
	marked.use(extension);
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
