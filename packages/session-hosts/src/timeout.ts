/** 30 minutes, in SECONDS — hax reads AI_EZIO_DELEGATED_TIMEOUT as seconds
 * (agent.c: atoi -> timeout_secs; emit.c: deadline_ms = timeout_secs * 1000). */
export const SUBAGENT_DELEGATED_TIMEOUT_SECS = "1800";

/** Raise the parent delegated-call dead-host backstop so a long-running subagent
 * call isn't cut off by hax's 120s default — only when unset (respect user override). */
export function ensureDelegatedTimeout(env: NodeJS.ProcessEnv = process.env): void {
	if (!env.AI_EZIO_DELEGATED_TIMEOUT)
		env.AI_EZIO_DELEGATED_TIMEOUT = SUBAGENT_DELEGATED_TIMEOUT_SECS;
}
