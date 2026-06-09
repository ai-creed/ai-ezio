/** Wire the durable store + cortex sink into a SessionRecorder. */
import { CortexSessionSink } from "./cortex-sink.js";
import { JsonlDurableStore } from "./durable-store.js";
import { SessionRecorder } from "./recorder.js";
import type { HostToolCaller } from "./types.js";

export interface CreateRecorderOptions {
	worktreePath: string;
	host: HostToolCaller;
	stateDir: string;
	repoKey: string;
	idleDebounceMs?: number;
	everyKTurns?: number;
	embed?: boolean;
	warn?: (msg: string) => void;
}

export function createRecorder(opts: CreateRecorderOptions): SessionRecorder {
	const store = new JsonlDurableStore({ stateDir: opts.stateDir, repoKey: opts.repoKey });
	const sink = new CortexSessionSink({
		host: opts.host,
		stateDir: opts.stateDir,
		repoKey: opts.repoKey,
		embed: opts.embed,
		warn: opts.warn,
	});
	return new SessionRecorder({
		worktreePath: opts.worktreePath,
		store,
		sink,
		idleDebounceMs: opts.idleDebounceMs,
		everyKTurns: opts.everyKTurns,
	});
}
