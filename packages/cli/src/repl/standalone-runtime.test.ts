import { describe, expect, it, vi } from "vitest";
import { createRenameController, createSessionTitleStore } from "@ai-ezio/harness";
import { decodeChunk } from "@ai-ezio/surface";
import {
	buildStandaloneKeySources,
	buildStandaloneResumeDeps,
	makeStandaloneOverlay,
	resumeNotice,
	startWithTranscript,
} from "./standalone-runtime.js";

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
		const fakeSubagentHost = { start: vi.fn() };
		const keyReturn = vi.fn(async () => ({ done: true as const, value: undefined }));
		const chunkSource = { return: keyReturn } as unknown as AsyncGenerator<string>;
		const deps = buildStandaloneResumeDeps({
			session: fakeSession as never,
			host: fakeHost as never,
			subagentHost: fakeSubagentHost as never,
			titleStore: store,
			rename,
			chunkSource,
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

	it("onFatal() ends the REPL loop by returning the shared chunk source", () => {
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

	it("resume re-registers tools in order: session.resume -> host.start -> subagentHost.start", async () => {
		const order: string[] = [];
		const store = createSessionTitleStore({ fs: makeMemFs() });
		const rename = createRenameController({ store, requestStatus: () => {} });
		const session = {
			resume: vi.fn(async () => {
				order.push("session.resume");
				return {} as never;
			}),
		};
		const host = {
			start: vi.fn(async () => {
				order.push("host.start");
			}),
		};
		const subagentHost = {
			start: vi.fn(() => {
				order.push("subagentHost.start");
			}),
			handleEvent: async () => {},
			stop: async () => {},
		};
		const deps = buildStandaloneResumeDeps({
			session: session as never,
			host: host as never,
			subagentHost: subagentHost as never,
			titleStore: store,
			rename,
			chunkSource: {
				return: vi.fn(async () => ({ done: true as const, value: undefined })),
			} as never,
			write: () => {},
			listSessions: async () => "[]",
		});
		await deps.resume("13c018d5-7e61-4bb6-809d-eba3d76a2b19");
		// Re-registration order: respawn, THEN MCP tools, THEN the subagent tool.
		expect(order).toEqual(["session.resume", "host.start", "subagentHost.start"]);
		expect(subagentHost.start).toHaveBeenCalledOnce();
	});
});

describe("buildStandaloneKeySources (shared stdin chunking)", () => {
	/** A fake whole-chunk stdin source: yields each chunk intact, exactly the way
	 * production `stdinChunks` does (escape sequences arrive whole). */
	async function* fakeChunkSource(chunks: string[]): AsyncGenerator<string> {
		for (const c of chunks) yield c;
	}

	async function collect(it: AsyncIterable<string>): Promise<string[]> {
		const out: string[] = [];
		for await (const x of it) out.push(x);
		return out;
	}

	it("borrowChunks() hands the picker WHOLE chunks — a Down arrow stays one item, decoded as nav (not cancel)", async () => {
		// The regression: the standalone overlay used to borrow a per-code-point
		// iterator, so a Down arrow ("\x1b[B") arrived split across three reads and
		// decodeChunk("\x1b") fired "cancel" on the first byte. The shared whole-chunk
		// source must deliver "\x1b[B" as ONE item so the picker sees a navigation key.
		const { borrowChunks } = buildStandaloneKeySources(fakeChunkSource(["\x1b[B", "\r"]));
		const items = await collect(borrowChunks());
		expect(items).toEqual(["\x1b[B", "\r"]); // chunks intact — NOT split into bytes
		expect(decodeChunk(items[0]!)).toBe("down"); // a nav key, NOT "cancel"
		expect(decodeChunk(items[1]!)).toBe("enter");
	});

	it("borrowChunks() passes the pagination keys through whole ([ ] and Ctrl+A)", () => {
		// Single-byte keys can't be split; this guards that the standalone whole-chunk
		// source delivers them intact so the picker's decodeChunk reads them directly.
		const { borrowChunks } = buildStandaloneKeySources(fakeChunkSource(["[", "]", "\x01"]));
		return collect(borrowChunks()).then((items) => {
			expect(items).toEqual(["[", "]", "\x01"]);
			expect(items.map((c) => decodeChunk(c))).toEqual(["pageprev", "pagenext", "toggleall"]);
		});
	});

	it("replKeys splits chunks into code points for the line reader (feedKey's ESC accumulator)", async () => {
		// The line reader must still see one code point at a time so feedKey can run
		// its own multi-byte ESC handling — preserved, just sourced from the shared
		// chunk iterator. A "/r" chunk becomes "/", "r".
		const { replKeys } = buildStandaloneKeySources(fakeChunkSource(["/r"]));
		expect(await collect(replKeys)).toEqual(["/", "r"]);
	});

	it("borrowChunks()'s return is non-closing — the shared source survives an overlay break", async () => {
		// An overlay `for await`s a couple chunks then breaks (calls .return on the
		// borrowed view). That must NOT end the shared source: the next borrow keeps
		// reading the remaining chunks.
		const { borrowChunks } = buildStandaloneKeySources(fakeChunkSource(["\x1b[B", "\x1b[A", "\r"]));
		const first: string[] = [];
		for await (const c of borrowChunks()) {
			first.push(c);
			break; // overlay stops consuming → borrowed view's return() runs (no-op)
		}
		expect(first).toEqual(["\x1b[B"]);
		// The shared source is still alive: a fresh borrow yields the rest.
		expect(await collect(borrowChunks())).toEqual(["\x1b[A", "\r"]);
	});
});

describe("makeStandaloneOverlay (restores the REPL's raw mode after the picker)", () => {
	function overlayWith() {
		const rawModes: boolean[] = [];
		const overlay = makeStandaloneOverlay({
			borrowChunks: () =>
				(async function* () {
					yield "\r"; // Enter — the picker confirms and returns
				})(),
			write: () => {},
			setRawMode: (on) => void rawModes.push(on),
		});
		return { overlay, rawModes };
	}

	it("restores raw mode ON even though the picker's finally turns it OFF", async () => {
		const { overlay, rawModes } = overlayWith();
		// Simulate runResumePicker: raw ON at start, raw OFF in its finally.
		await overlay(async (io) => {
			io.setRawMode(true);
			for await (const _ of io.keys) break;
			io.setRawMode(false); // the picker's finally
		});
		// The overlay's own finally re-asserts raw ON last, so the REPL stays raw.
		expect(rawModes.at(-1)).toBe(true);
	});

	it("restores raw mode ON even if the picker run throws", async () => {
		const { overlay, rawModes } = overlayWith();
		await expect(
			overlay(async (io) => {
				io.setRawMode(false);
				throw new Error("picker boom");
			}),
		).rejects.toThrow("picker boom");
		expect(rawModes.at(-1)).toBe(true); // restored despite the throw
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
