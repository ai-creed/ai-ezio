import { describe, expect, it, vi } from "vitest";
import {
	applyKey,
	decodeChunk,
	formatRelativeTime,
	formatRow,
	parseSessions,
	renderFrame,
	runResumePicker,
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
	it("maps enter, cancels, digits, and other", () => {
		expect(decodeChunk("\r")).toBe("enter");
		expect(decodeChunk("\n")).toBe("enter");
		expect(decodeChunk("\x1b")).toBe("cancel"); // bare Esc, distinct from an arrow
		expect(decodeChunk("\x03")).toBe("cancel"); // Ctrl-C
		expect(decodeChunk("\x04")).toBe("cancel"); // Ctrl-D
		expect(decodeChunk("q")).toBe("cancel");
		expect(decodeChunk("3")).toEqual({ digit: 3 });
		expect(decodeChunk("z")).toBe("other");
	});
});

describe("applyKey", () => {
	const st = { index: 1, count: 3 };
	it("moves and clamps", () => {
		expect(applyKey({ index: 0, count: 3 }, "up").index).toBe(0); // clamp top
		expect(applyKey(st, "up").index).toBe(0);
		expect(applyKey(st, "down").index).toBe(2);
		expect(applyKey({ index: 2, count: 3 }, "down").index).toBe(2); // clamp bottom
	});
	it("selects and cancels", () => {
		expect(applyKey(st, "enter")).toEqual({ index: 1, done: "select" });
		expect(applyKey(st, "cancel")).toEqual({ index: 1, done: "cancel" });
	});
	it("digit jumps only when in range", () => {
		expect(applyKey(st, { digit: 3 }).index).toBe(2);
		expect(applyKey(st, { digit: 9 }).index).toBe(1); // out of range → unchanged
	});
});

describe("renderFrame", () => {
	const rows = [row({ id: "a", firstPrompt: "first" }), row({ id: "b", firstPrompt: "second" })];
	it("includes the title and every row's preview", () => {
		const frame = renderFrame(rows, 0, NOW, false);
		expect(frame).toContain("Resume a session");
		expect(frame).toContain("first");
		expect(frame).toContain("second");
	});
	it("prepends a cursor-up + clear on a redraw (overwrite in place)", () => {
		expect(renderFrame(rows, 0, NOW, false).startsWith("\x1b[")).toBe(false);
		// title + 2 rows = move up 3 lines
		expect(renderFrame(rows, 0, NOW, true)).toContain("\x1b[3A");
	});
});

describe("runResumePicker", () => {
	function deps(json: string, keys: string[]) {
		const setRawMode = vi.fn();
		return {
			listSessions: () => Promise.resolve(json),
			keys: chunks(keys),
			write: vi.fn(),
			now: () => NOW,
			setRawMode,
		};
	}
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

	it("supports digit jump then enter", async () => {
		const d = deps(three, ["3", "\r"]); // jump to row 3 = "c"
		expect(await runResumePicker(d)).toBe("c");
	});

	it("cancels on Esc, returning undefined", async () => {
		expect(await runResumePicker(deps(three, ["\x1b"]))).toBeUndefined();
	});

	it("returns undefined when the input stream ends without a choice", async () => {
		expect(await runResumePicker(deps(three, ["\x1b[B"]))).toBeUndefined();
	});

	it("enters then restores raw mode", async () => {
		const d = deps(three, ["\r"]);
		await runResumePicker(d);
		expect(d.setRawMode).toHaveBeenNthCalledWith(1, true);
		expect(d.setRawMode).toHaveBeenLastCalledWith(false);
	});
});
