#!/usr/bin/env node
/** Gated bootstrap e2e (spec §7). Runs the built CLI against a temp HOME with
 * stubbed peers/installers and asserts: (1) `init --yes` wires mcp.json + bridge
 * + marker; (2) present peers cause ZERO installer executions; (3) a rerun never
 * duplicates the managed bridge block; (4) repeated malformed-mcp recovery keeps
 * distinct backups. Dispatcher-level first-run invocation/suppression is proven by
 * maybeRunFirstRun's unit test (Task 10), which drives the offers through the real
 * parseInitArgs([])->runInit chain and suppression through the REAL marker module. */
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
// dist/cli.js is the bundled library (exports main); bin/ai-ezio.mjs is the
// executable entry that actually calls main(argv), so drive the CLI through it.
const dist = join(repoRoot, "packages/cli/dist/cli.js");
const cli = join(repoRoot, "packages/cli/bin/ai-ezio.mjs");
if (!existsSync(dist)) {
	console.error("build first: pnpm --filter ai-ezio build");
	process.exit(1);
}
const home = mkdtempSync(join(tmpdir(), "ezio-boot-"));
const fakeBin = join(home, "bin");
mkdirSync(fakeBin, { recursive: true });
const installLog = join(home, "install.log");
// Present peers (version >= min) + an `npm` that LOGS any `install -g` call.
writeFileSync(join(fakeBin, "ai-cortex"), `#!/bin/sh\necho "ai-cortex 0.14.2"\n`, { mode: 0o755 });
writeFileSync(join(fakeBin, "whisper"), `#!/bin/sh\necho "whisper 0.5.5"\n`, { mode: 0o755 });
writeFileSync(
	join(fakeBin, "npm"),
	`#!/bin/sh\ncase "$*" in *"install -g"*) echo "$*" >> ${installLog};; esac\necho '{"dependencies":{"ai-ezio":{}}}'\n`,
	{ mode: 0o755 },
);
const env = {
	...process.env,
	HOME: home,
	XDG_CONFIG_HOME: join(home, ".config"),
	XDG_DATA_HOME: join(home, ".local/share"),
	PATH: `${fakeBin}:${process.env.PATH}`,
	AI_EZIO_HAX_BIN: join(repoRoot, "vendor/hax/build/hax"),
	SHELL: "/bin/zsh",
};
writeFileSync(join(home, ".zshrc"), "# rc\n");
const mcp = join(home, ".config/ai-ezio/mcp.json");
const fail = (m) => {
	console.error(`BOOTSTRAP SMOKE FAIL: ${m}`);
	rmSync(home, { recursive: true, force: true });
	process.exit(1);
};
const runCli = (args) => execFileSync("node", [cli, ...args], { env, encoding: "utf8" });

// (1) init --yes wires config/bridge/marker
runCli(["init", "--yes"]);
if (!existsSync(mcp) || !readFileSync(mcp, "utf8").includes("ai-cortex"))
	fail("cortex mcp entry missing");
if (!readFileSync(join(home, ".zshrc"), "utf8").includes("AI_EZIO_HAX_BIN"))
	fail("bridge export missing");
if (!existsSync(join(home, ".config/ai-ezio/.bootstrapped"))) fail("marker not written");

// (2) present peers -> ZERO installer executions
if (existsSync(installLog))
	fail(`installer ran for present peers: ${readFileSync(installLog, "utf8")}`);

// (3) rerun -> no duplicate managed block
runCli(["init", "--yes", "--reconfigure"]);
const blocks = (
	readFileSync(join(home, ".zshrc"), "utf8").match(/# >>> ai-ezio \(managed\) >>>/g) ?? []
).length;
if (blocks !== 1) fail(`managed bridge block duplicated: ${blocks}`);

// (4) repeated malformed-mcp recovery keeps distinct backups
writeFileSync(mcp, "{ not json");
runCli(["init", "--yes"]);
writeFileSync(mcp, "{ still not json");
runCli(["init", "--yes"]);
if (!existsSync(`${mcp}.bak`) || !existsSync(`${mcp}.bak.1`))
	fail("collision-safe backups not retained across repeated recovery");

rmSync(home, { recursive: true, force: true });

// (5) read-only ~/.zshrc must NOT crash with EACCES — bootstrap fs writes degrade to
// guidance and `ai-ezio init --yes` still exits 0 (finding 1, spec §6). Isolated HOME.
const roHome = mkdtempSync(join(tmpdir(), "ezio-boot-ro-"));
const roBin = join(roHome, "bin");
mkdirSync(roBin, { recursive: true });
// Present peers so the bridge step actually runs and attempts the profile write.
writeFileSync(join(roBin, "ai-cortex"), `#!/bin/sh\necho "ai-cortex 0.14.2"\n`, { mode: 0o755 });
writeFileSync(join(roBin, "whisper"), `#!/bin/sh\necho "whisper 0.5.5"\n`, { mode: 0o755 });
const roProfile = join(roHome, ".zshrc");
writeFileSync(roProfile, "# rc\n");
chmodSync(roProfile, 0o444); // read-only profile -> the managed-export write hits EACCES
const roEnv = {
	...process.env,
	HOME: roHome,
	XDG_CONFIG_HOME: join(roHome, ".config"),
	XDG_DATA_HOME: join(roHome, ".local/share"),
	PATH: `${roBin}:${process.env.PATH}`,
	AI_EZIO_HAX_BIN: join(repoRoot, "vendor/hax/build/hax"),
	SHELL: "/bin/zsh",
};
const roFail = (m) => {
	console.error(`BOOTSTRAP SMOKE FAIL: ${m}`);
	rmSync(roHome, { recursive: true, force: true });
	process.exit(1);
};
// spawnSync so a non-zero exit is observable instead of throwing.
const ro = spawnSync("node", [cli, "init", "--yes"], { env: roEnv, encoding: "utf8" });
const roOut = `${ro.stdout ?? ""}${ro.stderr ?? ""}`;
if (ro.status !== 0)
	roFail(`read-only profile crashed init (exit ${ro.status}) — output:\n${roOut}`);
if (/EACCES/.test(roOut) && !/could not write/.test(roOut))
	roFail(`raw EACCES surfaced without guidance:\n${roOut}`);
// the degradation must be a printed guidance line that names the unwritable profile
if (!roOut.includes(roProfile)) roFail(`no guidance naming the read-only profile:\n${roOut}`);
// and the read-only profile must be left untouched (no partial/managed write)
if (readFileSync(roProfile, "utf8") !== "# rc\n") roFail("read-only profile was modified");
rmSync(roHome, { recursive: true, force: true });

console.log(
	"BOOTSTRAP SMOKE PASS: wiring, zero-install-when-present, no-duplicate rerun, distinct backups, read-only-profile degrades to guidance (exit 0)",
);
