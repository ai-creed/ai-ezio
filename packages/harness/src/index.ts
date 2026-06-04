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
	EngineExitedError,
	ProtocolVersionError,
	Session,
	type SessionOptions,
	TurnError,
	type TurnResult,
} from "./session.js";
