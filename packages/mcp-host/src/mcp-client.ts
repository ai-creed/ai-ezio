/** MCP client: connect a stdio server, list its tools, call them. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { DelegatedToolDef } from "@ai-ezio/protocol";
import type { ServerConfig } from "./config.js";

export interface McpToolResult {
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
}

/** MCP content blocks → the string the model sees + an ok/error status. */
export function mapToolResult(r: McpToolResult): { output: string; status: "ok" | "error" } {
	const output = (r.content ?? [])
		.map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : JSON.stringify(b)))
		.join("\n");
	return { output, status: r.isError ? "error" : "ok" };
}

export interface McpClient {
	/** List tools as delegated defs (un-namespaced tool name in `name`). */
	listTools(): Promise<DelegatedToolDef[]>;
	callTool(
		tool: string,
		args: Record<string, unknown>,
	): Promise<{ output: string; status: "ok" | "error" }>;
	close(): Promise<void>;
}

/** Reject after `ms` so a hung server can't stall a connect/list. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	return Promise.race([
		p,
		new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
	]);
}

/** Spawn + connect a stdio MCP server. */
export async function connectStdio(
	server: ServerConfig,
	connectTimeoutMs = 10_000,
): Promise<McpClient> {
	const transport = new StdioClientTransport({
		command: server.command,
		args: server.args,
		env: server.env,
	});
	const client = new Client({ name: "ai-ezio", version: "0.1.0" }, { capabilities: {} });
	await withTimeout(client.connect(transport), connectTimeoutMs, `connect ${server.name}`);
	return {
		async listTools() {
			const res = await client.listTools();
			return res.tools.map((t) => ({
				name: t.name,
				description: t.description ?? "",
				parametersSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object" },
			}));
		},
		async callTool(tool, args) {
			const res = (await client.callTool({ name: tool, arguments: args })) as McpToolResult;
			return mapToolResult(res);
		},
		async close() {
			await client.close();
		},
	};
}
