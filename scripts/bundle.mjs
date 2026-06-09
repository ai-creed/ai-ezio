#!/usr/bin/env node
/** Bundle the CLI + its @ai-ezio/* workspace libs (and pure-JS third-party deps)
 * into one dist, leaving only @ai-ezio/hax-* external (spec §5.1). */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = `${dirname(dirname(fileURLToPath(import.meta.url)))}/packages/cli`;
await build({
	entryPoints: [join(cliRoot, "src/cli.ts")],
	outfile: join(cliRoot, "dist/cli.js"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node20",
	external: ["@ai-ezio/hax-darwin-arm64", "@ai-ezio/hax-darwin-x64", "@ai-ezio/hax-linux-x64", "@ai-ezio/hax-linux-arm64"],
	banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
console.log("bundled packages/cli/dist/cli.js");
