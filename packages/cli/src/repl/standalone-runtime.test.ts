import { describe, expect, it, vi } from "vitest";
import { createRenameController, createSessionTitleStore } from "@ai-ezio/harness";
import { runResumeFlow } from "@ai-ezio/surface";
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

describe("standalone wiring: RenameController + SlashContext capabilities", () => {
	it("noteEvent(ready) → currentSessionId captures the id", () => {
		const store = createSessionTitleStore({ fs: makeMemFs() });
		const rename = createRenameController({ store, requestStatus: () => {} });
		rename.noteEvent({ type: "ready", sessionId: "abc-123", protocolVersion: "1" } as never);
		expect(rename.currentSessionId()).toBe("abc-123");
	});

	it("setSessionTitle + getSessionTitle round-trip via the store", () => {
		const store = createSessionTitleStore({ fs: makeMemFs() });
		const rename = createRenameController({ store, requestStatus: () => {} });
		rename.noteEvent({ type: "ready", sessionId: "abc-123", protocolVersion: "1" } as never);
		rename.setSessionTitle("my session");
		expect(rename.getSessionTitle()).toBe("my session");
	});

	it("pending title is flushed when the id arrives later", () => {
		const store = createSessionTitleStore({ fs: makeMemFs() });
		const rename = createRenameController({ store, requestStatus: () => {} });
		// Title set before id is materialized (pending buffer).
		rename.setSessionTitle("deferred");
		expect(rename.currentSessionId()).toBeUndefined();
		// Id arrives → pending title is flushed to the store.
		rename.noteEvent({ type: "ready", sessionId: "def-456", protocolVersion: "1" } as never);
		expect(rename.currentSessionId()).toBe("def-456");
		expect(rename.getSessionTitle()).toBe("deferred");
	});

	it("noteNewConversation resets id + pending title", () => {
		const store = createSessionTitleStore({ fs: makeMemFs() });
		const rename = createRenameController({ store, requestStatus: () => {} });
		rename.noteEvent({ type: "ready", sessionId: "abc-123", protocolVersion: "1" } as never);
		rename.setSessionTitle("old title");
		rename.noteNewConversation();
		expect(rename.currentSessionId()).toBeUndefined();
		expect(rename.getSessionTitle()).toBeUndefined();
	});
});

describe("standalone wiring: resume thunk calls session.resume then host.start", () => {
	it("runResumeFlow wires resume(id) → session.resume(id) + host.start(session)", async () => {
		const store = createSessionTitleStore({ fs: makeMemFs() });
		const rename = createRenameController({ store, requestStatus: () => {} });
		// Seed an id so currentSessionId excludes the active session from the list.
		rename.noteEvent({ type: "ready", sessionId: "active-id", protocolVersion: "1" } as never);

		const sessionResume = vi.fn().mockResolvedValue(undefined);
		const hostStart = vi.fn().mockResolvedValue(undefined);
		const fakeSession = { resume: sessionResume };
		const fakeHost = { start: hostStart };

		// The target session to resume.
		const targetId = "target-00000000-0000-0000-0000-000000000001";
		const listJson = JSON.stringify([
			{ id: targetId, mtime: Date.now(), mtimeNsec: 0, firstPrompt: "hello" },
		]);

		// Simulate the overlay immediately selecting the first (only) entry.
		// We drive the overlay by calling `run` with a key stream that presses Enter.
		await runResumeFlow({
			write: () => {},
			isBusy: () => false,
			listSessions: async () => listJson,
			titles: () => store.loadTitles(),
			currentSessionId: () => rename.currentSessionId(),
			runOverlay: async (run) => {
				// Provide a key stream that sends Enter to confirm the pre-selected row.
				const keys: AsyncIterable<string> = {
					[Symbol.asyncIterator]: async function* () {
						yield "\r"; // Enter — confirm selection
					},
				};
				await run({ keys, write: () => {}, setRawMode: () => {} });
			},
			resume: async (id) => {
				await fakeSession.resume(id);
				await fakeHost.start(fakeSession);
			},
			onFatal: () => {},
			now: () => Date.now(),
		});

		expect(sessionResume).toHaveBeenCalledOnce();
		expect(sessionResume).toHaveBeenCalledWith(targetId);
		expect(hostStart).toHaveBeenCalledOnce();
		expect(hostStart).toHaveBeenCalledWith(fakeSession);
	});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** In-memory TitleFs for tests — avoids touching the real filesystem. */
function makeMemFs() {
	const files = new Map<string, string>();
	return {
		readFileSync: (p: string) => files.get(p),
		writeFileSync: (p: string, d: string) => void files.set(p, d),
		renameSync: (from: string, to: string) => {
			const v = files.get(from);
			if (v !== undefined) {
				files.set(to, v);
				files.delete(from);
			}
		},
		mkdirSync: () => {},
	};
}

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
