import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shellSingleQuote } from "./shell.js";

// POSIX single-quoting is shell-agnostic; exercise it in whatever shells are
// actually installed. `sh` is always present; bash/zsh vary (e.g. zsh is NOT on
// the ubuntu CI runner — spawning it unconditionally is an ENOENT).
const AVAILABLE_SHELLS = ["sh", "bash", "zsh"].filter((sh) => {
	try {
		execFileSync("sh", ["-c", `command -v ${sh}`], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
});

describe("shellSingleQuote", () => {
	it("escapes embedded single quotes", () => expect(shellSingleQuote("/a'b")).toBe(`'/a'\\''b'`));
	it.each(["/tmp/AI Ezio/hax", "/p/$HOME/x", '/p/"q"/h', "/p/`cmd`/h", "/a'b/hax"])(
		"round-trips %s exactly under the installed shells",
		(value) => {
			for (const sh of AVAILABLE_SHELLS) {
				const out = execFileSync(sh, ["-c", `printf %s ${shellSingleQuote(value)}`], {
					encoding: "utf8",
				});
				expect(out).toBe(value);
			}
		},
	);
});
