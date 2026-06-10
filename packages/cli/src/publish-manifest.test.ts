import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// The publish scripts live at the repo root; both guard their CLI behind an
// is-main check, so importing these helpers is side-effect-free.
import { assertPublishable } from "../../../scripts/check-pack-manifest.mjs";
import { buildPublishedManifest } from "../../../scripts/make-publish-manifest.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const devPkg = JSON.parse(
	readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
);

describe("published @ai-creed/ai-ezio manifest (beta.1 workspace: regression)", () => {
	it("reproduces the bug: the raw dev manifest is NOT publishable — it carries workspace:", () => {
		// This is exactly what npm uploaded into the REGISTRY manifest for beta.1
		// (npm captures it before prepack pins the versions), so `npm install` hit
		// EUNSUPPORTEDPROTOCOL on the workspace:* optionalDependencies.
		const errors = assertPublishable(devPkg);
		expect(errors.some((e: string) => e.includes("workspace:"))).toBe(true);
	});

	it("buildPublishedManifest yields a clean, pinned, publishable manifest", () => {
		const published = buildPublishedManifest(devPkg, repoRoot);
		expect(assertPublishable(published)).toEqual([]);
		expect(published.dependencies).toBeUndefined();
		expect(published.devDependencies).toBeUndefined();
		// every hax optionalDependency is pinned to a concrete version, never workspace:
		for (const spec of Object.values(published.optionalDependencies)) {
			expect(String(spec)).toMatch(/^\d+\.\d+\.\d+/);
		}
		// metadata the version command + consumers rely on is preserved
		expect(published.haxBaseCommit).toBe(devPkg.haxBaseCommit);
		expect(published.exports).toEqual(devPkg.exports);
	});

	it("is idempotent: re-running on an already published manifest is a no-op (prepack after CI apply)", () => {
		const once = buildPublishedManifest(devPkg, repoRoot);
		const twice = buildPublishedManifest(once, repoRoot);
		expect(twice).toEqual(once);
	});
});
