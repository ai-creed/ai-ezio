/**
 * Binary lookup resolver (architecture.md "Binary lookup resolver").
 *
 * Resolution order:
 *   1. AI_EZIO_HAX_BIN env override (dev / CI / tests)
 *   2. matching @ai-ezio/hax-<platform>-<arch> package via require.resolve
 *   3. local vendor/hax/build/hax dev fallback (after `meson compile`)
 *
 * If none resolve, throw HaxBinaryNotFoundError pointing at `ai-ezio doctor`.
 *
 * Every external dependency (env, fs, package resolution, dev-root discovery) is
 * injectable so the three branches and the miss are unit-testable without a real
 * filesystem.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export class HaxBinaryNotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HaxBinaryNotFoundError";
	}
}

export interface ResolveHaxOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	arch?: string;
	/** Test seam: existence check. Defaults to fs.existsSync. */
	fileExists?: (path: string) => boolean;
	/** Test seam: resolve a package.json path. Defaults to require.resolve. */
	resolvePackageJson?: (specifier: string) => string;
	/** Test seam: repo root that contains vendor/hax/build/hax. */
	devRoot?: string | undefined;
}

/** The npm package name carrying the prebuilt hax binary for a platform. */
export function platformPackageName(platform: string, arch: string): string {
	return `@ai-ezio/hax-${platform}-${arch}`;
}

function defaultResolvePackageJson(specifier: string): string {
	const require = createRequire(import.meta.url);
	return require.resolve(specifier);
}

/** Walk up from this module looking for a built vendor/hax/build/hax (dev mode). */
function findDevRoot(): string | undefined {
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 12; i++) {
		if (existsSync(join(dir, "vendor", "hax", "build", "hax"))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

export function resolveHaxBinary(options: ResolveHaxOptions = {}): string {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const fileExists = options.fileExists ?? existsSync;
	const resolvePackageJson = options.resolvePackageJson ?? defaultResolvePackageJson;

	const attempts: string[] = [];

	// 1. explicit override
	const override = env.AI_EZIO_HAX_BIN;
	if (override !== undefined && override !== "") {
		if (fileExists(override)) return override;
		throw new HaxBinaryNotFoundError(
			`AI_EZIO_HAX_BIN is set to "${override}" but no file exists there.`,
		);
	}
	attempts.push("AI_EZIO_HAX_BIN (unset)");

	// 2. platform binary package
	const pkg = platformPackageName(platform, arch);
	try {
		const pkgJson = resolvePackageJson(`${pkg}/package.json`);
		const bin = join(dirname(pkgJson), "bin", "hax");
		if (fileExists(bin)) return bin;
		attempts.push(`${pkg} (resolved, but ${bin} missing)`);
	} catch {
		attempts.push(`${pkg} (not installed)`);
	}

	// 3. dev fallback
	const devRoot = "devRoot" in options ? options.devRoot : findDevRoot();
	if (devRoot !== undefined) {
		const devBin = join(devRoot, "vendor", "hax", "build", "hax");
		if (fileExists(devBin)) return devBin;
		attempts.push(`${devBin} (dev fallback missing)`);
	} else {
		attempts.push("vendor/hax/build/hax (no dev root)");
	}

	throw new HaxBinaryNotFoundError(
		`Could not locate the hax binary. Tried: ${attempts.join("; ")}. ` +
			`Run "ai-ezio doctor" for help.`,
	);
}
