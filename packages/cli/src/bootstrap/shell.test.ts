import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shellSingleQuote } from "./shell.js";

describe("shellSingleQuote", () => {
	it("escapes embedded single quotes", () => expect(shellSingleQuote("/a'b")).toBe(`'/a'\\''b'`));
	it.each(["/tmp/AI Ezio/hax", "/p/$HOME/x", '/p/"q"/h', "/p/`cmd`/h", "/a'b/hax"])(
		"round-trips %s exactly under sh and zsh",
		(value) => {
			for (const sh of ["sh", "zsh"]) {
				const out = execFileSync(sh, ["-c", `printf %s ${shellSingleQuote(value)}`], {
					encoding: "utf8",
				});
				expect(out).toBe(value);
			}
		},
	);
});
