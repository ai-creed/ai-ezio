#!/usr/bin/env node
/** Generate the published package.json (spec §5.1): preserve name/version/bin/
 * files/type/exports/haxBaseCommit/description/license/publishConfig + the four
 * @ai-ezio/hax-* optionalDependencies; strip dependencies + devDependencies so
 * the tarball carries NO @ai-ezio/* runtime deps and NO workspace:* anywhere.
 * Backs up the dev manifest to package.json.dev; `restore` swaps it back. */
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// pnpm runs prepack/postpack with cwd = the package dir being packed, so the
// manifest is ./package.json THERE — resolve from cwd, not a hardcoded repo path
// (a literal "packages/cli/package.json" would wrongly become
// packages/cli/packages/cli/package.json when cwd is already packages/cli).
const manifest = join(process.cwd(), "package.json");
const backup = join(process.cwd(), "package.json.dev");

if (process.argv[2] === "restore") {
	if (existsSync(backup)) {
		copyFileSync(backup, manifest);
		rmSync(backup);
	}
	process.exit(0);
}

const pkg = JSON.parse(readFileSync(manifest, "utf8"));
copyFileSync(manifest, backup);

// Rewrite the four @ai-ezio/hax-* optionalDependencies from `workspace:*` to each
// platform package's CONCRETE version. `npm pack` (the real publish path, per spec
// §7) does NOT rewrite `workspace:` the way `pnpm pack` does, so leaving them would
// ship an uninstallable manifest with a `workspace:` specifier.
const repoRoot = join(process.cwd(), "..", "..");
function pinnedOptionalDeps(optDeps) {
	const out = {};
	for (const name of Object.keys(optDeps ?? {})) {
		const dir = name.replace("@ai-ezio/", ""); // @ai-ezio/hax-darwin-arm64 -> hax-darwin-arm64
		out[name] = JSON.parse(readFileSync(join(repoRoot, "packaging", dir, "package.json"), "utf8")).version;
	}
	return out;
}

const published = {
	name: pkg.name,
	version: pkg.version,
	description: pkg.description,
	license: pkg.license,
	type: pkg.type,
	bin: pkg.bin,
	exports: pkg.exports,
	files: pkg.files,
	haxBaseCommit: pkg.haxBaseCommit,
	publishConfig: pkg.publishConfig,
	optionalDependencies: pinnedOptionalDeps(pkg.optionalDependencies),
};
writeFileSync(manifest, `${JSON.stringify(published, null, "\t")}\n`);
console.log("wrote published manifest (deps/devDeps stripped; haxBaseCommit + exports preserved)");
