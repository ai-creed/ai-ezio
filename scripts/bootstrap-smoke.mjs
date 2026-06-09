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

// (6) an UNREADABLE mcp.json (chmod 0000) must NOT crash init with EACCES — the read
// is guarded and degrades to guidance; `ai-ezio init --yes` still exits 0 (finding 1,
// spec §6). Cortex wiring is skipped entirely: NO backup, NO write, NO false claim.
const urHome = mkdtempSync(join(tmpdir(), "ezio-boot-ur-"));
const urBin = join(urHome, "bin");
mkdirSync(urBin, { recursive: true });
// Present cortex so the cortex step actually runs and attempts to read mcp.json.
writeFileSync(join(urBin, "ai-cortex"), `#!/bin/sh\necho "ai-cortex 0.14.2"\n`, { mode: 0o755 });
writeFileSync(join(urBin, "whisper"), `#!/bin/sh\necho "whisper 0.5.5"\n`, { mode: 0o755 });
const urMcp = join(urHome, ".config/ai-ezio/mcp.json");
mkdirSync(dirname(urMcp), { recursive: true });
writeFileSync(urMcp, `{"mcpServers":{}}\n`);
chmodSync(urMcp, 0o000); // unreadable -> the mcp.json read hits EACCES
const urEnv = {
	...process.env,
	HOME: urHome,
	XDG_CONFIG_HOME: join(urHome, ".config"),
	XDG_DATA_HOME: join(urHome, ".local/share"),
	PATH: `${urBin}:${process.env.PATH}`,
	AI_EZIO_HAX_BIN: join(repoRoot, "vendor/hax/build/hax"),
	SHELL: "/bin/zsh",
};
const urFail = (m) => {
	console.error(`BOOTSTRAP SMOKE FAIL: ${m}`);
	chmodSync(urMcp, 0o644); // restore so the temp dir can be cleaned
	rmSync(urHome, { recursive: true, force: true });
	process.exit(1);
};
// spawnSync so a non-zero exit is observable instead of throwing.
const ur = spawnSync("node", [cli, "init", "--yes"], { env: urEnv, encoding: "utf8" });
const urOut = `${ur.stdout ?? ""}${ur.stderr ?? ""}`;
if (ur.status !== 0)
	urFail(`unreadable mcp.json crashed init (exit ${ur.status}) — output:\n${urOut}`);
if (/EACCES/.test(urOut) && !/could not read mcp\.json/.test(urOut))
	urFail(`raw EACCES surfaced without read guidance:\n${urOut}`);
if (!/could not read mcp\.json/.test(urOut))
	urFail(`no "could not read mcp.json" guidance emitted:\n${urOut}`);
// cortex wiring must have been skipped: no backup created next to the unreadable file
if (existsSync(`${urMcp}.bak`)) urFail("a backup was written for an UNREADABLE mcp.json");
chmodSync(urMcp, 0o644); // restore for cleanup
rmSync(urHome, { recursive: true, force: true });

// (7) `ai-ezio doctor` with an UNREADABLE ~/.zshrc must NOT crash — computeWiredState's
// profile read is guarded; doctor renders wired state (bridge -> not persisted) and exits
// per hax availability (0 here), never uncaught EACCES (doctor wired-state, spec §5.2/§6).
const docHome = mkdtempSync(join(tmpdir(), "ezio-boot-doc-"));
const docProfile = join(docHome, ".zshrc");
writeFileSync(docProfile, "# rc\n");
chmodSync(docProfile, 0o000); // unreadable profile
const docEnv = {
	...process.env,
	HOME: docHome,
	XDG_CONFIG_HOME: join(docHome, ".config"),
	XDG_DATA_HOME: join(docHome, ".local/share"),
	AI_EZIO_HAX_BIN: join(repoRoot, "vendor/hax/build/hax"),
	SHELL: "/bin/zsh",
};
const docFail = (m) => {
	console.error(`BOOTSTRAP SMOKE FAIL: ${m}`);
	chmodSync(docProfile, 0o644);
	rmSync(docHome, { recursive: true, force: true });
	process.exit(1);
};
const doc = spawnSync("node", [cli, "doctor"], { env: docEnv, encoding: "utf8" });
const docOut = `${doc.stdout ?? ""}${doc.stderr ?? ""}`;
if (doc.status !== 0)
	docFail(`doctor crashed on an unreadable profile (exit ${doc.status}) — output:\n${docOut}`);
if (!/bootstrap:/.test(docOut)) docFail(`doctor did not render wired state:\n${docOut}`);
chmodSync(docProfile, 0o644);
rmSync(docHome, { recursive: true, force: true });

console.log(
	"BOOTSTRAP SMOKE PASS: wiring, zero-install-when-present, no-duplicate rerun, distinct backups, read-only-profile degrades to guidance (exit 0), unreadable mcp.json degrades to read guidance (exit 0), doctor survives an unreadable profile (exit 0)",
);
