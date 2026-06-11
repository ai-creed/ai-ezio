import { describe, expect, it } from "vitest";
import { resumeNotice } from "./standalone-runtime.js";

describe("resumeNotice", () => {
	it("is undefined for a fresh (non-resume) launch", () => {
		expect(resumeNotice(undefined)).toBeUndefined();
		expect(resumeNotice([])).toBeUndefined();
	});

	it("names the most recent session for --continue", () => {
		const n = resumeNotice(["--continue"]);
		expect(n).toContain("resumed most recent session");
		expect(n).toContain("history loaded as context");
		expect(n?.endsWith("\n")).toBe(true);
	});

	it("shows a short id for --resume=ID", () => {
		const n = resumeNotice(["--resume=13c018d5-7e61-4bb6-809d-eba3d76a2b19"]);
		expect(n).toContain("resumed session 13c018d5"); // truncated to 8 chars
		expect(n).not.toContain("eba3d76a"); // not the full uuid
	});
});
