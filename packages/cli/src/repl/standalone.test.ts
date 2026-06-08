import { describe, expect, it } from "vitest";
import { runStandaloneRepl } from "./standalone.js";
import type { SlashOutcome } from "./slash.js";

/** A fake slash controller: each entry in `outcomes` is matched by submitted
 * line; default is to submit the line verbatim. */
function fakeSlash(
	map: (line: string) => SlashOutcome = (line) => ({ action: "submit", text: line }),
) {
	const seen: string[] = [];
	return {
		seen,
		handle: async (line: string) => {
			seen.push(line);
			return map(line);
		},
	};
}

describe("runStandaloneRepl", () => {
	it("submits a typed line, waits for idle, and exits on Ctrl-D", async () => {
		const submitted: string[] = [];
		const waited: string[] = [];
		async function* keys() {
			for (const k of ["h", "i", "\r", "\x04"]) yield k;
		}
		const session = {
			submit: (t: string) => submitted.push(t),
			interrupt: () => {},
			waitForEvent: async (e: string) => {
				waited.push(e);
				return { type: "idle" } as never;
			},
			close: () => {},
		};
		let stopped = false;
		await runStandaloneRepl({
			keys: keys(),
			session: session as never,
			host: { handleEvent: async () => {}, stop: async () => void (stopped = true) } as never,
			write: () => {},
			slash: fakeSlash(),
		});
		expect(submitted).toEqual(["hi"]);
		expect(waited).toEqual(["idle"]);
		expect(stopped).toBe(true);
	});

	it("Ctrl-C interrupts without submitting", async () => {
		const calls: string[] = [];
		async function* keys() {
			for (const k of ["x", "\x03", "\x04"]) yield k;
		}
		const session = {
			submit: () => calls.push("submit"),
			interrupt: () => calls.push("interrupt"),
			waitForEvent: async () => ({ type: "idle" }) as never,
			close: () => {},
		};
		await runStandaloneRepl({
			keys: keys(),
			session: session as never,
			host: { handleEvent: async () => {}, stop: async () => {} } as never,
			write: () => {},
			slash: fakeSlash(),
		});
		expect(calls).toEqual(["interrupt"]);
	});

	it("a 'handled' outcome does NOT submit or wait (slash-command hang guard)", async () => {
		const calls: string[] = [];
		async function* keys() {
			// type "/help", Enter, then Ctrl-D
			for (const k of ["/", "h", "e", "l", "p", "\r", "\x04"]) yield k;
		}
		const session = {
			submit: () => calls.push("submit"),
			interrupt: () => {},
			waitForEvent: async () => {
				calls.push("wait");
				return { type: "idle" } as never;
			},
			close: () => {},
		};
		await runStandaloneRepl({
			keys: keys(),
			session: session as never,
			host: { handleEvent: async () => {}, stop: async () => {} } as never,
			write: () => {},
			slash: fakeSlash(() => ({ action: "handled" })),
		});
		expect(calls).toEqual([]); // never submitted, never waited
	});

	it("an 'exit' outcome stops the loop immediately", async () => {
		const calls: string[] = [];
		async function* keys() {
			for (const k of ["/", "q", "\r", "x", "\x04"]) yield k; // x/Ctrl-D after exit must not run
		}
		const session = {
			submit: () => calls.push("submit"),
			interrupt: () => {},
			waitForEvent: async () => ({ type: "idle" }) as never,
			close: () => calls.push("close"),
		};
		await runStandaloneRepl({
			keys: keys(),
			session: session as never,
			host: { handleEvent: async () => {}, stop: async () => {} } as never,
			write: () => {},
			slash: fakeSlash(() => ({ action: "exit" })),
		});
		expect(calls).toContain("close");
		expect(calls).not.toContain("submit");
	});
});
