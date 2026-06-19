/**
 * @ai-ezio/harness — owns the hax child process and the session/turn lifecycle.
 *
 * M1 scope: the hax binary resolver (the only piece the CLI launcher needs to
 * spawn the engine). The protocol-driven session/turn state machine lands in M3.
 */
export {
	describeHaxBinary,
	HaxBinaryNotFoundError,
	platformPackageName,
	resolveHaxBinary,
	type HaxBinarySource,
	type HaxResolution,
	type ResolveHaxOptions,
} from "./resolve-hax.js";
export {
	haxSpawnArgs,
	haxSpawnEnv,
	spawnHax,
	type SpawnedHax,
	type SpawnHaxOptions,
} from "./spawn.js";
export { aiEzioGlobalSkillsDir } from "./skills-dir.js";
export {
	CompactTimeoutError,
	type CompactResult,
	EngineBusyError,
	EngineExitedError,
	type ExclusiveSession,
	ProtocolVersionError,
	Session,
	type SessionOptions,
	TurnError,
	type TurnResult,
} from "./session.js";
export { TurnGate } from "./turn-gate.js";
export {
	COMPACTION_DEFAULTS,
	configFilePath,
	loadConfig,
	type CompactionConfig,
	type EzioConfig,
} from "./config.js";
export {
	Compactor,
	SUMMARIZE_INSTRUCTION,
	type CompactorOptions,
	type CompactorSession,
	type CompactOutcome,
} from "./compactor.js";
export {
	createAutoCompactDriver,
	type AutoCompactDriver,
	type AutoCompactDriverOptions,
} from "./auto-compact-driver.js";
export {
	createSessionTitleStore,
	createRenameController,
	defaultTitleStorePath,
	type SessionTitleStore,
	type RenameController,
	type TitleFs,
} from "./session-titles.js";
