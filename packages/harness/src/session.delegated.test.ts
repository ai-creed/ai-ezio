import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ToolCallRequestedEvent } from "@ai-ezio/protocol";
import { Session } from "./session.js";

// The fake engine, in `delegated` mode, emits a `tool_call_requested` when it
// receives `register_delegated_tools`, and echoes a `tool_result` back as the
// turn's content — so this exercises both new Session methods end to end.
const FAKE = fileURLToPath(new URL("../test-fixtures/fake-engine.mjs", import.meta.url));
chmodSync(FAKE, 0o755);

describe("Session delegated-tool API", () => {
	it("registers delegated tools and round-trips a tool result", async () => {
		const session = new Session();
		await session.start({ binary: FAKE, env: { ...process.env, FAKE_ENGINE_MODE: "delegated" } });

		session.registerDelegatedTools([
			{ name: "cortex__recall_memory", description: "d", parametersSchema: { type: "object" } },
		]);

		const req = (await session.waitForEvent("tool_call_requested")) as ToolCallRequestedEvent;
		expect(req.name).toBe("cortex__recall_memory");
		expect(req.args).toEqual({ k: "v" });

		session.sendToolResult(req.callId, "OUT", "ok");
		const fin = await session.waitForEvent("assistant_turn_finished");
		expect(fin.type).toBe("assistant_turn_finished");
		if (fin.type === "assistant_turn_finished") expect(fin.content).toBe("result:OUT:ok");

		session.close();
	}, 10000);
});
