import { describe, expect, it } from "vitest";
import { resumeNotice, startWithTranscript } from "./standalone-runtime.js";

/** Minimal shape of the SpawnHaxOptions the helper forwards — avoids coupling
 * the test to the harness package's export surface. */
type StartOpts = { args?: string[]; transcriptPath?: string };

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

describe("startWithTranscript (pre-spawn ordering)", () => {
	it("mints the path, creates the dir, then starts with transcriptPath — before any ready-dependent work", async () => {
		const order: string[] = [];
		let startedWith: StartOpts | undefined;
		const path = await startWithTranscript(
			{
				start: async (o: StartOpts) => {
					order.push("start");
					startedWith = o;
					return {} as never;
				},
			} as never,
			{
				stateDir: "/state",
				repoKey: "repo-x",
				mintId: () => "fixed-id",
				ensureDir: (dir) => void order.push(`mkdir:${dir}`),
			},
		);
		expect(path).toBe("/state/transcripts/repo-x/fixed-id.txt");
		expect(startedWith?.transcriptPath).toBe(path);
		// The directory is created BEFORE start is called, and the path is finalized
		// from the caller-minted id — no dependency on ready.sessionId.
		expect(order).toEqual(["mkdir:/state/transcripts/repo-x", "start"]);
	});

	it("forwards resumeArgs alongside the transcriptPath", async () => {
		let startedWith: StartOpts | undefined;
		await startWithTranscript(
			{
				start: async (o: StartOpts) => {
					startedWith = o;
					return {} as never;
				},
			} as never,
			{
				stateDir: "/s",
				repoKey: "r",
				resumeArgs: ["--continue"],
				mintId: () => "id",
				ensureDir: () => {},
			},
		);
		expect(startedWith?.args).toEqual(["--continue"]);
		expect(startedWith?.transcriptPath).toBe("/s/transcripts/r/id.txt");
	});
});
