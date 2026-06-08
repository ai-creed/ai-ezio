#!/usr/bin/env node
/* Minimal stdio MCP server for the M9 e2e: one `echo` tool that returns its
 * arguments as text. Low-level Server API (no zod) for version robustness. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "stub", version: "0.0.1" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "echo",
			description: "Echo the arguments back as text.",
			inputSchema: { type: "object", properties: { msg: { type: "string" } } },
		},
	],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => ({
	content: [{ type: "text", text: `echo:${JSON.stringify(req.params.arguments ?? {})}` }],
}));

await server.connect(new StdioServerTransport());
