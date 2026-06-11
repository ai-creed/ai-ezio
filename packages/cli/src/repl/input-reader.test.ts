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

describe("Ctrl+T transcript signal", () => {
	it("Ctrl+T (0x14) signals transcript", () => {
		expect(feedKey(newLineBuffer(), "\x14").signal).toBe("transcript");
	});

	it("Ctrl+T does not submit and preserves the in-progress buffer", () => {
		let b = newLineBuffer();
		for (const ch of "draft") b = feedKey(b, ch).buffer;
		const r = feedKey(b, "\x14");
		expect(r.signal).toBe("transcript");
		expect(r.submit).toBeUndefined();
		expect(r.buffer.text).toBe("draft");
	});

	it("Ctrl+T inside a bracketed paste is dropped, not a signal", () => {
		let b = newLineBuffer();
		for (const ch of "\x1b[200~") b = feedKey(b, ch).buffer; // paste-start
		const r = feedKey(b, "\x14");
		expect(r.signal).toBeUndefined();
		expect(r.buffer.text).toBe("");
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

describe("kitty keyboard protocol: modified Enter", () => {
	const SHIFT_ENTER = "\x1b[13;2u";
	const CTRL_ENTER = "\x1b[13;5u";

	it("Shift+Enter (CSI 13;2u) inserts a newline instead of submitting", () => {
		let b = newLineBuffer();
		for (const ch of "foo") b = feedKey(b, ch).buffer;
		b = feedAll(b, SHIFT_ENTER);
		expect(b.text).toBe("foo\n");
		// a plain Enter afterwards submits the whole multiline buffer
		expect(feedKey(b, "\r").submit).toBe("foo\n");
	});

	it("accumulates the CSI-u sequence byte-by-byte without submitting or echoing junk", () => {
		let b = newLineBuffer();
		for (const ch of "hi") b = feedKey(b, ch).buffer;
		for (const ch of "\x1b[13;2") {
			const r = feedKey(b, ch);
			expect(r.submit).toBeUndefined();
			expect(r.echo).toBeUndefined(); // partial sequence: nothing echoed yet
			b = r.buffer;
		}
		const done = feedKey(b, "u");
		expect(done.submit).toBeUndefined();
		expect(done.buffer.text).toBe("hi\n");
		expect(done.echo).toBe("\r\n");
	});

	it("Ctrl+Enter (CSI 13;5u) also inserts a newline", () => {
		const b = feedAll(newLineBuffer(), CTRL_ENTER);
		expect(b.text).toBe("\n");
	});

	it("plain Enter still submits (a bare CR is unaffected by the protocol)", () => {
		let b = newLineBuffer();
		for (const ch of "bar") b = feedKey(b, ch).buffer;
		expect(feedKey(b, "\r").submit).toBe("bar");
	});

	it("drops an unrelated CSI sequence (e.g. an arrow key) without submitting", () => {
		let b = newLineBuffer();
		for (const ch of "x") b = feedKey(b, ch).buffer;
		const after = feedAll(b, "\x1b[D"); // left arrow — a complete CSI, not Enter
		expect(after.text).toBe("x"); // unchanged; the sequence was dropped
		expect(feedKey(after, "\r").submit).toBe("x");
	});

	it("ignores an unmodified CSI-u Enter (mods=1) rather than inserting a newline", () => {
		// ESC[13;1u = Enter with no modifiers (only seen in report-all mode). It must
		// NOT become a newline — that would break submit — so it is dropped here.
		const b = feedAll(newLineBuffer(), "\x1b[13;1u");
		expect(b.text).toBe("");
	});
});
