import { expect, it } from "vitest";
import { Session, resolveHaxBinary } from "@ai-ezio/harness";
import { runSubagent, type ChildMcp } from "./dispatch.js";

function haxAvailable(): boolean {
	try {
		resolveHaxBinary();
		return true;
	} catch {
		return false;
	}
}

const maybe = haxAvailable() ? it : it.skip;

maybe(
	"runs a real mock-provider child to completion and tears it down",
	async () => {
		const noMcp: ChildMcp = { start: async () => {}, stop: async () => {} };
		let closed = false;
		const handle = runSubagent({
			task: "say hello",
			profile: { provider: "mock", model: "mock" },
			cwd: process.cwd(),
			parentEnv: { ...process.env, HAX_PROVIDER: "mock" },
			timeoutMs: 30_000,
			makeSession: (onEvent) => {
				const s = new Session({ onEvent: onEvent as never });
				return {
					start: (o) => s.start(o),
					submitAndWait: (t) => s.submitAndWait(t),
					close: () => {
						closed = true;
						s.close();
					},
				};
			},
			makeMcpHost: () => noMcp,
		});
		const r = await handle.promise;
		expect(r.status).toBe("ok");
		expect(typeof r.output).toBe("string");
		expect(closed).toBe(true);
	},
	40_000,
);
