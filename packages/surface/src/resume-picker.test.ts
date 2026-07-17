import { describe, expect, it, vi } from "vitest";
import {
	applyKey,
	decodeChunk,
	formatRelativeTime,
	formatRow,
	parseSessions,
	renderView,
	runResumePicker,
	type PickerState,
	type SessionRow,
} from "./resume-picker.js";

const NOW = 1_000_000_000_000; // fixed "now" in ms for deterministic relative time
const nowSec = Math.floor(NOW / 1000);

function row(over: Partial<SessionRow> = {}): SessionRow {
	return { id: "id-x", mtime: nowSec, firstPrompt: "hello", ...over };
}

async function* chunks(items: string[]): AsyncGenerator<string> {
	for (const c of items) yield c;
}

describe("parseSessions", () => {
	it("parses a well-formed array", () => {
		const json = JSON.stringify([
			{ id: "a", mtime: 10, mtimeNsec: 1, firstPrompt: "first" },
			{ id: "b", mtime: 20, mtimeNsec: 2, firstPrompt: null },
		]);
		expect(parseSessions(json)).toEqual([
			{ id: "a", mtime: 10, firstPrompt: "first" },
			{ id: "b", mtime: 20, firstPrompt: null },
		]);
	});
	it("is tolerant: malformed JSON or a non-array yields no rows", () => {
		expect(parseSessions("not json")).toEqual([]);
		expect(parseSessions('{"id":"a"}')).toEqual([]);
		expect(parseSessions("")).toEqual([]);
	});
	it("drops entries without a usable string id (cannot be resumed)", () => {
		const json = JSON.stringify([
			{ id: "", mtime: 1 },
			{ mtime: 2 },
			{ id: 5, mtime: 3 },
			{ id: "ok", mtime: 4 },
		]);
		expect(parseSessions(json).map((r) => r.id)).toEqual(["ok"]);
	});
});

describe("formatRelativeTime", () => {
	it("buckets into just-now / minutes / hours / days", () => {
		expect(formatRelativeTime(nowSec, NOW)).toBe("just now");
		expect(formatRelativeTime(nowSec - 5 * 60, NOW)).toBe("5m ago");
		expect(formatRelativeTime(nowSec - 2 * 3600, NOW)).toBe("2h ago");
		expect(formatRelativeTime(nowSec - 3 * 86400, NOW)).toBe("3d ago");
	});
	it("never goes negative for a future mtime", () => {
		expect(formatRelativeTime(nowSec + 100, NOW)).toBe("just now");
	});
});

describe("formatRow", () => {
	it("shows age and prompt, collapsing whitespace", () => {
		expect(formatRow(row({ firstPrompt: "hello   world\n\tagain" }), NOW)).toBe(
			"just now · hello world again",
		);
	});
	it("falls back when there is no prompt", () => {
		expect(formatRow(row({ firstPrompt: null }), NOW)).toBe("just now · (no prompt)");
	});
	it("clamps a long prompt", () => {
		const long = "x".repeat(200);
		const out = formatRow(row({ firstPrompt: long }), NOW);
		expect(out.endsWith("…")).toBe(true);
		expect(out.length).toBeLessThan(90);
	});
});

describe("decodeChunk", () => {
	it("maps arrows (CSI + SS3) and vi keys", () => {
		expect(decodeChunk("\x1b[A")).toBe("up");
		expect(decodeChunk("\x1bOA")).toBe("up");
		expect(decodeChunk("k")).toBe("up");
		expect(decodeChunk("\x1b[B")).toBe("down");
		expect(decodeChunk("j")).toBe("down");
	});
	it("maps enter and cancels", () => {
		expect(decodeChunk("\r")).toBe("enter");
		expect(decodeChunk("\n")).toBe("enter");
		expect(decodeChunk("\x1b")).toBe("cancel"); // bare Esc, distinct from an arrow
		expect(decodeChunk("\x03")).toBe("cancel"); // Ctrl-C
		expect(decodeChunk("\x04")).toBe("cancel"); // Ctrl-D
		expect(decodeChunk("q")).toBe("cancel");
	});
	it("maps the pagination keys (whole one-byte chunks; no CSI collision)", () => {
		expect(decodeChunk("[")).toBe("pageprev"); // bare '[', not the start of "\x1b[A"
		expect(decodeChunk("]")).toBe("pagenext");
		expect(decodeChunk("\x01")).toBe("toggleall"); // Ctrl+A
	});
	it("maps PageUp/PageDown CSI sequences to page tokens", () => {
		expect(decodeChunk("\x1b[5~")).toBe("pageprev");
		expect(decodeChunk("\x1b[6~")).toBe("pagenext");
	});

	it("falls through to other (digit-jump removed)", () => {
		expect(decodeChunk("3")).toBe("other");
		expect(decodeChunk("z")).toBe("other");
	});
});

describe("applyKey (hard pages)", () => {
	// 40 rows, 15/page → pages 0..2 (rows 0-14, 15-29, 30-39).
	const st = (index: number, showAll = false): PickerState => ({
		index,
		count: 40,
		pageSize: 15,
		showAll,
	});

	it("up/down clamp WITHIN the current page", () => {
		expect(applyKey(st(0), "up").index).toBe(0); // page top
		expect(applyKey(st(5), "up").index).toBe(4);
		expect(applyKey(st(5), "down").index).toBe(6);
		expect(applyKey(st(14), "down").index).toBe(14); // page bottom — does NOT spill to 15
		expect(applyKey(st(15), "up").index).toBe(15); // top of page 1 — does NOT spill to 14
	});

	it("[ / ] jump to the first row of the prev/next page, and no-op at the ends", () => {
		expect(applyKey(st(0), "pagenext").index).toBe(15); // page 0 → page 1
		expect(applyKey(st(14), "pagenext").index).toBe(15);
		expect(applyKey(st(15), "pageprev").index).toBe(0); // page 1 → page 0
		expect(applyKey(st(0), "pageprev").index).toBe(0); // already first page → no-op
		expect(applyKey(st(30), "pagenext").index).toBe(30); // last page → no-op
	});

	it("Ctrl+A toggles showAll and preserves the cursor", () => {
		expect(applyKey(st(20), "toggleall")).toEqual({ index: 20, showAll: true });
		expect(applyKey(st(20, true), "toggleall")).toEqual({ index: 20, showAll: false });
	});

	it("in showAll, up/down span the whole list and [ / ] are inert", () => {
		expect(applyKey(st(15, true), "up").index).toBe(14); // crosses the page boundary
		expect(applyKey(st(39, true), "down").index).toBe(39); // clamp at count-1
		expect(applyKey(st(0, true), "down").index).toBe(1);
		expect(applyKey(st(5, true), "pagenext").index).toBe(5); // inert
		expect(applyKey(st(20, true), "pageprev").index).toBe(20); // inert
	});

	it("selects and cancels (carrying showAll)", () => {
		expect(applyKey(st(1), "enter")).toEqual({ index: 1, showAll: false, done: "select" });
		expect(applyKey(st(1), "cancel")).toEqual({ index: 1, showAll: false, done: "cancel" });
	});
});

describe("renderView", () => {
	const rows = (n: number): SessionRow[] =>
		Array.from({ length: n }, (_, i) => row({ id: `id-${i}`, firstPrompt: `prompt ${i}` }));
	const state = (over: Partial<PickerState>): PickerState => ({
		index: 0,
		count: 0,
		pageSize: 15,
		showAll: false,
		...over,
	});

	it("paged: header shows page X/Y · N, renders only the page slice with GLOBAL numbers", () => {
		const r = rows(40);
		const view = renderView(r, state({ index: 20, count: 40 }), NOW); // index 20 → page 1 (rows 15-29)
		expect(view).toContain("page 2/3 · 40 sessions");
		expect(view).toContain("16. "); // global number of the first row on page 1
		expect(view).toContain("30. "); // last row on page 1
		expect(view).not.toContain("31. "); // page 2's rows are not rendered
		expect(view).not.toContain(" 1. "); // page 0's rows are not rendered
		expect(view).toContain("[ ]/PgUp/PgDn page");
		// cursor (❯) sits on the row matching state.index (index 20 → global row 21), nowhere
		// else. oneLine renders the cursor as "\x1b[36m❯\x1b[0m", so the raw text is
		// "❯\x1b[0m 21." — strip the SGR color codes first, then assert on plain text.
		const plain = view.replace(/\x1b\[[0-9;]*m/g, "");
		expect((plain.match(/❯/g) ?? []).length).toBe(1);
		expect(plain).toMatch(/❯ 21\. /); // highlighted row tracks the index
		expect(plain).not.toMatch(/❯ 16\. /); // not stuck on the first visible row
	});

	it("single page (<=15): no page indicator, no [ ] hint", () => {
		const view = renderView(rows(3), state({ count: 3 }), NOW);
		expect(view).toContain("(3 sessions)");
		expect(view).not.toContain("page 1/1");
		expect(view).not.toContain("[ ] page");
	});

	it("showAll: renders every row + the 'Ctrl+A pages' footer", () => {
		const view = renderView(rows(40), state({ count: 40, showAll: true }), NOW);
		expect(view).toContain("showing all 40 sessions");
		expect(view).toContain("1. ");
		expect(view).toContain("40. ");
		expect(view).toContain("Ctrl+A pages");
	});

	it("a full page frame is header + 15 rows + footer = 17 newlines (drives the redraw climb)", () => {
		const view = renderView(rows(40), state({ count: 40 }), NOW);
		expect((view.match(/\n/g) ?? []).length).toBe(17);
	});

	it("names the PgUp/PgDn aliases in the paged hint", () => {
		const rows = Array.from({ length: 25 }, (_, i) => ({
			id: `s${i}`,
			mtime: 1_784_000_000,
			firstPrompt: `p${i}`,
		}));
		const view = renderView(
			rows,
			{ index: 0, count: 25, pageSize: 10, showAll: false },
			1_784_000_500_000,
		);
		expect(view).toContain("[ ]/PgUp/PgDn page");
	});
});

describe("runResumePicker", () => {
	function deps(json: string, keys: string[]) {
		const setRawMode = vi.fn();
		const writes: string[] = [];
		return {
			listSessions: () => Promise.resolve(json),
			keys: chunks(keys),
			write: (s: string) => void writes.push(s),
			now: () => NOW,
			setRawMode,
			writes,
		};
	}
	const manyJson = (n: number) =>
		JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, mtime: nowSec })));
	const three = JSON.stringify([
		{ id: "a", mtime: nowSec },
		{ id: "b", mtime: nowSec },
		{ id: "c", mtime: nowSec },
	]);

	it("returns undefined and never enters raw mode when there are no sessions", async () => {
		const d = deps("[]", []);
		expect(await runResumePicker(d)).toBeUndefined();
		expect(d.setRawMode).not.toHaveBeenCalled();
	});

	it("navigates down then selects the highlighted session", async () => {
		const d = deps(three, ["\x1b[B", "\r"]); // down, enter → row 2 = "b"
		expect(await runResumePicker(d)).toBe("b");
	});

	it("pages with ] twice then selects a row on page 3 (id-30)", async () => {
		const d = deps(manyJson(40), ["]", "]", "\r"]); // page 0 → 1 → 2; cursor at index 30
		expect(await runResumePicker(d)).toBe("id-30");
	});

	it("[ pages back; ] then [ returns to id-0", async () => {
		const d = deps(manyJson(40), ["]", "[", "\r"]); // → index 15 → back to index 0
		expect(await runResumePicker(d)).toBe("id-0");
	});

	it("Ctrl+A show-all lets ↓ cross a page boundary, then selects", async () => {
		// 20 rows: paged, ↓ would clamp at index 14. Ctrl+A → ↓ from 14 reaches 15.
		const keys = Array(14).fill("\x1b[B"); // down to index 14 (page bottom)
		const d = deps(manyJson(20), [...keys, "\x01", "\x1b[B", "\r"]); // toggle all, ↓ → 15, enter
		expect(await runResumePicker(d)).toBe("id-15");
	});

	it("cancels on Esc, returning undefined", async () => {
		expect(await runResumePicker(deps(three, ["\x1b"]))).toBeUndefined();
	});

	it("redraw climbs the PRIOR frame's line count across a height change (page → short last page)", async () => {
		// 16 rows: page 0 has 15 rows (full), page 1 has 1 row (short). Paging to page 1
		// must climb 17 (page 0's header+15+footer), the previous frame's height.
		const d = deps(manyJson(16), ["]", "\r"]);
		await runResumePicker(d);
		const joined = d.writes.join("");
		expect(joined).toContain("\x1b[17A"); // climbed the full page-0 frame before drawing page 1
	});

	it("redraw climbs the prior frame's line count across a show-all toggle (both directions)", async () => {
		// 20 rows: paged frame = header + 15 + footer = 17 lines; show-all = header + 20 +
		// footer = 22 lines. Ctrl+A draws show-all AFTER climbing the prior paged frame (17);
		// a second Ctrl+A draws paged AFTER climbing the prior show-all frame (22).
		const d = deps(manyJson(20), ["\x01", "\x01", "\r"]);
		await runResumePicker(d);
		const joined = d.writes.join("");
		expect(joined).toContain("\x1b[17A"); // page → show-all: climbed the paged frame
		expect(joined).toContain("\x1b[22A"); // show-all → page: climbed the show-all frame
	});

	it("enters then restores raw mode", async () => {
		const d = deps(three, ["\r"]);
		await runResumePicker(d);
		expect(d.setRawMode).toHaveBeenNthCalledWith(1, true);
		expect(d.setRawMode).toHaveBeenLastCalledWith(false);
	});
});

describe("title merge", () => {
	const row = (id: string, firstPrompt: string | null): SessionRow => ({
		id,
		mtime: 0,
		firstPrompt,
	});
	it("prefers a title over firstPrompt, falls back to (no prompt)", () => {
		expect(formatRow(row("a", "first prompt text"), 0, "my title")).toContain("my title");
		expect(formatRow(row("b", "first prompt text"), 0, undefined)).toContain("first prompt text");
		expect(formatRow(row("c", null), 0, undefined)).toContain("(no prompt)");
	});
});
