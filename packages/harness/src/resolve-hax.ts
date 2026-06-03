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

/** Which resolution branch produced the binary path. */
export type HaxBinarySource = "env-override" | "platform-package" | "dev-fallback";

/** The outcome of attempting to locate the hax binary, without throwing. */
export interface HaxResolution {
	ok: boolean;
	/** Absolute path to the binary when `ok`. */
	path?: string;
	/** Which branch matched when `ok`. */
	source?: HaxBinarySource;
	/** Human-readable trace of every branch tried (for `ai-ezio doctor`). */
	attempts: string[];
	/** Error message when not `ok`. */
	error?: string;
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

/**
 * Locate the hax binary, reporting the full resolution trace instead of
 * throwing. `ai-ezio doctor` uses this to explain what matched (or why nothing
 * did); `resolveHaxBinary` wraps it for the spawn path.
 */
export function describeHaxBinary(options: ResolveHaxOptions = {}): HaxResolution {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const fileExists = options.fileExists ?? existsSync;
	const resolvePackageJson = options.resolvePackageJson ?? defaultResolvePackageJson;

	const attempts: string[] = [];

	// 1. explicit override
	const override = env.AI_EZIO_HAX_BIN;
	if (override !== undefined && override !== "") {
		if (fileExists(override)) {
			attempts.push(`AI_EZIO_HAX_BIN=${override} (exists)`);
			return { ok: true, path: override, source: "env-override", attempts };
		}
		attempts.push(`AI_EZIO_HAX_BIN=${override} (missing)`);
		return {
			ok: false,
			attempts,
			error: `AI_EZIO_HAX_BIN is set to "${override}" but no file exists there.`,
		};
	}
	attempts.push("AI_EZIO_HAX_BIN (unset)");

	// 2. platform binary package
	const pkg = platformPackageName(platform, arch);
	try {
		const pkgJson = resolvePackageJson(`${pkg}/package.json`);
		const bin = join(dirname(pkgJson), "bin", "hax");
		if (fileExists(bin)) {
			attempts.push(`${pkg} (found ${bin})`);
			return { ok: true, path: bin, source: "platform-package", attempts };
		}
		attempts.push(`${pkg} (resolved, but ${bin} missing)`);
	} catch {
		attempts.push(`${pkg} (not installed)`);
	}

	// 3. dev fallback
	const devRoot = "devRoot" in options ? options.devRoot : findDevRoot();
	if (devRoot !== undefined) {
		const devBin = join(devRoot, "vendor", "hax", "build", "hax");
		if (fileExists(devBin)) {
			attempts.push(`${devBin} (dev fallback)`);
			return { ok: true, path: devBin, source: "dev-fallback", attempts };
		}
		attempts.push(`${devBin} (dev fallback missing)`);
	} else {
		attempts.push("vendor/hax/build/hax (no dev root)");
	}

	return {
		ok: false,
		attempts,
		error: `Could not locate the hax binary. Tried: ${attempts.join("; ")}.`,
	};
}

export function resolveHaxBinary(options: ResolveHaxOptions = {}): string {
	const result = describeHaxBinary(options);
	if (result.ok && result.path !== undefined) return result.path;
	throw new HaxBinaryNotFoundError(`${result.error} Run "ai-ezio doctor" for help.`);
}
