import { expect, it } from "vitest";
import { profileEnv, validateProfile } from "./profile-env.js";

it("overlays HAX_PROVIDER/MODEL/EFFORT on the parent env", () => {
	const env = profileEnv(
		{ provider: "codex", model: "gpt-5.4-mini", effort: "low" },
		{ HOME: "/h", PATH: "/usr/bin", HAX_PROVIDER: "codex", HAX_MODEL: "gpt-5.5" },
	);
	expect(env.HAX_PROVIDER).toBe("codex");
	expect(env.HAX_MODEL).toBe("gpt-5.4-mini");
	expect(env.HAX_REASONING_EFFORT).toBe("low");
	expect(env.HOME).toBe("/h"); // inherited
});

it("omits HAX_REASONING_EFFORT when the profile has no effort", () => {
	const env = profileEnv(
		{ provider: "ollama", model: "qwen3:8b" },
		{ HAX_REASONING_EFFORT: "high" },
	);
	// no effort on the profile -> the inherited value is cleared so the child uses the model default
	expect(env.HAX_REASONING_EFFORT).toBeUndefined();
});

it("validateProfile flags a missing apiKeyEnv, passes when present or absent", () => {
	expect(
		validateProfile({ provider: "openrouter", model: "x", apiKeyEnv: "OPENROUTER_API_KEY" }, {}),
	).toMatch(/OPENROUTER_API_KEY/);
	expect(
		validateProfile(
			{ provider: "openrouter", model: "x", apiKeyEnv: "OPENROUTER_API_KEY" },
			{ OPENROUTER_API_KEY: "k" },
		),
	).toBeNull();
	expect(validateProfile({ provider: "codex", model: "gpt-5.4-mini" }, {})).toBeNull(); // codex needs no key
});

it("pins HAX_COMPACT_AUTO=1 even when the parent env disables it", () => {
	const env = profileEnv({ provider: "ollama", model: "qwen3:8b" }, { HAX_COMPACT_AUTO: "0" });
	expect(env.HAX_COMPACT_AUTO).toBe("1");
});

it("pins HAX_COMPACT_AUTO=1 when the parent env is unset", () => {
	const env = profileEnv({ provider: "codex", model: "gpt-5.4-mini" }, {});
	expect(env.HAX_COMPACT_AUTO).toBe("1");
});

it("a keyless local ollama profile and a codex profile both validate (no migration)", () => {
	// upstream keeps `ollama` as a built-in config-provider recipe (keyless local),
	// so a stale-looking ollama profile must NOT be rejected.
	expect(validateProfile({ provider: "ollama", model: "qwen3:8b" }, {})).toBeNull();
	expect(validateProfile({ provider: "codex", model: "gpt-5.4-mini" }, {})).toBeNull();
});
