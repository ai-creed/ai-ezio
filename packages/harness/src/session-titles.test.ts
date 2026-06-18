import { describe, expect, it } from "vitest";
import { createSessionTitleStore, defaultTitleStorePath, type TitleFs } from "./session-titles.js";

/** In-memory TitleFs for deterministic tests. */
function memFs(seed: Record<string, string> = {}): TitleFs & { files: Map<string, string> } {
	const files = new Map<string, string>(Object.entries(seed));
	return {
		files,
		readFileSync: (p) => files.get(p),
		writeFileSync: (p, d) => void files.set(p, d),
		renameSync: (from, to) => {
			const v = files.get(from);
			if (v === undefined) throw new Error(`ENOENT ${from}`);
			files.set(to, v);
			files.delete(from);
		},
		mkdirSync: () => {},
	};
}

describe("session title store", () => {
	const path = "/state/ai-ezio/session-titles.json";

	it("round-trips a title by session id", () => {
		const fs = memFs();
		const store = createSessionTitleStore({ filePath: path, fs });
		store.setTitle("uuid-a", "wire resume seam");
		expect(store.getTitle("uuid-a")).toBe("wire resume seam");
		expect(createSessionTitleStore({ filePath: path, fs }).getTitle("uuid-a")).toBe(
			"wire resume seam",
		);
	});

	it("writes atomically via a temp file + rename", () => {
		const fs = memFs();
		const renamed: string[] = [];
		const spyFs: TitleFs = { ...fs, renameSync: (f, t) => (renamed.push(`${f}->${t}`), fs.renameSync(f, t)) };
		createSessionTitleStore({ filePath: path, fs: spyFs }).setTitle("id", "x");
		expect(renamed).toEqual([`${path}.tmp->${path}`]);
		expect(fs.files.has(`${path}.tmp`)).toBe(false);
	});

	it("ignores an empty / whitespace title (no-op)", () => {
		const fs = memFs();
		const store = createSessionTitleStore({ filePath: path, fs });
		store.setTitle("id", "   ");
		expect(store.getTitle("id")).toBeUndefined();
		expect(fs.files.size).toBe(0);
	});

	it("tolerates a missing file (empty map) and malformed JSON", () => {
		expect(createSessionTitleStore({ filePath: path, fs: memFs() }).loadTitles().size).toBe(0);
		const bad = memFs({ [path]: "{not json" });
		expect(createSessionTitleStore({ filePath: path, fs: bad }).getTitle("id")).toBeUndefined();
	});

	it("defaultTitleStorePath honors XDG_STATE_HOME then HOME", () => {
		expect(defaultTitleStorePath({ XDG_STATE_HOME: "/xdg" })).toBe("/xdg/ai-ezio/session-titles.json");
		expect(defaultTitleStorePath({ HOME: "/home/u" })).toBe(
			"/home/u/.local/state/ai-ezio/session-titles.json",
		);
	});
});

import { createRenameController } from "./session-titles.js";
import type { ProtocolEvent } from "@ai-ezio/protocol";

const ready = (sessionId: string) =>
	({ type: "ready", sessionId, protocol: "x", haxBaseCommit: "x" }) as unknown as ProtocolEvent;
const status = (sessionId: string) =>
	({ type: "status", sessionId, model: "m", provider: "p", protocol: "x", state: "idle" }) as unknown as ProtocolEvent;
const idle = () => ({ type: "idle" }) as unknown as ProtocolEvent;

describe("rename controller (§1C)", () => {
	function setup(seed?: Record<string, string>) {
		const store = createSessionTitleStore({ filePath: "/s.json", fs: memFs(seed) });
		const statusRequests: number[] = [];
		const ctl = createRenameController({ store, requestStatus: () => statusRequests.push(1) });
		return { store, ctl, statusRequests };
	}

	it("normalizes hax's \"unknown\" to undefined", () => {
		const { ctl } = setup();
		ctl.noteEvent(ready("unknown"));
		expect(ctl.currentSessionId()).toBeUndefined();
	});

	it("seeds the id from ready and titles the current session", () => {
		const { ctl, store } = setup();
		ctl.noteEvent(ready("uuid-a"));
		ctl.setSessionTitle("alpha");
		expect(store.getTitle("uuid-a")).toBe("alpha");
	});

	it("requests a status refresh on the first-turn idle while id is unknown, then materializes", () => {
		const { ctl, statusRequests } = setup();
		ctl.noteEvent(ready("unknown")); // fresh, no id yet
		ctl.noteEvent(idle()); // first-turn settle → ask for status
		expect(statusRequests.length).toBe(1);
		ctl.noteEvent(status("uuid-real")); // engine answers with the now-materialized id
		expect(ctl.currentSessionId()).toBe("uuid-real");
		ctl.noteEvent(idle()); // id known now → no further status requests
		expect(statusRequests.length).toBe(1);
	});

	it("buffers a pending rename until the id materializes — never under \"unknown\"", () => {
		const { ctl, store } = setup();
		ctl.noteEvent(ready("unknown"));
		ctl.setSessionTitle("queued"); // no id yet → buffered, not written
		expect(store.getTitle("uuid-real")).toBeUndefined();
		expect(store.getTitle("unknown")).toBeUndefined(); // required: never the sentinel
		expect(ctl.getSessionTitle()).toBe("queued"); // no-arg /rename shows the pending title
		ctl.noteEvent(status("uuid-real"));
		expect(store.getTitle("uuid-real")).toBe("queued"); // flushed under the real id
		expect(store.getTitle("unknown")).toBeUndefined();
	});

	it("clears a pending rename on /new (does NOT flush it to the rotated session)", () => {
		const { ctl, store } = setup();
		ctl.noteEvent(ready("unknown")); // fresh, id not yet materialized
		ctl.setSessionTitle("queued-on-old"); // pending (no id)
		ctl.noteNewConversation(); // /new: the pending title must be dropped
		expect(ctl.getSessionTitle()).toBeUndefined();
		ctl.noteEvent(status("uuid-new")); // the rotated session materializes its id
		expect(store.getTitle("uuid-new")).toBeUndefined(); // dropped title is NOT flushed
		expect(store.getTitle("unknown")).toBeUndefined();
	});

	it("rebinds the id after /new and re-requests status", () => {
		const { ctl, statusRequests } = setup();
		ctl.noteEvent(ready("uuid-old"));
		ctl.setSessionTitle("x"); // written immediately under uuid-old (id known)
		ctl.noteNewConversation(); // /new: drop id, single-flight status request
		expect(ctl.currentSessionId()).toBeUndefined();
		expect(statusRequests.length).toBe(1);
		ctl.noteEvent(status("unknown")); // fresh session, still no turn
		expect(ctl.currentSessionId()).toBeUndefined();
	});

	it("after /new returns \"unknown\", a first-turn idle re-requests status and flushes a pending rename", () => {
		const { ctl, store, statusRequests } = setup();
		ctl.noteEvent(ready("uuid-old"));
		ctl.noteNewConversation(); // /new → status request #1
		expect(statusRequests.length).toBe(1);
		ctl.noteEvent(status("unknown")); // answered, but the fresh session has no turn yet
		ctl.setSessionTitle("after-new"); // id still undefined → buffered as pending
		ctl.noteEvent(idle()); // first-turn settle, id still undefined → status request #2
		expect(statusRequests.length).toBe(2); // the single-flight latch was cleared by status("unknown")
		ctl.noteEvent(status("uuid-new")); // now materialized
		expect(ctl.currentSessionId()).toBe("uuid-new");
		expect(store.getTitle("uuid-new")).toBe("after-new"); // pending flushed under the real id
		expect(store.getTitle("unknown")).toBeUndefined();
	});
});
