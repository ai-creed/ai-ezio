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

/** Feed every code point of `s` through feedKey, returning the final buffer. */
function feedAll(b: ReturnType<typeof newLineBuffer>, s: string) {
	for (const ch of s) b = feedKey(b, ch).buffer;
	return b;
}

describe("multiline: Alt+Enter", () => {
	it("Alt+Enter (ESC then CR) inserts a newline instead of submitting", () => {
		let b = newLineBuffer();
		for (const ch of "foo") b = feedKey(b, ch).buffer;
		const esc = feedKey(b, "\x1b");
		expect(esc.submit).toBeUndefined();
		expect(esc.echo).toBeUndefined(); // partial sequence: nothing echoed yet
		const nl = feedKey(esc.buffer, "\r");
		expect(nl.submit).toBeUndefined(); // newline, NOT submit
		expect(nl.buffer.text).toBe("foo\n");
		expect(nl.echo).toBe("\r\n");
		// keep typing on the next line, then a bare Enter submits the whole thing
		let b2 = nl.buffer;
		for (const ch of "bar") b2 = feedKey(b2, ch).buffer;
		expect(feedKey(b2, "\r").submit).toBe("foo\nbar");
	});

	it("Alt+Enter via ESC then LF also inserts a newline", () => {
		const esc = feedKey(newLineBuffer(), "\x1b");
		const nl = feedKey(esc.buffer, "\n");
		expect(nl.submit).toBeUndefined();
		expect(nl.buffer.text).toBe("\n");
	});

	it("drops an unrecognized escape sequence outside a paste", () => {
		const esc = feedKey(newLineBuffer(), "\x1b");
		const after = feedKey(esc.buffer, "z"); // ESC z — not a sequence we handle
		expect(after.submit).toBeUndefined();
		expect(after.buffer.text).toBe("");
	});
});

describe("bracketed paste", () => {
	const PASTE_START = "\x1b[200~";
	const PASTE_END = "\x1b[201~";

	it("buffers a multiline paste; embedded newlines are literal, no submit", () => {
		let b = newLineBuffer();
		b = feedAll(b, PASTE_START);
		expect(b.pasting).toBe(true);
		b = feedAll(b, "line1\nline2");
		b = feedAll(b, PASTE_END);
		expect(b.pasting).toBe(false);
		expect(b.text).toBe("line1\nline2");
		// only a real Enter after the paste submits the whole block
		expect(feedKey(b, "\r").submit).toBe("line1\nline2");
	});

	it("an embedded newline mid-paste does not submit", () => {
		let b = newLineBuffer();
		b = feedAll(b, PASTE_START);
		const r = feedKey(b, "\n");
		expect(r.submit).toBeUndefined();
		expect(r.buffer.text).toBe("\n");
	});

	it("paste start/end markers leave no stray text in the buffer", () => {
		let b = newLineBuffer();
		b = feedAll(b, PASTE_START);
		expect(b.text).toBe(""); // the 6-byte marker is consumed, not echoed as text
		b = feedAll(b, "x");
		b = feedAll(b, PASTE_END);
		expect(b.text).toBe("x");
	});
});
