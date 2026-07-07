import { describe, expect, it } from "vitest";
import {
	resolvePager,
	showTranscript,
	transcriptFilePath,
	type TranscriptViewDeps,
} from "./transcript-view.js";

describe("resolvePager", () => {
	it("uses $PAGER when set and non-empty", () => {
		expect(resolvePager({ PAGER: "bat -p" })).toBe("bat -p");
	});
	it("falls back to 'less -R' when unset or blank", () => {
		expect(resolvePager({})).toBe("less -R");
		expect(resolvePager({ PAGER: "   " })).toBe("less -R");
	});
});

describe("transcriptFilePath", () => {
	it("joins <stateDir>/transcripts/<repoKey>/<id>.txt", () => {
		expect(transcriptFilePath("/state", "repo-x", "abc")).toBe("/state/transcripts/repo-x/abc.txt");
	});
});

function baseDeps(over: Partial<TranscriptViewDeps> = {}): {
	deps: TranscriptViewDeps;
	log: string[];
	out: () => string;
} {
	const log: string[] = [];
	const chunks: string[] = [];
	const deps: TranscriptViewDeps = {
		path: "/t/x.txt",
		readText: () => "SYSTEM PROMPT\n# turn 1\n",
		interactive: true,
		spawnPager: async () => void log.push("pager"),
		suspendRaw: () => void log.push("suspend"),
		restoreRaw: () => void log.push("restore"),
		write: (s) => void chunks.push(s),
		...over,
	};
	return { deps, log, out: () => chunks.join("") };
}

describe("showTranscript", () => {
	it("missing path → notice, no pager/raw toggles", async () => {
		const { deps, log, out } = baseDeps({ path: undefined });
		await showTranscript(deps);
		expect(out()).toContain("no transcript yet");
		expect(log).toEqual([]);
	});

	it("empty file → notice, no pager", async () => {
		const { deps, log, out } = baseDeps({ readText: () => "" });
		await showTranscript(deps);
		expect(out()).toContain("no transcript yet");
		expect(log).toEqual([]);
	});

	it("non-interactive → inline dump, no pager/raw toggles", async () => {
		const { deps, log, out } = baseDeps({ interactive: false });
		await showTranscript(deps);
		expect(out()).toContain("# turn 1");
		expect(log).toEqual([]);
	});

	it("interactive → suspend, page, restore in order; nothing inlined", async () => {
		const { deps, log, out } = baseDeps();
		await showTranscript(deps);
		expect(log).toEqual(["suspend", "pager", "restore"]);
		expect(out()).toBe("");
	});

	it("pager failure → inline-dump fallback, raw mode still restored", async () => {
		const { deps, log, out } = baseDeps({
			spawnPager: async () => {
				throw new Error("less not found");
			},
		});
		await showTranscript(deps);
		expect(log).toEqual(["suspend", "restore"]); // restore runs in finally
		expect(out()).toContain("# turn 1"); // fell back to inline
	});
});
