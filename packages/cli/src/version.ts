/** ai-ezio version metadata, read from this package's package.json. */
import { createRequire } from "node:module";

interface CliPackageMeta {
	version: string;
	haxBaseCommit?: string;
}

export interface VersionInfo {
	ezioVersion: string;
	haxBaseCommit: string;
}

/** Read ezio version + pinned hax base commit from this package's package.json. */
export function readVersionInfo(): VersionInfo {
	const require = createRequire(import.meta.url);
	const pkg = require("../package.json") as CliPackageMeta;
	return {
		ezioVersion: pkg.version,
		haxBaseCommit: pkg.haxBaseCommit ?? "unknown",
	};
}
