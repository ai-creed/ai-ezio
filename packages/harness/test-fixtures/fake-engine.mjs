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

if (mode === "exit-after-ready") {
	// Emit ready (above), then exit so start() resolves first and the child-exit
	// drives Session.onExit afterwards.
	setTimeout(() => process.exit(0), 10);
} else if (mode === "bad-major") {
	// Stay alive; the harness rejects on the version gate and kills us.
	setInterval(() => {}, 1 << 30);
} else {
	let submits = 0;
	let lastTurnId = "";
	let lastContent = "";
	let compactSeq = 0;
	const parked = []; // held compact replies (FAKE_COMPACT_MODE hold/hold-idle)
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
			if (ctl.type === "copy_last_response") {
				if (lastTurnId)
					emit({ type: "assistant_turn_finished", turnId: lastTurnId, content: lastContent });
				else emit({ type: "error", message: "no previous response" });
				continue;
			}
			if (ctl.type === "new_conversation") {
				emit({ type: "idle" });
				continue;
			}
			if (ctl.type === "register_delegated_tools") {
				// M9: simulate the model immediately calling the first delegated tool.
				const t = ctl.tools[0];
				emit({
					type: "tool_call_requested",
					turnId: "t1",
					callId: "c1",
					name: t.name,
					args: { k: "v" },
				});
				continue;
			}
			if (ctl.type === "tool_result") {
				// Echo the host's delegated result back so the harness can assert it.
				emit({ type: "assistant_turn_finished", turnId: "t1", content: `result:${ctl.output}:${ctl.status}` });
				emit({ type: "idle" });
				continue;
			}
			if (ctl.type === "compact") {
				// M11. FAKE_COMPACT_MODE selects reply behavior, all FIFO-safe:
				//   ok (default)  reply compacted+idle immediately
				//   hold          park the whole reply; a later `status` control
				//                 flushes parked replies (in order) BEFORE answering
				//   hold-idle     reply compacted immediately, park the idle; a
				//                 later `status` flushes parked idles first
				// droppedItems = 100 + per-compact sequence, so tests can tell
				// which control a compacted event answers.
				compactSeq += 1;
				const reply = { type: "compacted", droppedItems: 100 + compactSeq, keptTurns: ctl.keepLastTurns };
				const cmode = process.env.FAKE_COMPACT_MODE ?? "ok";
				if (cmode === "hold") {
					parked.push(reply, { type: "idle" });
				} else if (cmode === "hold-idle") {
					emit(reply);
					parked.push({ type: "idle" });
				} else {
					emit(reply);
					emit({ type: "idle" });
				}
				continue;
			}
			if (ctl.type === "status") {
				// Flush parked compact replies FIRST (the engine is FIFO; a held
				// reply always precedes a later control's answer).
				for (const ev of parked.splice(0)) emit(ev);
				emit({
					type: "status",
					model: "fake-model",
					provider: "fake",
					protocol: "0.1.0",
					sessionId: "fake",
					state: "idle",
					contextPercent: null,
				});
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
				lastContent = `ok ${ctl.text}`;
				lastTurnId = turnId;
				emit({ type: "assistant_turn_finished", turnId, content: lastContent });
			}
			emit({ type: "idle" });
		}
	});
	controls.on("end", () => process.exit(0));
}
