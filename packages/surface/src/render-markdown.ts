/**
 * Robust markdown → ANSI renderer for the mounted ezio pane and the future
 * standalone `ezio --rich`. Renders the FINAL assistant text through marked +
 * marked-terminal, so all CommonMark/GFM is covered: tables (bordered via
 * cli-table3), nested lists, fenced code, blockquotes, links. Malformed input
 * degrades to plain text rather than throwing.
 *
 * Width-aware: prose reflows to the pane width, and tables are fit to it by a
 * custom renderer (marked-terminal's own table renderer ignores width and lets
 * cli-table3 expand columns to the longest cell, overflowing the pane). Trailing
 * blank lines are trimmed so block spacing stays tight.
 */
import CliTable from "cli-table3";
import { Marked, type Token, type Tokens } from "marked";
import { markedTerminal } from "marked-terminal";
import stringWidth from "string-width";
import { BOLD, BRIGHT_MAGENTA, CYAN, DIM, RESET } from "./style.js";

/** cli-table3 default cell padding (1 left + 1 right). A colWidth includes it. */
const CELL_PAD = 2;
/** Smallest usable cell: 1 content column + padding. */
const MIN_CELL = 1 + CELL_PAD;

/**
 * Distribute `width` across `n` columns by content-proportional fair allocation:
 * columns that fit their equal share keep their natural width; the remaining
 * (wide) columns split what's left in proportion to their content. Returns
 * cli-table3 `colWidths` (each includes CELL_PAD). So a tight "Result: Pass"
 * column stays narrow while a long "Evidence" column absorbs the slack and wraps.
 */
function fitColWidths(natural: number[], width: number): number[] {
	const n = natural.length;
	const cell = natural.map((w) => Math.max(1, w) + CELL_PAD); // natural cell widths
	const available = Math.max(n * MIN_CELL, width - (n + 1)); // budget minus vertical borders
	if (cell.reduce((a, b) => a + b, 0) <= available) return cell; // already fits → no shrink

	const result = new Array<number>(n).fill(-1);
	let remaining = available;
	let large = cell.map((_, i) => i);
	// Peel off columns that fit an equal share of what's left; repeat because each
	// removal raises the share for the rest.
	for (let changed = true; changed && large.length > 0; ) {
		changed = false;
		const share = Math.floor(remaining / large.length);
		for (const i of [...large]) {
			if (cell[i]! <= share) {
				result[i] = cell[i]!;
				remaining -= cell[i]!;
				large = large.filter((j) => j !== i);
				changed = true;
			}
		}
	}
	// Split the remainder among the wide columns, proportional to their content.
	if (large.length > 0) {
		const sum = large.reduce((a, i) => a + cell[i]!, 0);
		for (const i of large) result[i] = Math.max(MIN_CELL, Math.floor((remaining * cell[i]!) / sum));
		const widest = large.reduce((a, i) => (cell[i]! > cell[a]! ? i : a), large[0]!);
		const drift = available - result.reduce((a, b) => a + b, 0); // absorb rounding
		result[widest] = Math.max(MIN_CELL, result[widest]! + drift);
	}
	return result;
}

function mapAlign(align: "center" | "left" | "right" | null): "center" | "left" | "right" {
	if (align === "center") return "center";
	if (align === "right") return "right";
	return "left";
}

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

	// Override marked-terminal's table renderer with one that fits the pane width.
	// marked-terminal lets cli-table3 size columns to content, so a wide table
	// overflows; here we parse each cell's inline markdown, measure content, and
	// compute colWidths (content-proportional) with wordWrap so the table wraps to
	// `width` instead of running off-screen.
	marked.use({
		renderer: {
			// marked@15 hands a tight list item's content to the `text` renderer as a
			// block token whose inline children live in `.tokens`; marked-terminal@7
			// emits the raw `.text`, so code/bold/links/em inside list items leaked as
			// literal markdown (its `heading` parses inline correctly, but `text` was
			// never updated for marked@15). Inline-parse when the token carries
			// children; a leaf text token (no `.tokens`) passes through unchanged.
			text(
				this: { parser: { parseInline: (tokens: Token[]) => string } },
				token: Tokens.Text | Tokens.Escape,
			) {
				// `escape` tokens (e.g. `\*`) carry no children — pass their text through.
				return "tokens" in token && token.tokens
					? this.parser.parseInline(token.tokens)
					: token.text;
			},
			table(this: { parser: { parseInline: (tokens: Token[]) => string } }, token: Tokens.Table) {
				const parse = (cell: Tokens.TableCell) => this.parser.parseInline(cell.tokens);
				const headerCells = token.header.map((c) => `${BOLD}${parse(c)}${RESET}`);
				const bodyRows = token.rows.map((row) => row.map(parse));

				const ncols = token.header.length;
				const natural = new Array<number>(ncols).fill(0);
				const measure = (cells: string[]) =>
					cells.forEach((cell, i) => {
						natural[i] = Math.max(natural[i]!, stringWidth(cell)); // string-width ignores ANSI
					});
				measure(headerCells);
				bodyRows.forEach(measure);

				const table = new CliTable({
					head: headerCells,
					colWidths: fitColWidths(natural, width),
					colAligns: token.header.map((c) => mapAlign(c.align)),
					wordWrap: true,
					wrapOnWordBoundary: true,
					style: { head: [], border: [] }, // no cli-table3 default colors; ezio styles cells itself
				});
				bodyRows.forEach((row) => table.push(row));
				return `\n${table.toString()}\n`;
			},
		},
	});

	let out: string;
	try {
		out = marked.parse(md, { async: false });
	} catch {
		// Robust by construction: never throw on malformed input.
		return md;
	}
	// Trim trailing blank lines so block spacing stays tight (M8 tidiness).
	return out.replace(/\n+$/u, "");
}
