#!/usr/bin/env node
/**
 * Manual M3 protocol smoke: an interactive driver over the real fd protocol.
 * Spawns hax (mounted, fds wired) via the harness Session, prints every JSONL
 * event as it arrives on fd 3, lets you submit prompts (written as `submit`
 * controls on fd 4), and shows the authoritative handback. Ctrl-D to quit.
 *
 *   node scripts/protocol-repl.mjs              # mock provider (no API key)
 *   HAX_PROVIDER=anthropic node scripts/...     # a real provider (needs a key)
 *
 * Try: "say hello"   (plain turn)   ·   "run `ls`"  (mock tool call)
 */
import readline from "node:readline";
import { Session } from "../packages/harness/dist/index.js";

const env = { ...process.env };
if (!env.HAX_PROVIDER) env.HAX_PROVIDER = "mock";
env.HAX_NO_SESSION = env.HAX_NO_SESSION ?? "1";

const session = new Session({
	onEvent: (e) => console.log(`  fd3 ◀ ${JSON.stringify(e)}`),
});

const ready = await session.start({ env });
console.log(
	`\n[ready] protocol=${ready.protocol} haxBaseCommit=${ready.haxBaseCommit} provider=${env.HAX_PROVIDER}`,
);
console.log("Type a prompt + Enter. Ctrl-D to quit.\n");

const rl = readline.createInterface({ input: process.stdin, terminal: false });
for await (const line of rl) {
	if (!line.trim()) continue;
	console.log(`  fd4 ▶ ${JSON.stringify({ type: "submit", text: line })}`);
	try {
		const result = await session.submitAndWait(line);
		console.log(`\n[handback] ${JSON.stringify(result.content)}\n`);
	} catch (err) {
		console.log(`\n[${err.name}] ${err.message}\n`);
	}
}
session.close();
console.log("\n[closed]");
