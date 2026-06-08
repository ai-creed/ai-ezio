import { describe, expect, it } from "vitest";
import { runStandaloneRepl } from "./standalone.js";

describe("runStandaloneRepl", () => {
	it("submits a typed line, waits for idle, and exits on Ctrl-D", async () => {
		const submitted: string[] = [];
		async function* keys() {
			for (const k of ["h", "i", "\r", "\x04"]) yield k;
		}
		const session = {
			submit: (t: string) => submitted.push(t),
			interrupt: () => {},
			waitForEvent: async () => ({ type: "idle" }) as never,
			close: () => {},
		};
		let stopped = false;
		await runStandaloneRepl({
			keys: keys(),
			session: session as never,
			host: {
				handleEvent: async () => {},
				stop: async () => {
					stopped = true;
				},
			} as never,
			write: () => {},
		});
		expect(submitted).toEqual(["hi"]);
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
		});
		expect(calls).toEqual(["interrupt"]);
	});
});
