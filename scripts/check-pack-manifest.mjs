#!/usr/bin/env node
/** Pack guard (spec §5.1): the published @ai-creed/ai-ezio manifest must have NO
 * dependencies, NO `workspace:` specifier in ANY section, only the four
 * @ai-creed/hax-* under optionalDependencies, and a preserved haxBaseCommit +
 * exports. No leaked @ai-ezio/* internal libs anywhere.
 *
 * Two modes:
 *   (default) pack the tarball via `npm pack` and assert on the tarball manifest.
 *   --ondisk  assert on packages/cli/package.json AS IT IS ON DISK — i.e. the exact
 *             bytes `npm publish` uploads as the REGISTRY manifest. The publish job
 *             runs this AFTER applying make-publish-manifest, so it catches the
 *             beta.1 regression where the registry metadata kept `workspace:*`. The
 *             tarball check alone cannot catch it: prepack rewrites the tarball but
 *             npm captures the registry manifest before prepack runs. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_HAX = [
	"@ai-creed/hax-darwin-arm64",
	"@ai-creed/hax-darwin-x64",
	"@ai-creed/hax-linux-arm64",
	"@ai-creed/hax-linux-x64",
];

/** Assert a parsed package.json is a clean, publishable single-package manifest.
 * Returns a list of human-readable problems (empty == OK). Shared by the tarball
 * and on-disk checks so they enforce identical rules. */
export function assertPublishable(pkg) {
	const errors = [];

	// (a) zero `workspace:` ANYWHERE — scan the WHOLE JSON, not just the dependency
	// fields (covers pnpm.overrides, resolutions, bundleDependencies, etc.).
	if (JSON.stringify(pkg).includes("workspace:"))
		errors.push("a `workspace:` specifier is present somewhere in the manifest");

	// (b) zero runtime dependencies
	if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0)
		errors.push(`dependencies must be empty, found: ${Object.keys(pkg.dependencies)}`);

	// (c) per-section: workspace: specifiers, leaked @ai-ezio/* libs, and @ai-creed/*
	// anywhere other than optionalDependencies. Internal @ai-ezio/* libs are bundled
	// into the dist (never shipped as deps), so a leaked one in ANY section is a bug.
	for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
		for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
			if (String(spec).startsWith("workspace:")) errors.push(`workspace: specifier in ${section}: ${name}@${spec}`);
			if (name.startsWith("@ai-ezio/")) errors.push(`leaked @ai-ezio/* internal lib in ${section}: ${section}.${name}`);
			if (section !== "optionalDependencies" && name.startsWith("@ai-creed/"))
				errors.push(`@ai-creed/* outside optionalDependencies: ${section}.${name}`);
		}
	}

	// (d) optionalDependencies == exactly the four hax packages
	const opt = Object.keys(pkg.optionalDependencies ?? {}).sort();
	if (opt.join(",") !== [...EXPECTED_HAX].sort().join(","))
		errors.push(`optionalDependencies != the 4 hax packages: ${opt}`);

	// (e) metadata preserved
	if (!pkg.haxBaseCommit) errors.push("haxBaseCommit missing from manifest");
	if (!pkg.exports) errors.push("exports missing from manifest");

	return errors;
}

function fail(errors) {
	console.error("PACK GUARD FAIL:\n  " + errors.join("\n  "));
	process.exit(1);
}

/** Assert on packages/cli/package.json exactly as npm will read it for the registry
 * manifest. Run from the repo root, AFTER make-publish-manifest has been applied. */
function checkOnDisk() {
	const pkg = JSON.parse(readFileSync(join("packages", "cli", "package.json"), "utf8"));
	const errors = assertPublishable(pkg);
	if (errors.length) fail(errors);
	console.log("PACK GUARD PASS (--ondisk): packages/cli/package.json is a clean, publishable registry manifest");
}

function checkTarball() {
	const cli = "packages/cli";
	const work = mkdtempSync(join(tmpdir(), "ai-ezio-pack-"));
	try {
		// `npm pack` runs prepack/postpack and, unlike `pnpm pack`, does NOT rewrite
		// `workspace:`, so a clean tarball also proves the generator pinned the versions.
		execFileSync("npm", ["pack", "--pack-destination", work], { cwd: cli, stdio: "inherit" });
		const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
		const pkg = JSON.parse(execFileSync("tar", ["-xzOf", join(work, tgz), "package/package.json"]).toString());
		const errors = assertPublishable(pkg);
		if (errors.length) fail(errors);
		console.log("PACK GUARD PASS: clean single-package tarball manifest, metadata preserved");
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

// CLI only when invoked directly (so assertPublishable can be imported by tests).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.includes("--ondisk")) checkOnDisk();
	else checkTarball();
}
