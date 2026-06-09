#!/usr/bin/env node
/** Pack guard (spec §5.1): the published @ai-creed/ai-ezio tarball must have NO
 * dependencies, NO workspace:* specifier in ANY section, only the four
 * @ai-creed/hax-* under optionalDependencies, and a preserved haxBaseCommit +
 * exports. No leaked @ai-ezio/* internal libs anywhere. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = "packages/cli";
const work = mkdtempSync(join(tmpdir(), "ai-ezio-pack-"));
try {
	// `npm pack` (spec §7) — runs prepack/postpack and, unlike `pnpm pack`, does NOT
	// rewrite `workspace:`, so this also proves the generator pinned the hax versions.
	execFileSync("npm", ["pack", "--pack-destination", work], { cwd: cli, stdio: "inherit" });
	const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
	const pkg = JSON.parse(execFileSync("tar", ["-xzOf", join(work, tgz), "package/package.json"]).toString());
	const errors = [];

	// (a) zero `workspace:` ANYWHERE in the manifest — scan the WHOLE JSON, not just
	// the dependency fields (the spec's "no workspace specifiers anywhere" includes
	// pnpm.overrides, resolutions, bundleDependencies, etc.).
	if (JSON.stringify(pkg).includes("workspace:"))
		errors.push("a `workspace:` specifier is present somewhere in the published manifest");

	// (b) zero runtime dependencies
	if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0)
		errors.push(`dependencies must be empty, found: ${Object.keys(pkg.dependencies)}`);

	// (c) precise per-section messages for the common dep fields. The four
	// @ai-creed/hax-* binary packages are the ONLY scoped deps allowed, and only
	// under optionalDependencies. Internal @ai-ezio/* libs are bundled into the
	// dist (never shipped as deps), so a leaked @ai-ezio/* in ANY section is a bug.
	for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
		for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
			if (String(spec).startsWith("workspace:")) errors.push(`workspace: specifier in ${section}: ${name}@${spec}`);
			if (name.startsWith("@ai-ezio/"))
				errors.push(`leaked @ai-ezio/* internal lib in ${section}: ${section}.${name}`);
			if (section !== "optionalDependencies" && name.startsWith("@ai-creed/"))
				errors.push(`@ai-creed/* outside optionalDependencies: ${section}.${name}`);
		}
	}

	// (c) optionalDependencies == exactly the four hax packages
	const expected = ["@ai-creed/hax-darwin-arm64", "@ai-creed/hax-darwin-x64", "@ai-creed/hax-linux-arm64", "@ai-creed/hax-linux-x64"];
	const opt = Object.keys(pkg.optionalDependencies ?? {}).sort();
	if (opt.join(",") !== expected.sort().join(",")) errors.push(`optionalDependencies != the 4 hax packages: ${opt}`);

	// (d) metadata preserved
	if (!pkg.haxBaseCommit) errors.push("haxBaseCommit missing from published manifest");
	if (!pkg.exports) errors.push("exports missing from published manifest");

	if (errors.length) {
		console.error("PACK GUARD FAIL:\n  " + errors.join("\n  "));
		process.exit(1);
	}
	console.log("PACK GUARD PASS: clean single-package manifest, metadata preserved");
} finally {
	rmSync(work, { recursive: true, force: true });
}
