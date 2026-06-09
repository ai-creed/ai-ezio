#!/usr/bin/env node
// Unscoped convenience alias for @ai-creed/ai-ezio. Installing `ai-ezio` pulls in
// the scoped CLI (and its hax binary) and forwards argv to its main().
import { main } from "@ai-creed/ai-ezio";

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(error) => {
		process.stderr.write(`ai-ezio: ${error?.stack ?? error}\n`);
		process.exit(1);
	},
);
