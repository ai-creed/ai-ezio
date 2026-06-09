#!/usr/bin/env node
/** Pre-publish gate (spec §5.1): every @ai-creed/hax-<os>-<cpu> package must carry
 * its binary. Run after the CI matrix has staged all four. */
import { existsSync, statSync } from "node:fs";
const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];
const missing = targets.filter((t) => {
	const p = `packaging/hax-${t}/bin/hax`;
	return !existsSync(p) || statSync(p).size === 0;
});
if (missing.length) {
	console.error(`MISSING platform binaries: ${missing.join(", ")}`);
	process.exit(1);
}
console.log("all four @ai-creed/hax-* binaries present");
