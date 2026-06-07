import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./render-markdown.js";

const stripAnsi = (s: string) => s.replace(/\[[0-9;]*m/g, "");
const maxLineWidth = (s: string) => Math.max(...s.split("\n").map((l) => stripAnsi(l).length));

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

	it("fits a wide table to the pane width by wrapping cells (no overflow)", () => {
		const md = [
			"| Requirement | Evidence | Result |",
			"| --- | --- | --- |",
			"| Plan extracts the renderers into the surface package without reversing deps | Spec lines 8-15, 25-30, 68-81 place the package in ai-ezio and keep the dependency direction correct | Pass |",
		].join("\n");
		const out = renderMarkdown(md, { width: 80 });
		// THE bug: cli-table3 expanded columns to content (~229 cols) ignoring width.
		expect(maxLineWidth(out)).toBeLessThanOrEqual(80);
		// content survives the wrap (text is split across lines, so check fragments)
		expect(stripAnsi(out)).toContain("Requirement");
		expect(stripAnsi(out)).toContain("Pass");
		expect(stripAnsi(out)).toContain("ai-ezio");
		// still a bordered grid
		expect(/[│┌─]/u.test(out)).toBe(true);
		// the long row actually wrapped onto multiple visual lines
		expect(out.split("\n").length).toBeGreaterThan(4);
	});

	it("sizes columns content-proportionally — a narrow column stays narrow", () => {
		const md = [
			"| Evidence | R |",
			"| --- | --- |",
			"| a very long evidence string that needs most of the available width to render | X |",
		].join("\n");
		const out = renderMarkdown(md, { width: 60 });
		expect(maxLineWidth(out)).toBeLessThanOrEqual(60);
		// measure the two column segments from the top border: ┌──────┬───┐
		const border = stripAnsi(out.split("\n").find((l) => l.includes("┌")) ?? "");
		const segs = border
			.slice(1, -1)
			.split("┬")
			.map((s) => s.length);
		expect(segs.length).toBe(2);
		// the "R"/"X" column is far narrower than the evidence column
		expect(segs[1]).toBeLessThan(segs[0]);
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
		expect(() =>
			renderMarkdown("| broken | table\n no pipes here **unclosed", { width: 80 }),
		).not.toThrow();
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
