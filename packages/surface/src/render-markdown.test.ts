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
