#!/usr/bin/env node
/**
 * M3a feasibility smoke: drive the patched hax over inherited fds (no scraping).
 *
 * Phase 1 (lifecycle): send a `submit` and assert the EXACT ordered M3a sequence
 *   ready, user_turn_started, assistant_turn_started, assistant_delta(>=1),
 *   assistant_turn_finished{content}, idle — with deltas concatenating to content.
 * Phase 2 (interrupt): with a slow mock script, submit, then `interrupt` the live
 *   turn and assert it aborts back to idle promptly without delivering the full
 *   scripted text.
 *
 * Exits non-zero on any mismatch. (Port of the original proto-smoke.py; the
 * child fds are deterministic here — stdio positions 3/4 — so no pass_fds
 * bookkeeping is needed.)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HAX = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "hax", "build", "hax");

/** Spawn hax with protocol fds wired and read/write JSONL over them. */
class Engine {
	constructor(extraEnv = {}) {
		this.proc = spawn(HAX, ["--protocol-fd=3", "--control-fd=4"], {
			stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
			env: { ...process.env, HAX_PROVIDER: "mock", HAX_NO_SESSION: "1", ...extraEnv },
		});
		this.events = this.proc.stdio[3];
		this.controls = this.proc.stdio[4];
		this.queue = [];
		this.waiters = [];
		this.eof = false;
		let buf = "";
		this.events.setEncoding("utf8");
		this.events.on("data", (chunk) => {
			buf += chunk;
			let nl;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line) continue;
				const ev = JSON.parse(line);
				const w = this.waiters.shift();
				if (w) w(ev);
				else this.queue.push(ev);
			}
		});
		this.events.on("end", () => {
			this.eof = true;
			for (const w of this.waiters.splice(0)) w(null);
		});
	}

	send(control) {
		this.controls.write(`${JSON.stringify(control)}\n`);
	}

	/** Read events until one whose type is in `types`; return all collected. */
	async readUntil(types, timeoutMs = 10_000) {
		const events = [];
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const ev = await this.next(deadline - Date.now(), types, events);
			if (ev === null) return events; // EOF
			events.push(ev);
			if (types.has(ev.type)) return events;
		}
	}

	next(ms, types, events) {
		if (this.queue.length) return Promise.resolve(this.queue.shift());
		if (this.eof) return Promise.resolve(null);
		return new Promise((resolve, reject) => {
			const waiter = (ev) => {
				clearTimeout(timer);
				resolve(ev);
			};
			const timer = setTimeout(() => {
				const i = this.waiters.indexOf(waiter);
				if (i >= 0) this.waiters.splice(i, 1); // no orphan steals later events
				const got = events.map((e) => e.type);
				reject(new Error(`no ${[...types]} within timeout; got ${JSON.stringify(got)}`));
			}, Math.max(1, ms));
			this.waiters.push(waiter);
		});
	}

	async close() {
		this.controls.end();
		const exited = new Promise((resolve) => {
			if (this.proc.exitCode !== null) return resolve();
			this.proc.once("exit", resolve);
		});
		const timer = setTimeout(() => this.proc.kill("SIGKILL"), 5000);
		await exited;
		clearTimeout(timer);
	}
}

async function phaseLifecycle(failures) {
	const eng = new Engine();
	try {
		const ready = (await eng.readUntil(new Set(["ready"]))).at(-1);
		if (ready?.type !== "ready" || !("protocol" in ready)) {
			failures.push(`bad ready: ${JSON.stringify(ready)}`);
		}
		eng.send({ type: "submit", text: "say hello" });
		const evs = await eng.readUntil(new Set(["idle"]));
		const seq = evs.map((e) => e.type);
		console.log(`  lifecycle: ready + ${JSON.stringify(seq)}`);

		// Exact required ordered subsequence (deltas required).
		const required = [
			"user_turn_started",
			"assistant_turn_started",
			"assistant_delta",
			"assistant_turn_finished",
			"idle",
		];
		let pos = 0;
		for (const t of seq) if (pos < required.length && t === required[pos]) pos += 1;
		if (pos !== required.length) {
			failures.push(`sequence missing/oo-order; need ${required} as subseq of ${seq}`);
		}

		const deltas = evs.filter((e) => e.type === "assistant_delta");
		if (deltas.length === 0) failures.push("no assistant_delta emitted (required in M3a)");
		const finished = evs.find((e) => e.type === "assistant_turn_finished");
		const content = finished?.content ?? "";
		if (!content.includes("say hello")) {
			failures.push(`content did not reflect input: ${JSON.stringify(content)}`);
		}
		const joined = deltas.map((e) => e.text ?? "").join("");
		if (joined.trim() !== content.trim()) {
			failures.push(
				`delta concat ${JSON.stringify(joined)} != content ${JSON.stringify(content)}`,
			);
		}
	} finally {
		await eng.close();
	}
}

async function phaseInterrupt(failures) {
	const dir = mkdtempSync(join(tmpdir(), "proto-smoke-"));
	const script = join(dir, "slow.mock");
	// One slow turn: a 2.5s delay before any text. The agent's stream tick polls
	// the control fd every ~50ms during the delay, so `interrupt` aborts it.
	writeFileSync(script, "delay 2500\ntext THIS_SHOULD_NOT_APPEAR\nend-turn\n");
	const eng = new Engine({ HAX_MOCK_SCRIPT: script });
	try {
		await eng.readUntil(new Set(["ready"]));
		eng.send({ type: "submit", text: "go" });
		// Wait until the assistant turn is live, then interrupt it.
		await eng.readUntil(new Set(["assistant_turn_started"]));
		const t0 = Date.now();
		eng.send({ type: "interrupt" });
		const evs = await eng.readUntil(new Set(["idle"]), 5000);
		const elapsed = (Date.now() - t0) / 1000;
		const seq = evs.map((e) => e.type);
		console.log(`  interrupt: returned to idle in ${elapsed.toFixed(2)}s; ${JSON.stringify(seq)}`);
		if (elapsed >= 2.0) {
			failures.push(`interrupt did not abort promptly (${elapsed.toFixed(2)}s ~ full 2.5s delay)`);
		}
		if (evs.some((e) => (e.text ?? "").includes("THIS_SHOULD_NOT_APPEAR"))) {
			failures.push("interrupted turn still delivered the scripted text");
		}
		if (!evs.some((e) => e.type === "idle")) failures.push("no idle after interrupt");
	} finally {
		await eng.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

async function main() {
	if (!existsSync(HAX)) {
		console.error(`FAIL: hax binary not built at ${HAX}`);
		return 1;
	}
	const failures = [];
	await phaseLifecycle(failures);
	await phaseInterrupt(failures);
	if (failures.length) {
		console.log("PROTO SMOKE FAIL:");
		for (const f of failures) console.log(`  - ${f}`);
		return 1;
	}
	console.log("PROTO SMOKE PASS");
	return 0;
}

process.exit(await main());
