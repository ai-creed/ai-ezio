import { describe, expect, it } from "vitest";
import { encodeToolName, RouteMap } from "./namespace.js";

describe("namespace", () => {
	it("encodes <server>__<tool>", () => {
		expect(encodeToolName("cortex", "recall_memory")).toBe("cortex__recall_memory");
	});
	it("routes a namespaced name back to (server, tool)", () => {
		const map = new RouteMap();
		map.add("cortex", "recall_memory");
		expect(map.resolve("cortex__recall_memory")).toEqual({
			server: "cortex",
			tool: "recall_memory",
		});
		expect(map.resolve("unknown__x")).toBeUndefined();
	});
});
