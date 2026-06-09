import { describe, expect, it } from "vitest";
import { detectEnvironment, type DetectDeps, parseGlobalList } from "./detect.js";

function deps(over: Partial<DetectDeps> = {}): DetectDeps {
	return {
		which: (c) => (["npm", "pnpm", "ai-cortex"].includes(c) ? `/bin/${c}` : null),
		versionOf: (b) => (b === "ai-cortex" ? "0.14.2" : null),
		globalList: (m) => (m === "pnpm" ? ["ai-ezio", "ai-whisper"] : []),
		isTTY: () => true,
		env: {} as NodeJS.ProcessEnv,
		...over,
	};
}

describe("detectEnvironment", () => {
	it("finds a peer present on PATH (cortex) and one present only via the global list (whisper)", () => {
		const e = deps({
			which: (c) => (["npm", "pnpm", "ai-cortex"].includes(c) ? `/bin/${c}` : null),
		});
		const env = detectEnvironment(e);
		expect(env.peers.cortex).toMatchObject({ present: true, version: "0.14.2" });
		expect(env.peers.whisper.present).toBe(true); // from pnpm global list (ai-whisper), even though `whisper` bin path mocked absent
	});
	it("owning manager = the one whose global list contains ai-ezio (pnpm here), not just npm", () => {
		expect(detectEnvironment(deps()).manager).toBe("pnpm");
	});
	it("falls back to npm when no list claims ai-ezio", () => {
		expect(detectEnvironment(deps({ globalList: () => [] })).manager).toBe("npm");
	});
});

describe("parseGlobalList (npm object vs pnpm array — the real parser)", () => {
	it("reads npm's object shape", () => {
		const npm = JSON.stringify({
			dependencies: { "ai-cortex": { version: "0.14.2" }, "ai-ezio": {} },
		});
		expect(parseGlobalList(npm).sort()).toEqual(["ai-cortex", "ai-ezio"]);
	});
	it("reads pnpm's ARRAY shape (regression: must not read .dependencies off an array)", () => {
		const pnpm = JSON.stringify([
			{ path: "/pnpm/global/5", dependencies: { "ai-whisper": { version: "0.5.5" } } },
		]);
		expect(parseGlobalList(pnpm)).toEqual(["ai-whisper"]);
	});
	it("tolerates a pnpm array entry with no dependencies key, and malformed JSON", () => {
		expect(parseGlobalList(JSON.stringify([{ path: "/p", private: false }]))).toEqual([]);
		expect(parseGlobalList("not json")).toEqual([]);
	});
});
