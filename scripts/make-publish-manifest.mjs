#!/usr/bin/env node
/** Generate the published @ai-creed/ai-ezio package.json (spec §5.1): preserve
 * name/version/bin/files/type/exports/haxBaseCommit/description/license/
 * publishConfig + the four @ai-creed/hax-* optionalDependencies; strip
 * dependencies + devDependencies so the tarball AND the registry manifest carry
 * NO @ai-ezio/* runtime deps and NO workspace:* anywhere.
 *
 * CRITICAL (the beta.1 bug): `npm publish` captures the REGISTRY manifest from
 * package.json BEFORE `prepack` runs, so transforming it in prepack only fixes the
 * tarball — the registry metadata keeps `workspace:*` and `npm install` then fails
 * with EUNSUPPORTEDPROTOCOL (fatal even for optionalDependencies — an unparseable
 * protocol throws before optionality is considered). The publish job therefore
 * runs this generator to mutate package.json ON DISK *before* invoking
 * `npm publish`. `apply` is idempotent, so the prepack hook re-running it is a
 * harmless no-op that preserves the dev backup. `restore` swaps the dev manifest
 * back. */
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Build the published manifest object from a dev manifest. Pure: reads each hax
 * platform package's concrete version from <repoRoot>/packaging/<name>/package.json
 * and pins the optionalDependencies to it (npm does NOT rewrite `workspace:` the
 * way pnpm does). Idempotent — it rebuilds from scratch, so re-running on an
 * already published manifest yields the same object. */
export function buildPublishedManifest(pkg, repoRoot) {
	const optionalDependencies = {};
	for (const name of Object.keys(pkg.optionalDependencies ?? {})) {
		const dir = name.replace("@ai-creed/", ""); // @ai-creed/hax-darwin-arm64 -> hax-darwin-arm64
		const haxPkg = JSON.parse(readFileSync(join(repoRoot, "packaging", dir, "package.json"), "utf8"));
		optionalDependencies[name] = haxPkg.version;
	}
	return {
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
		optionalDependencies,
	};
}

/** A manifest is already in published shape when it has no devDependencies and no
 * `workspace:` specifier remains — re-applying then is a no-op (and must NOT
 * re-create the backup, or it would clobber the real dev manifest). */
function isPublishedShape(pkg) {
	return !pkg.devDependencies && !JSON.stringify(pkg).includes("workspace:");
}

function main() {
	// cwd = the package dir being packed (npm/pnpm set it for prepack/postpack), so
	// the manifest is ./package.json THERE — resolve from cwd, not a hardcoded path
	// (a literal "packages/cli/package.json" would double-nest when cwd is already
	// packages/cli).
	const manifest = join(process.cwd(), "package.json");
	const backup = join(process.cwd(), "package.json.dev");

	if (process.argv[2] === "restore") {
		if (existsSync(backup)) {
			copyFileSync(backup, manifest);
			rmSync(backup);
		}
		return;
	}

	const pkg = JSON.parse(readFileSync(manifest, "utf8"));
	if (isPublishedShape(pkg)) {
		// Already applied (e.g. the publish job mutated it on disk and prepack is now
		// re-running). Leave the existing backup intact.
		console.log("publish manifest already applied; nothing to do");
		return;
	}
	copyFileSync(manifest, backup);
	const repoRoot = join(process.cwd(), "..", "..");
	const published = buildPublishedManifest(pkg, repoRoot);
	writeFileSync(manifest, `${JSON.stringify(published, null, "\t")}\n`);
	console.log("wrote published manifest (deps/devDeps stripped; hax optionalDeps pinned; haxBaseCommit + exports preserved)");
}

// Run as a CLI only when invoked directly, so importing the pure helpers above is
// side-effect-free (the reproduction test imports buildPublishedManifest).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
