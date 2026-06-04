#!/usr/bin/env node
/**
 * Fake protocol engine for harness tests — writes canned JSONL to fd 3 and reads
 * controls from fd 4, exactly like hax in mounted mode, but deterministic and
 * compiler-free. Behavior is selected by FAKE_ENGINE_MODE:
 *
 *   error              ready(good); on 1st submit emit a turn-scoped `error`
 *                      (then finished+idle); on later submits a normal turn.
 *   fatal-on-submit    ready(good); on 1st submit emit user_turn_started then exit
 *                      (fd-3 EOF mid-turn → fatal).
 *   fatal-before-ready exit immediately (fd-3 EOF before `ready` → fatal).
 *   bad-major          ready with an unsupported protocol major, then stay alive.
 *
 * Spawned with a shebang so `Session.start({ binary })` can exec it directly; the
 * harness appends --protocol-fd/--control-fd, which this script ignores.
 */
import fs from "node:fs";

const mode = process.env.FAKE_ENGINE_MODE ?? "error";
const EVENTS_FD = 3;
const CONTROLS_FD = 4;

const emit = (obj) => fs.writeSync(EVENTS_FD, `${JSON.stringify(obj)}\n`);

if (mode === "fatal-before-ready") {
	process.exit(0);
}

emit({
	type: "ready",
	sessionId: "fake",
	protocol: mode === "bad-major" ? "9.9.9" : "0.1.0",
	haxBaseCommit: "fake",
});

if (mode === "bad-major") {
	// Stay alive; the harness rejects on the version gate and kills us.
	setInterval(() => {}, 1 << 30);
} else {
	let submits = 0;
	let buf = "";
	const controls = fs.createReadStream(null, { fd: CONTROLS_FD });
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
			if (ctl.type !== "submit") continue;
			submits += 1;
			const turnId = `t${submits}`;

			if (mode === "fatal-on-submit") {
				emit({ type: "user_turn_started", turnId });
				process.exit(0);
			}

			emit({ type: "user_turn_started", turnId });
			emit({ type: "assistant_turn_started", turnId });
			if (mode === "error" && submits === 1) {
				emit({ type: "error", message: "boom", turnId });
				emit({ type: "assistant_turn_finished", turnId, content: "" });
			} else {
				emit({ type: "assistant_delta", turnId, text: `ok ${ctl.text}` });
				emit({ type: "assistant_turn_finished", turnId, content: `ok ${ctl.text}` });
			}
			emit({ type: "idle" });
		}
	});
	controls.on("end", () => process.exit(0));
}
