import { describe, expect, it } from "vitest";
import { mapToolResult, type McpToolResult } from "./mcp-client.js";

describe("mapToolResult", () => {
	it("joins text content blocks", () => {
		const r: McpToolResult = { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] };
		expect(mapToolResult(r)).toEqual({ output: "a\nb", status: "ok" });
	});
	it("maps isError to status error", () => {
		const r: McpToolResult = { content: [{ type: "text", text: "boom" }], isError: true };
		expect(mapToolResult(r)).toEqual({ output: "boom", status: "error" });
	});
	it("stringifies non-text blocks", () => {
		const r: McpToolResult = { content: [{ type: "image", data: "..." } as never] };
		expect(mapToolResult(r).status).toBe("ok");
	});
});
