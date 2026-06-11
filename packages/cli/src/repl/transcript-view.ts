/**
 * The mounted-mode transcript view: ezio's stand-in for hax's interactive Ctrl+T.
 * hax mirrors its live transcript (system prompt + tools + every item, color off)
 * to the `HAX_TRANSCRIPT` file; this module pages or dumps that file on demand.
 *
 * Pure orchestration over injected seams (fs read, pager spawn, raw-mode toggles,
 * writer) so it is fully testable without a TTY, a pager, or the filesystem. It
 * never throws, never submits/interrupts, and does NOT redraw the prompt — the
 * caller owns that, so the keybind and slash paths do not double-draw.
 */
import { join } from "node:path";

/** Resolve the pager command: `$PAGER` when set and non-blank, else `less -R`. */
export function resolvePager(env: NodeJS.ProcessEnv = process.env): string {
	const p = env.PAGER?.trim();
	return p ? p : "less -R";
}

/** The per-process mirror path: `<stateDir>/transcripts/<repoKey>/<id>.txt`. */
export function transcriptFilePath(stateDir: string, repoKey: string, id: string): string {
	return join(stateDir, "transcripts", repoKey, `${id}.txt`);
}

export interface TranscriptViewDeps {
	/** The `HAX_TRANSCRIPT` mirror path, or undefined if none was wired. */
	path?: string;
	/** Read the mirror file: undefined when missing, "" when empty. */
	readText(path: string): string | undefined;
	/** True when stdout is an interactive TTY (a pager is usable). */
	interactive: boolean;
	/** Launch the pager on `file`; resolves on exit, rejects if it cannot run. */
	spawnPager(file: string): Promise<void>;
	/** Suspend / restore the REPL's raw-mode stdin around the pager. */
	suspendRaw(): void;
	restoreRaw(): void;
	/** Write to the terminal. */
	write(s: string): void;
}

/** Show the transcript. Missing/empty → a dim notice. Non-interactive → inline
 * dump. Interactive → suspend raw mode, page the file, restore raw mode even on
 * pager failure (falling back to an inline dump so content is never lost). */
export async function showTranscript(deps: TranscriptViewDeps): Promise<void> {
	const text = deps.path ? deps.readText(deps.path) : undefined;
	if (text === undefined || text === "") {
		deps.write("\x1b[2m─ no transcript yet ─\x1b[0m\n");
		return;
	}
	if (!deps.interactive) {
		deps.write(text.endsWith("\n") ? text : `${text}\n`);
		return;
	}
	deps.suspendRaw();
	try {
		await deps.spawnPager(deps.path as string);
	} catch {
		deps.write(text.endsWith("\n") ? text : `${text}\n`);
	} finally {
		deps.restoreRaw();
	}
}
