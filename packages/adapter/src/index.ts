/**
 * @ai-ezio/adapter — ai-whisper handoff/handback glue (ships as adapter-ai-ezio).
 *
 * M1 scope: package skeleton only. The mounted-mode spawn + protocol-driven
 * handoff/handback lands in M5, layered on @ai-ezio/harness.
 */
import { resolveHaxBinary } from "@ai-ezio/harness";

/** Adapter metadata; the real ai-whisper AgentType contract is implemented in M5. */
export const ADAPTER_NAME = "adapter-ai-ezio";

/** Placeholder until M5: confirms the harness is reachable from the adapter. */
export function haxBinaryPath(): string {
	return resolveHaxBinary();
}
