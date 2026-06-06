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
