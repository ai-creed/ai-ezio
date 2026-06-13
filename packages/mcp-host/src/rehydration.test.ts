import { describe, expect, it } from "vitest";
import { callHostRehydration, type RehydrationHost } from "./rehydration.js";

function fakeHost(opts: {
	names: string[];
	output?: string;
	status?: "ok" | "error";
	throws?: boolean;
}): { host: RehydrationHost; calls: Array<{ name: string; args: unknown }> } {
	const calls: Array<{ name: string; args: unknown }> = [];
	return {
		calls,
		host: {
			hostToolNames: () => opts.names,
			callHostTool: async (name, args) => {
				calls.push({ name, args });
				if (opts.throws) throw new Error("down");
				return { output: opts.output ?? "", status: opts.status ?? "ok" };
			},
		},
	};
}

describe("callHostRehydration", () => {
	it("picks the rehydration tool, passes {}, returns the ok output", async () => {
		const { host, calls } = fakeHost({
			names: ["cortex__rehydrate_project", "cortex__get_memory"],
			output: "RULES",
		});
		expect(await callHostRehydration(host)).toBe("RULES");
		expect(calls).toEqual([{ name: "cortex__rehydrate_project", args: {} }]);
	});

	it("error status, empty output, no match, or a throw -> null", async () => {
		expect(
			await callHostRehydration(
				fakeHost({ names: ["cortex__recall_memory"], output: "x", status: "error" }).host,
			),
		).toBeNull();
		expect(
			await callHostRehydration(fakeHost({ names: ["cortex__recall_memory"], output: "  " }).host),
		).toBeNull();
		const none = fakeHost({ names: ["cortex__capture_session"] });
		expect(await callHostRehydration(none.host)).toBeNull();
		expect(none.calls).toHaveLength(0);
		expect(
			await callHostRehydration(fakeHost({ names: ["cortex__recall_memory"], throws: true }).host),
		).toBeNull();
	});
});
