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

/** Records the surface seams the REPL drives (magenta re-echo + prompt draws). */
function fakeSurface() {
	const echoed: string[] = [];
	let prompts = 0;
	return {
		echoed,
		prompts: () => prompts,
		echoSubmittedInput: (t: string) => void echoed.push(t),
		renderPrompt: () => void prompts++,
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
		const surface = fakeSurface();
		await runStandaloneRepl({
			keys: keys(),
			session: session as never,
			host: { handleEvent: async () => {}, stop: async () => void (stopped = true) } as never,
			write: () => {},
			slash: fakeSlash(),
			...surface,
		});
		expect(submitted).toEqual(["hi"]);
		expect(waited).toEqual(["idle"]);
		// The submitted line is repainted as the magenta user-turn block; the surface
		// draws the next prompt on idle (not the REPL).
		expect(surface.echoed).toEqual(["hi"]);
		expect(surface.prompts()).toBe(0);
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
			...fakeSurface(),
		});
		expect(calls).toEqual(["interrupt"]);
	});

	it("a 'handled' outcome does NOT submit or wait, but re-echoes and re-prompts", async () => {
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
		const surface = fakeSurface();
		await runStandaloneRepl({
			keys: keys(),
			session: session as never,
			host: { handleEvent: async () => {}, stop: async () => {} } as never,
			write: () => {},
			slash: fakeSlash(() => ({ action: "handled" })),
			...surface,
		});
		expect(calls).toEqual([]); // never submitted, never waited
		// A handled command is still re-echoed as a turn and the REPL draws the
		// next prompt itself (no idle event would).
		expect(surface.echoed).toEqual(["/help"]);
		expect(surface.prompts()).toBe(1);
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
			...fakeSurface(),
		});
		expect(calls).toContain("close");
		expect(calls).not.toContain("submit");
	});

	it("an empty line advances without echoing a turn or submitting", async () => {
		const submitted: string[] = [];
		async function* keys() {
			for (const k of ["\r", "\x04"]) yield k; // bare Enter, then Ctrl-D
		}
		const session = {
			submit: (t: string) => submitted.push(t),
			interrupt: () => {},
			waitForEvent: async () => ({ type: "idle" }) as never,
			close: () => {},
		};
		const surface = fakeSurface();
		await runStandaloneRepl({
			keys: keys(),
			session: session as never,
			host: { handleEvent: async () => {}, stop: async () => {} } as never,
			write: () => {},
			slash: fakeSlash(),
			...surface,
		});
		expect(submitted).toEqual([]);
		expect(surface.echoed).toEqual([]);
	});
});
