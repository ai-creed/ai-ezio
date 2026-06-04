#!/usr/bin/env node
/**
 * Public `ai-ezio --mount-mode` smoke (M4): runs the ACTUAL ai-ezio CLI bin with
 * --mount-mode + protocol fds, drives one mock turn, and asserts the CLI forwards
 * --mount-mode + the fds to hax (the turn runs end to end) and the child's
 * captured stdout/stderr is chrome-suppressed (no banner). This is the
 * public-command counterpart to the C-level mount_chrome test (raw hax).
 *
 * Standalone (not vitest) because the double-spawn (ezio -> hax) extra-fd
 * inheritance is unreliable inside vitest's worker pool; it is correct in a
 * normal process, which is exactly how ai-ezio is launched in production.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(repoRoot, "packages", "cli", "bin", "ai-ezio.mjs");
const HAX = join(repoRoot, "vendor", "hax", "build", "hax");

if (!existsSync(HAX)) {
	console.error(`SKIP: hax not built at ${HAX}`);
	process.exit(0);
}

const child = spawn(process.execPath, [BIN, "--mount-mode", "--protocol-fd=3", "--control-fd=4"], {
	stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
	env: { ...process.env, HAX_PROVIDER: "mock", HAX_NO_SESSION: "1" },
});

let chrome = "";
child.stdout.on("data", (d) => (chrome += d.toString()));
child.stderr.on("data", (d) => (chrome += d.toString()));

const events = child.stdio[3];
const controls = child.stdio[4];
const types = [];
let buf = "";

function finish(ok, msg) {
	try {
		controls.end();
	} catch {
		/* ignore */
	}
	child.kill();
	if (ok) {
		console.log(`CLI MOUNT SMOKE PASS: ${msg}`);
		process.exit(0);
	}
	console.error(`CLI MOUNT SMOKE FAIL: ${msg}`);
	process.exit(1);
}

events.on("data", (d) => {
	buf += d.toString();
	let nl;
	while ((nl = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, nl);
		buf = buf.slice(nl + 1);
		if (!line.trim()) continue;
		const e = JSON.parse(line);
		types.push(e.type);
		if (e.type === "ready") controls.write(`${JSON.stringify({ type: "submit", text: "hello" })}\n`);
		if (e.type === "idle") {
			const ranTurn =
				types.includes("user_turn_started") && types.includes("assistant_turn_finished");
			const chromeSuppressed = !chrome.includes("ctrl-d quit");
			if (!ranTurn) finish(false, `turn did not run; events=${types}`);
			else if (!chromeSuppressed) finish(false, `chrome not suppressed: ${JSON.stringify(chrome.slice(0, 120))}`);
			else finish(true, `mounted turn ran; chrome suppressed (events=${types.length})`);
		}
	}
});

child.on("error", (e) => finish(false, `spawn error: ${e.message}`));
setTimeout(() => finish(false, "timeout waiting for idle"), 10000);
