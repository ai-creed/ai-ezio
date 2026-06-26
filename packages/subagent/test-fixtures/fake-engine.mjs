#!/usr/bin/env node
/* Minimal fake protocol engine for subagent round-trip tests. Writes JSONL to fd
 * 3 and reads controls from fd 4. On `register_delegated_tools` it emits a
 * `tool_call_requested` for the first registered tool (args from
 * FAKE_DELEGATED_ARGS, default {task:"go"}); on `tool_result` it echoes the host's
 * reply back as the turn content `result:<output>:<status>` then idles. */
import fs from "node:fs";

const emit = (o) => fs.writeSync(3, `${JSON.stringify(o)}\n`);
emit({ type: "ready", sessionId: "fake", protocol: "0.1.0", haxBaseCommit: "fake" });

let buf = "";
const controls = fs.createReadStream(null, { fd: 4 });
controls.on("data", (chunk) => {
	buf += chunk.toString("utf8");
	let nl;
	while ((nl = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, nl);
		buf = buf.slice(nl + 1);
		if (!line.trim()) continue;
		let ctl;
		try {
			ctl = JSON.parse(line);
		} catch {
			continue;
		}
		if (ctl.type === "register_delegated_tools") {
			let args = { task: "go" };
			if (process.env.FAKE_DELEGATED_ARGS) {
				try {
					args = JSON.parse(process.env.FAKE_DELEGATED_ARGS);
				} catch {
					/* keep default */
				}
			}
			emit({ type: "tool_call_requested", turnId: "t1", callId: "c1", name: ctl.tools[0].name, args });
			continue;
		}
		if (ctl.type === "tool_result") {
			emit({ type: "assistant_turn_finished", turnId: "t1", content: `result:${ctl.output}:${ctl.status}` });
			emit({ type: "idle" });
			continue;
		}
	}
});
controls.on("end", () => process.exit(0));
