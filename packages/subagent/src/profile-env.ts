/** Map a subagent profile to the child hax process env, and validate prerequisites. */
import type { SubagentProfile } from "@ai-ezio/harness";

/**
 * Build the child env: inherit the parent env (so provider keys / base URLs flow
 * through automatically), then pin the provider, model, and effort. Effort is set
 * from the profile or, when the profile has none, CLEARED so the child uses the
 * model's own default rather than inheriting the parent's effort.
 */
export function profileEnv(
	profile: SubagentProfile,
	parentEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...parentEnv };
	env.HAX_PROVIDER = profile.provider;
	env.HAX_MODEL = profile.model;
	if (profile.effort) env.HAX_REASONING_EFFORT = profile.effort;
	else delete env.HAX_REASONING_EFFORT;
	// Subagent children self-protect: the parent cannot compact a child, so keep hax's
	// own auto-compaction ON regardless of a disabling parent env.
	env.HAX_COMPACT_AUTO = "1";
	return env;
}

/** Returns an error string when a declared key/base-url env var is absent, else null. */
export function validateProfile(
	profile: SubagentProfile,
	parentEnv: NodeJS.ProcessEnv,
): string | null {
	if (profile.apiKeyEnv && !parentEnv[profile.apiKeyEnv]) {
		return `profile requires env var ${profile.apiKeyEnv} (not set)`;
	}
	if (profile.baseUrlEnv && !parentEnv[profile.baseUrlEnv]) {
		return `profile requires env var ${profile.baseUrlEnv} (not set)`;
	}
	return null;
}
