/** Startup recovery: re-trigger capture for any on-disk cortex projection (idempotent
 * in cortex), closing the gap left by a crash before a final boundary capture. */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { HostToolCaller } from "./types.js";

export interface RecoverOptions {
	host: HostToolCaller;
	stateDir: string;
	repoKey: string;
	worktreePath: string;
	toolName?: string;
	embed?: boolean;
	warn?: (msg: string) => void;
}

const SUFFIX = ".cortex.jsonl";

export async function recoverUncaptured(opts: RecoverOptions): Promise<void> {
	const dir = join(opts.stateDir, "sessions", opts.repoKey);
	let files: string[];
	try {
		files = readdirSync(dir);
	} catch {
		return; // no sessions dir yet
	}
	for (const f of files) {
		if (!f.endsWith(SUFFIX)) continue;
		const conversationId = f.slice(0, -SUFFIX.length);
		try {
			await opts.host.callHostTool(opts.toolName ?? "cortex__capture_session", {
				worktreePath: opts.worktreePath,
				sessionId: conversationId,
				transcriptPath: join(dir, f),
				embed: opts.embed ?? true,
			});
		} catch (e) {
			(opts.warn ?? ((m) => process.stderr.write(`${m}\n`)))(
				`cortex recovery capture failed for ${conversationId}: ${(e as Error).message}`,
			);
		}
	}
}
