import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { makeClipboard } from "./clipboard.js";

/** A fake child process whose `close` we drive, capturing what was written. */
function fakeChild(exitCode: number) {
	const child = new EventEmitter() as EventEmitter & {
		stdin: { end: (s: string) => void };
		written: string;
	};
	child.written = "";
	child.stdin = { end: (s: string) => void (child.written = s) };
	// Emit close on the next microtask so the listener is attached first.
	queueMicrotask(() => child.emit("close", exitCode));
	return child;
}

describe("makeClipboard", () => {
	it("darwin uses pbcopy and writes the text to stdin", async () => {
		const argvs: string[][] = [];
		let captured = "";
		const spawnFn = ((cmd: string, args: string[]) => {
			argvs.push([cmd, ...args]);
			const c = fakeChild(0);
			const origEnd = c.stdin.end;
			c.stdin.end = (s: string) => {
				captured = s;
				origEnd(s);
			};
			return c;
		}) as never;
		const copy = makeClipboard("darwin", spawnFn);
		await copy("hello");
		expect(argvs).toEqual([["pbcopy"]]);
		expect(captured).toBe("hello");
	});

	it("linux tries full wl-copy argv first, falls back to full xclip argv on spawn error", async () => {
		const argvs: string[][] = [];
		const spawnFn = ((cmd: string, args: string[]) => {
			argvs.push([cmd, ...args]);
			if (cmd === "wl-copy") {
				const c = new EventEmitter() as never as ReturnType<typeof fakeChild>;
				(c as unknown as { stdin: { end: () => void } }).stdin = { end: () => {} };
				queueMicrotask(() => (c as unknown as EventEmitter).emit("error", new Error("ENOENT")));
				return c;
			}
			return fakeChild(0);
		}) as never;
		const copy = makeClipboard("linux", spawnFn);
		await copy("x");
		// Assert the COMPLETE argv of each candidate, not just the command name, so a
		// regression that drops `-selection clipboard` from xclip is caught.
		expect(argvs).toEqual([["wl-copy"], ["xclip", "-selection", "clipboard"]]);
	});

	it("rejects when every candidate fails", async () => {
		const spawnFn = (() => {
			const c = new EventEmitter() as never as { stdin: { end: () => void } } & EventEmitter;
			(c as unknown as { stdin: { end: () => void } }).stdin = { end: () => {} };
			queueMicrotask(() => (c as unknown as EventEmitter).emit("error", new Error("ENOENT")));
			return c;
		}) as never;
		const copy = makeClipboard("linux", spawnFn);
		await expect(copy("x")).rejects.toThrow();
	});

	it("rejects when the tool exits non-zero", async () => {
		const spawnFn = (() => fakeChild(1)) as never;
		const copy = makeClipboard("darwin", spawnFn);
		await expect(copy("x")).rejects.toThrow(/exited 1/);
	});
});
