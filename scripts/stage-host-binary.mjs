#!/usr/bin/env node
// Copy the locally-built hax binary into the host platform package so that
// `pnpm pack`/install resolves the engine from the @ai-creed/hax-<os>-<cpu>
// package (the real distribution path) rather than the dev fallback.
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(repoRoot, "vendor", "hax", "build", "hax");

if (!existsSync(src)) {
	console.error(`hax binary not built at ${src}. Run: meson compile -C vendor/hax/build`);
	process.exit(1);
}

const pkgName = `hax-${process.platform}-${process.arch}`;
const destDir = join(repoRoot, "packaging", pkgName, "bin");
mkdirSync(destDir, { recursive: true });
const dest = join(destDir, "hax");
copyFileSync(src, dest);
chmodSync(dest, 0o755);
console.log(`staged ${src} -> ${dest}`);
