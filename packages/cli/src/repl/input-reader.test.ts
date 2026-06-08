import { describe, expect, it } from "vitest";
import { feedKey, newLineBuffer } from "./input-reader.js";

describe("line buffer", () => {
	it("accumulates printable chars and submits on Enter", () => {
		let b = newLineBuffer();
		for (const ch of "hello") b = feedKey(b, ch).buffer;
		const out = feedKey(b, "\r");
		expect(out.submit).toBe("hello");
		expect(out.buffer.text).toBe("");
	});
	it("backspace removes the last char", () => {
		let b = newLineBuffer();
		for (const ch of "abc") b = feedKey(b, ch).buffer;
		b = feedKey(b, "\x7f").buffer;
		expect(b.text).toBe("ab");
	});
	it("Ctrl-C signals interrupt, Ctrl-D signals eof", () => {
		expect(feedKey(newLineBuffer(), "\x03").signal).toBe("interrupt");
		expect(feedKey(newLineBuffer(), "\x04").signal).toBe("eof");
	});
});
