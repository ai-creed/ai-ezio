import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	isMountInvocation,
	isNativeSubcommand,
	launchEnv,
	mountStdio,
	parseResumeIntent,
	resumeHaxArgs,
	resumeSelfMount,
	stdinChunks,
	wantsVersionJson,
} from "./cli.js";
import { readVersionInfo } from "./version.js";

describe("wantsVersionJson", () => {
	it("is true only when both --version and --json are present", () => {
		expect(wantsVersionJson(["--version", "--json"])).toBe(true);
		expect(wantsVersionJson(["--json", "--version"])).toBe(true);
		expect(wantsVersionJson(["--version"])).toBe(false);
		expect(wantsVersionJson(["-p", "hello"])).toBe(false);
		expect(wantsVersionJson([])).toBe(false);
	});
});

describe("isNativeSubcommand", () => {
	it("intercepts skill and doctor, passes everything else to hax", () => {
		expect(isNativeSubcommand(["skill", "list"])).toBe(true);
		expect(isNativeSubcommand(["doctor"])).toBe(true);
		expect(isNativeSubcommand(["-p", "hi"])).toBe(false);
		expect(isNativeSubcommand([])).toBe(false);
	});
});

describe("isMountInvocation", () => {
	it("detects --mount-mode and protocol fds", () => {
		expect(isMountInvocation(["--mount-mode"])).toBe(true);
		expect(isMountInvocation(["--protocol-fd=3", "--control-fd=4"])).toBe(true);
		expect(isMountInvocation(["-p", "hi"])).toBe(false);
		expect(isMountInvocation([])).toBe(false);
	});
});

describe("parseResumeIntent", () => {
	it("recognizes -c / --continue as continue", () => {
		expect(parseResumeIntent(["-c"])).toEqual({ kind: "continue" });
		expect(parseResumeIntent(["--continue"])).toEqual({ kind: "continue" });
	});
	it("recognizes --resume=ID as a specific id", () => {
		expect(parseResumeIntent(["--resume=abc123"])).toEqual({ kind: "id", id: "abc123" });
	});
	it("treats bare --resume and empty --resume= as the picker", () => {
		expect(parseResumeIntent(["--resume"])).toEqual({ kind: "picker" });
		expect(parseResumeIntent(["--resume="])).toEqual({ kind: "picker" });
	});
	it("returns undefined when no resume token is present", () => {
		expect(parseResumeIntent([])).toBeUndefined();
		expect(parseResumeIntent(["-p", "hi"])).toBeUndefined();
		expect(parseResumeIntent(["--help"])).toBeUndefined();
	});
});

describe("resumeSelfMount", () => {
	it("fires only for a single bare resume token", () => {
		expect(resumeSelfMount(["--continue"])).toEqual({ kind: "continue" });
		expect(resumeSelfMount(["-c"])).toEqual({ kind: "continue" });
		expect(resumeSelfMount(["--resume=abc"])).toEqual({ kind: "id", id: "abc" });
		expect(resumeSelfMount(["--resume"])).toEqual({ kind: "picker" });
	});
	it("does not hijack combined invocations (one-shot / mount / extra flags)", () => {
		expect(resumeSelfMount(["-p", "x", "--continue"])).toBeUndefined();
		expect(resumeSelfMount(["--mount-mode", "--continue"])).toBeUndefined();
		expect(resumeSelfMount(["--continue", "--raw"])).toBeUndefined();
		expect(resumeSelfMount([])).toBeUndefined();
	});
});

describe("resumeHaxArgs", () => {
	it("maps continue/id to a hax flag and picker to none", () => {
		expect(resumeHaxArgs({ kind: "continue" })).toEqual(["--continue"]);
		expect(resumeHaxArgs({ kind: "id", id: "abc" })).toEqual(["--resume=abc"]);
		expect(resumeHaxArgs({ kind: "picker" })).toEqual([]);
	});
});

describe("stdinChunks (resume picker → REPL stdin handoff)", () => {
	it("leaves stdin alive when the picker stops consuming, so the mounted REPL still gets input", async () => {
		const s = new PassThrough();
		const gen = stdinChunks(s as unknown as NodeJS.ReadStream);

		s.write("a");
		expect((await gen.next()).value).toBe("a");

		// Picker selects/cancels → stop consuming. A default `for await` would
		// destroy the stream here and EOF the REPL that mounts next.
		await gen.return(undefined);
		expect(s.destroyed).toBe(false);

		// The next consumer (the REPL) still receives keystrokes.
		s.write("b");
		const got: string[] = [];
		for await (const c of s) {
			got.push(c.toString("utf8"));
			break;
		}
		expect(got).toEqual(["b"]);
	});
});

describe("mountStdio", () => {
	it("inherits 0/1/2 plus exactly the named protocol fds", () => {
		const s = mountStdio(["--mount-mode", "--protocol-fd=3", "--control-fd=4"]);
		expect(s.length).toBe(5);
		expect(s[0]).toBe("inherit");
		expect(s[3]).toBe("inherit"); // protocol fd forwarded
		expect(s[4]).toBe("inherit"); // control fd forwarded
	});
});

describe("launchEnv (CLI sets HAX_EXTRA_SKILLS_DIR)", () => {
	it("adds HAX_EXTRA_SKILLS_DIR to the child env", () => {
		const env = launchEnv({ XDG_CONFIG_HOME: "/xdg" });
		expect(env.HAX_EXTRA_SKILLS_DIR).toBe("/xdg/ai-ezio/skills");
	});
});

describe("readVersionInfo", () => {
	it("reports the ezio version and the pinned hax base commit", () => {
		const info = readVersionInfo();
		expect(info.ezioVersion).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/); // allow prerelease (e.g. 0.1.0-beta.0)
		expect(info.haxBaseCommit).toBe("2d98651a617ad520b7d8b4da46c185b54b8f190c");
	});
});
