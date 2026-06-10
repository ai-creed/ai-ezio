import { describe, expect, it, vi } from "vitest";

const transportParams = vi.hoisted((): unknown[] => []);

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: class {
		constructor(params: unknown) {
			transportParams.push(params);
		}
	},
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: class {
		connect = vi.fn().mockResolvedValue(undefined);
		listTools = vi.fn().mockResolvedValue({ tools: [] });
		callTool = vi.fn();
		close = vi.fn();
	},
}));

import { connectStdio } from "./mcp-client.js";

describe("connectStdio", () => {
	it("does not inherit MCP server stderr into the terminal", async () => {
		transportParams.length = 0;

		await connectStdio({ name: "cortex", command: "ai-cortex", args: ["mcp"] });

		expect(transportParams).toEqual([
			{ command: "ai-cortex", args: ["mcp"], env: undefined, stderr: "ignore" },
		]);
	});
});
