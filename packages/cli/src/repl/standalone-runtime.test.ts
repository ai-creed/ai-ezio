import { describe, expect, it, vi } from "vitest";
import { createRenameController, createSessionTitleStore } from "@ai-ezio/harness";
import { buildStandaloneResumeDeps, resumeNotice, startWithTranscript } from "./standalone-runtime.js";

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

describe("standalone wiring: buildStandaloneResumeDeps (production resume path)", () => {
	function fakes() {
		const store = createSessionTitleStore({ fs: makeMemFs() });
		const rename = createRenameController({ store, requestStatus: () => {} });
		const order: string[] = [];
		const written: string[] = [];
		const sessionResume = vi.fn(async (_id: string) => {
			order.push("session.resume");
			return {} as never;
		});
		const hostStart = vi.fn(async () => {
			order.push("host.start");
		});
		const fakeSession = { resume: sessionResume };
		const fakeHost = { start: hostStart };
		const keyReturn = vi.fn(async () => ({ done: true as const, value: undefined }));
		const keyIterator = { return: keyReturn } as unknown as AsyncGenerator<string>;
		const deps = buildStandaloneResumeDeps({
			session: fakeSession as never,
			host: fakeHost as never,
			titleStore: store,
			rename,
			keyIterator,
			write: (s) => void written.push(s),
			listSessions: async () => "[]",
		});
		return { deps, order, written, sessionResume, hostStart, keyReturn, rename };
	}

	it("resume(id) calls session.resume(id) THEN host.start(session) and writes the resume notice", async () => {
		const { deps, order, written, sessionResume, hostStart } = fakes();
		await deps.resume("13c018d5-7e61-4bb6-809d-eba3d76a2b19");
		expect(sessionResume).toHaveBeenCalledWith("13c018d5-7e61-4bb6-809d-eba3d76a2b19");
		// Order matters (spec §3 post-respawn re-wiring): respawn, THEN re-register tools.
		expect(order).toEqual(["session.resume", "host.start"]);
		expect(hostStart).toHaveBeenCalledOnce();
		expect(written.join("")).toContain("resumed session 13c018d5"); // resume notice printed
	});

	it("onFatal() ends the REPL loop by returning the shared key iterator", () => {
		const { deps, keyReturn } = fakes();
		deps.onFatal();
		expect(keyReturn).toHaveBeenCalledOnce();
	});

	it("isBusy is false; titles + currentSessionId delegate to the store/controller", () => {
		const { deps, rename } = fakes();
		expect(deps.isBusy()).toBe(false);
		rename.noteEvent({ type: "ready", sessionId: "abc", protocolVersion: "1" } as never);
		expect(deps.currentSessionId()).toBe("abc");
		rename.setSessionTitle("t");
		expect([...deps.titles().values()]).toContain("t");
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
