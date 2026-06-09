#!/usr/bin/env node
/**
 * Single-install smoke test — proves the M1 milestone contract:
 * "one install produces a working ai-ezio" with the hax binary embedded and
 * resolved from the @ai-ezio/hax-<os>-<cpu> platform package (NOT the dev
 * fallback, NOT a separate hax install).
 *
 * Steps:
 *   1. stage the host hax binary into its platform package
 *   2. pnpm pack protocol, harness, cli, and the host platform package
 *   3. npm install the tarballs into a clean temp dir (no vendor/hax,
 *      AI_EZIO_HAX_BIN unset, optional non-host platforms omitted)
 *   4. run `ai-ezio --version --json` and a `-p` one-shot (HAX_PROVIDER=mock)
 *      from a cwd with no vendor/hax anywhere above it, so the only way the
 *      engine can launch is via the installed platform package.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const hostPkg = `@ai-ezio/hax-${process.platform}-${process.arch}`;
const hostPkgDir = join(repoRoot, "packaging", `hax-${process.platform}-${process.arch}`);

function run(cmd, args, opts = {}) {
	return execFileSync(cmd, args, { encoding: "utf8", stdio: "pipe", ...opts });
}

function fail(msg) {
	console.error(`SMOKE FAIL: ${msg}`);
	process.exit(1);
}

// 0. preconditions: only the bundled cli dist is needed now
if (!existsSync(join(repoRoot, "packages", "cli", "dist", "cli.js"))) {
	fail("packages/cli/dist/cli.js missing — run `pnpm --filter ai-ezio build` first.");
}

// 1. stage host binary
run("node", [join(repoRoot, "scripts", "stage-host-binary.mjs")], { stdio: "inherit" });

// 2. pack into a temp tarball dir
const work = mkdtempSync(join(tmpdir(), "ai-ezio-smoke-"));
const tarDir = join(work, "tarballs");
const appDir = join(work, "app");
const runDir = join(work, "run");
run("mkdir", ["-p", tarDir, appDir, runDir]);

const packDirs = [join(repoRoot, "packages", "cli"), hostPkgDir]; // bundled ai-ezio + host binary
// `npm pack` (spec §7) runs the cli's prepack (publish-manifest generation) and does
// NOT rewrite `workspace:` — the real publish path, so the smoke matches production.
for (const dir of packDirs) {
	run("npm", ["pack", "--pack-destination", tarDir], { cwd: dir });
}
const tarballs = readdirSync(tarDir)
	.filter((f) => f.endsWith(".tgz"))
	.map((f) => join(tarDir, f));
if (tarballs.length !== 2) fail(`expected 2 tarballs (bundled cli + host binary), got ${tarballs.length}: ${tarballs}`);

// 3. clean install (no AI_EZIO_HAX_BIN, omit non-host optional platforms)
run("npm", ["init", "-y"], { cwd: appDir, stdio: "ignore" });
const cleanEnv = { ...process.env };
delete cleanEnv.AI_EZIO_HAX_BIN;
run(
	"npm",
	["install", "--omit=optional", "--no-audit", "--no-fund", "--no-save", ...tarballs],
	{ cwd: appDir, env: cleanEnv, stdio: "inherit" },
);

const binPath = join(appDir, "node_modules", ".bin", "ai-ezio");
if (!existsSync(binPath)) fail(`ai-ezio bin not installed at ${binPath}`);
// the host platform package must be present (proves binary embedded, not dev fallback)
const installedBinary = join(appDir, "node_modules", hostPkg, "bin", "hax");
if (!existsSync(installedBinary)) fail(`platform binary not installed at ${installedBinary}`);

// 4a. --version --json (run from runDir: no vendor/hax above it)
const versionOut = run("node", [binPath, "--version", "--json"], { cwd: runDir, env: cleanEnv });
let info;
try {
	info = JSON.parse(versionOut.trim());
} catch {
	fail(`--version --json did not emit JSON: ${versionOut}`);
}
if (!/^\d+\.\d+\.\d+$/.test(info.ezioVersion ?? "")) fail(`bad ezioVersion: ${versionOut}`);
if (info.haxBaseCommit !== "8fd139b5db49bd0b1d552c2530a18b547b3f4f4c") {
	fail(`bad haxBaseCommit: ${versionOut}`);
}

// 4b. one-shot through the embedded engine (mock provider = offline, deterministic)
const oneShot = run("node", [binPath, "-p", "say hello"], {
	cwd: runDir,
	env: { ...cleanEnv, HAX_PROVIDER: "mock" },
});

rmSync(work, { recursive: true, force: true });
console.log("\nSMOKE PASS:");
console.log(`  version: ${JSON.stringify(info)}`);
console.log(`  embedded engine resolved from: ${hostPkg}`);
console.log(`  one-shot output: ${JSON.stringify(oneShot.trim().slice(0, 80))}`);
