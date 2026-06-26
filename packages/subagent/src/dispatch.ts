/** Run one subagent dispatch: spawn a child hax session + its MCP host on the
 * chosen profile, run the task to idle, capture the final text, tear down. Never
 * rejects — every outcome is a { status, output } result the host returns verbatim. */
import type { SubagentProfile } from "@ai-ezio/harness";
import { profileEnv, validateProfile } from "./profile-env.js";

/** Per-turn token usage, shape-compatible with the harness `TurnResult.usage`
 * (so the real child Session's result assigns directly). All fields optional. */
export interface SubagentUsage {
	outputTokens?: number;
	contextTokens?: number;
	cachedTokens?: number;
	contextLimit?: number;
}

export interface ChildSession {
	start(opts: { env: NodeJS.ProcessEnv }): Promise<unknown>;
	submitAndWait(text: string): Promise<{ content: string; usage?: SubagentUsage }>;
	close(): void;
}

export interface ChildMcp {
	start(session: unknown): Promise<void>;
	stop(): Promise<void>;
}

export interface DispatchResult {
	output: string;
	status: "ok" | "error";
	elapsedMs: number;
	/** Child's per-turn usage, for the surface summary (not model-visible). */
	usage?: SubagentUsage;
}

export interface DispatchHandle {
	promise: Promise<DispatchResult>;
	/** Tear the child + its MCP host down early (parent interrupt). Idempotent. */
	cancel(): void;
}

class CanceledError extends Error {
	constructor() {
		super("subagent dispatch canceled");
		this.name = "CanceledError";
	}
}

export function runSubagent(args: {
	task: string;
	profile: SubagentProfile;
	cwd: string;
	parentEnv: NodeJS.ProcessEnv;
	timeoutMs: number;
	makeSession: (onEvent: (e: unknown) => void) => ChildSession;
	makeMcpHost: (cwd: string) => ChildMcp;
	now?: () => number;
}): DispatchHandle {
	const now = args.now ?? Date.now;
	const startedAt = now();
	let child: ChildSession | undefined;
	let mcp: ChildMcp | undefined;
	let canceled = false;
	let tornDown = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	// A cancel signal that loses the Promise.race so cancel() resolves the dispatch
	// PROMPTLY even when the child's submitAndWait never settles on its own.
	let fireCancel: () => void = () => {};
	const cancelSignal = new Promise<never>((_resolve, reject) => {
		fireCancel = () => reject(new CanceledError());
	});
	cancelSignal.catch(() => {}); // never an unhandled rejection

	// Idempotent teardown: close the child AND stop its MCP host so nothing orphans.
	const teardown = async (): Promise<void> => {
		if (tornDown) return;
		tornDown = true;
		if (timer) clearTimeout(timer);
		try {
			child?.close();
		} catch {
			/* already closed */
		}
		try {
			await mcp?.stop();
		} catch {
			/* ignore */
		}
	};

	const cancel = (): void => {
		canceled = true;
		fireCancel(); // unblock the race immediately
		void teardown(); // close child + stop child MCP now — no orphan
	};

	const promise = (async (): Promise<DispatchResult> => {
		const keyErr = validateProfile(args.profile, args.parentEnv);
		if (keyErr) return { output: keyErr, status: "error", elapsedMs: now() - startedAt };

		mcp = args.makeMcpHost(args.cwd);
		const onChildEvent = (e: unknown): void =>
			void (mcp as ChildMcp & { handleEvent?: (e: unknown) => void }).handleEvent?.(e);
		child = args.makeSession(onChildEvent);
		try {
			await child.start({ env: profileEnv(args.profile, args.parentEnv) });
			await mcp.start(child);
			const timeout = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`subagent timed out after ${args.timeoutMs}ms`)),
					args.timeoutMs,
				);
				timer.unref?.();
			});
			const r = await Promise.race([child.submitAndWait(args.task), timeout, cancelSignal]);
			return { output: r.content, status: "ok", elapsedMs: now() - startedAt, usage: r.usage };
		} catch (e) {
			const msg = canceled ? "subagent dispatch canceled" : (e as Error).message;
			return { output: msg, status: "error", elapsedMs: now() - startedAt };
		} finally {
			await teardown();
		}
	})();

	return { promise, cancel };
}
