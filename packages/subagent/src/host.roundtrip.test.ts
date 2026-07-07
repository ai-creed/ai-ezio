import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { Session, DelegatedToolRegistry } from "@ai-ezio/harness";
import { SubagentHost } from "./host.js";
import { buildCatalog } from "./catalog.js";

// The fake engine emits a tool_call_requested when it receives
// register_delegated_tools, then echoes the host's tool_result back as the turn
// content — exercising the parent tool_call_requested -> tool_result round trip
// over a real Session (mirrors harness/src/session.delegated.test.ts).
const FAKE = fileURLToPath(new URL("../test-fixtures/fake-engine.mjs", import.meta.url));
chmodSync(FAKE, 0o755);

it("services a parent delegated subagent call over a real Session", async () => {
	const catalog = buildCatalog({
		config: {
			default: "p",
			subagentTimeoutMs: 1000,
			profiles: { p: { provider: "codex", model: "gpt-5.4-mini" } },
		},
		seed: { profiles: {}, cheapest: undefined },
	});
	// Inject a dispatch stub: no real child hax spawns; it returns a known answer.
	const dispatch = () => ({
		promise: Promise.resolve({ output: "ANSWER", status: "ok" as const, elapsedMs: 3 }),
		cancel: () => {},
	});
	const host = new SubagentHost({
		catalog,
		cwd: process.cwd(),
		parentEnv: process.env,
		dispatch: dispatch,
		makeSession: (() => ({})) as never,
		makeMcpHost: (() => ({})) as never,
	});

	const reg = new DelegatedToolRegistry([host]);
	const session = new Session({ onEvent: (e) => reg.handleEvent(e) });
	await session.start({
		binary: FAKE,
		env: { ...process.env, FAKE_DELEGATED_ARGS: JSON.stringify({ task: "do it", profile: "p" }) },
	});
	await reg.start(session); // registers `subagent` -> fake emits tool_call_requested -> host dispatches -> sendToolResult

	const fin = await session.waitForEvent("assistant_turn_finished");
	expect(fin.type).toBe("assistant_turn_finished");
	if (fin.type === "assistant_turn_finished") expect(fin.content).toBe("result:ANSWER:ok");
	session.close();
}, 10000);
