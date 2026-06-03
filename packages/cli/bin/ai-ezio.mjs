#!/usr/bin/env node
// ai-ezio entrypoint. Thin shim so the bin has a stable shebang; all logic lives
// in the compiled launcher (dist/cli.js).
import { main } from "../dist/cli.js";

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(error) => {
		process.stderr.write(`ai-ezio: ${error?.stack ?? error}\n`);
		process.exit(1);
	},
);
