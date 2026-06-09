import { describe, expect, it } from "vitest";
import {
	applyCortex,
	classifyCortex,
	cortexEntry,
	cortexEntryLaunches,
	type McpFile,
	nextBackupPath,
	parseMcp,
	serializeMcp,
} from "./reconcile-mcp.js";

const CORTEX = { command: "ai-cortex", args: ["mcp"] };
const obj = (raw: string | null): McpFile => {
	const p = parseMcp(raw);
	if (!p.ok) throw new Error("expected parseable");
	return p.obj;
};

describe("classifyCortex", () => {
	it("missing when no entry", () =>
		expect(classifyCortex(obj(null), { entryWorks: () => true })).toBe("missing"));

	it("valid-portable for a working `ai-cortex mcp` entry", () => {
		const raw = JSON.stringify({ mcpServers: { cortex: { command: "ai-cortex", args: ["mcp"] } } });
		expect(classifyCortex(obj(raw), { entryWorks: () => true })).toBe("valid-portable");
	});

	it("valid-hardcoded for a working `node /abs/cli.js mcp` entry", () => {
		const raw = JSON.stringify({
			mcpServers: { cortex: { command: "node", args: ["/abs/cli.js", "mcp"] } },
		});
		// entryWorks must inspect args[0] (the script path), NOT args[1] ("mcp").
		const seen: string[] = [];
		const kind = classifyCortex(obj(raw), {
			entryWorks: (e) => {
				seen.push(e.args?.[0] ?? "");
				return true;
			},
		});
		expect(seen).toEqual(["/abs/cli.js"]);
		expect(kind).toBe("valid-hardcoded");
	});

	it("broken when the entry does not launch", () => {
		const raw = JSON.stringify({
			mcpServers: { cortex: { command: "node", args: ["/gone/cli.js", "mcp"] } },
		});
		expect(classifyCortex(obj(raw), { entryWorks: () => false })).toBe("broken");
	});
});

describe("applyCortex", () => {
	it("sets the portable entry and preserves unknown keys + policy", () => {
		const start = obj(
			JSON.stringify({ toolPolicy: { cortex__recall_memory: "allow" }, future: { keep: 1 } }),
		);
		const next = applyCortex(start, CORTEX);
		expect(next.mcpServers?.cortex).toEqual(CORTEX);
		expect(next.toolPolicy).toEqual({ cortex__recall_memory: "allow" });
		expect((next as Record<string, unknown>).future).toEqual({ keep: 1 });
	});
	it("round-trips idempotently", () => {
		const once = applyCortex(obj(null), CORTEX);
		expect(serializeMcp(applyCortex(obj(serializeMcp(once)), CORTEX))).toBe(serializeMcp(once));
	});
});

describe("cortexEntry (spec §5.4 fallback)", () => {
	it("portable when ai-cortex is on PATH", () => {
		expect(cortexEntry(true, null)).toEqual({ command: "ai-cortex", args: ["mcp"] });
	});
	it("resolved-node fallback when NOT on PATH but the cli is resolvable", () => {
		expect(cortexEntry(false, "/g/ai-cortex/dist/src/cli.js")).toEqual({
			command: "node",
			args: ["/g/ai-cortex/dist/src/cli.js", "mcp"],
		});
	});
	it("returns null (NOT an unusable `ai-cortex` command) when neither resolves", () => {
		expect(cortexEntry(false, null)).toBeNull();
	});
});

describe("cortexEntryLaunches (no valid entry misclassified as broken)", () => {
	const deps = {
		onPath: (c: string) => c === "ai-cortex",
		fileExists: (p: string) => p === "/abs/cli.js",
	};
	it("bare command -> resolved on PATH", () => {
		expect(cortexEntryLaunches({ command: "ai-cortex", args: ["mcp"] }, deps)).toBe(true);
		expect(cortexEntryLaunches({ command: "missing-cmd", args: ["mcp"] }, deps)).toBe(false);
	});
	it("`node <script>` -> the script (args[0]) exists", () => {
		expect(cortexEntryLaunches({ command: "node", args: ["/abs/cli.js", "mcp"] }, deps)).toBe(true);
		expect(cortexEntryLaunches({ command: "node", args: ["/gone/cli.js", "mcp"] }, deps)).toBe(
			false,
		);
	});
	it("absolute-path command -> the executable exists (NOT misread as a node script via args[1])", () => {
		expect(cortexEntryLaunches({ command: "/abs/cli.js", args: ["mcp"] }, deps)).toBe(true);
	});
});

describe("parseMcp + nextBackupPath (finding 4)", () => {
	it("reports malformed as not-ok", () => expect(parseMcp("{ nope").ok).toBe(false));
	it("never overwrites — picks the next free name", () => {
		const exists = new Set(["/c/mcp.json.bak", "/c/mcp.json.bak.1"]);
		expect(nextBackupPath("/c/mcp.json", (p) => exists.has(p))).toBe("/c/mcp.json.bak.2");
		expect(nextBackupPath("/c/mcp.json", () => false)).toBe("/c/mcp.json.bak");
	});
});
