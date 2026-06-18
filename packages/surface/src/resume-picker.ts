/**
 * Interactive "resume a session" picker for `ai-ezio --resume` (no id). Session
 * ids are opaque uuids no human remembers, so we list the cwd's sessions and let
 * the user choose one, then resume it via the Phase A self-mount.
 *
 * ezio never re-derives hax's private on-disk session layout: it asks the engine
 * (`hax --list-sessions`, the M-resume seam) for a JSON array and renders its own
 * picker on top. The presentation is split into pure helpers (parse, relative
 * time, key decode, navigation reducer, frame render) so the terminal-free logic
 * is unit-tested; only `runResumePicker` touches I/O.
 *
 * Lives in @ai-ezio/surface so the ai-whisper adapter can import it. The impure
 * `spawnListSessions` (child_process) stays in @ai-ezio/cli.
 */

/** One selectable session row, parsed from the engine's `--list-sessions` JSON. */
export interface SessionRow {
	id: string;
	mtime: number; // seconds since epoch (for relative-time display + sort)
	firstPrompt: string | null; // bounded preview, or null when unreadable
}

/** A decoded keypress (one raw input chunk → one intent). */
export type KeyToken = "up" | "down" | "enter" | "cancel" | { digit: number } | "other";

export interface PickerDeps {
	/** Returns the engine's `--list-sessions` JSON (injected for tests). */
	listSessions: () => Promise<string>;
	/** Raw terminal input, one keypress per chunk (escape sequences arrive whole). */
	keys: AsyncIterable<string>;
	write: (s: string) => void;
	now: () => number; // ms since epoch, for relative time
	setRawMode?: (on: boolean) => void;
	/** id → friendly title (the §1A sidecar). Absent → firstPrompt only. */
	titles?: Map<string, string>;
}

/** Parse the engine's `--list-sessions` JSON into selectable rows. Tolerant: a
 * malformed payload yields no rows, and rows without a usable string id (which
 * cannot be resumed) are dropped. Pure. */
export function parseSessions(json: string): SessionRow[] {
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(raw)) return [];
	const rows: SessionRow[] = [];
	for (const e of raw) {
		if (!e || typeof e !== "object") continue;
		const o = e as Record<string, unknown>;
		if (typeof o.id !== "string" || o.id === "") continue;
		rows.push({
			id: o.id,
			mtime: typeof o.mtime === "number" ? o.mtime : 0,
			firstPrompt: typeof o.firstPrompt === "string" ? o.firstPrompt : null,
		});
	}
	return rows;
}

/** Compact relative age, e.g. "just now", "5m ago", "2h ago", "3d ago". Pure. */
export function formatRelativeTime(mtimeSec: number, nowMs: number): string {
	const diff = Math.max(0, Math.floor(nowMs / 1000) - mtimeSec);
	if (diff < 60) return "just now";
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	return `${Math.floor(diff / 86400)}d ago`;
}

/** The visible text of one row: age + (title || firstPrompt), clamped so a long
 * value never wraps. Pure. A title (from the §1A sidecar) shadows firstPrompt. */
export function formatRow(row: SessionRow, nowMs: number, title?: string): string {
	const age = formatRelativeTime(row.mtime, nowMs);
	const label = (title ?? row.firstPrompt ?? "(no prompt)").replace(/\s+/g, " ").trim();
	const clamped = label.length > 70 ? `${label.slice(0, 69)}…` : label;
	return `${age} · ${clamped}`;
}

/** Decode one raw input chunk into an intent. Reading whole chunks (not code
 * points) lets a bare Esc ("\x1b") be told apart from an arrow ("\x1b[A"), which
 * share a prefix. Pure. */
export function decodeChunk(s: string): KeyToken {
	if (s === "\x1b[A" || s === "\x1bOA" || s === "k") return "up";
	if (s === "\x1b[B" || s === "\x1bOB" || s === "j") return "down";
	if (s === "\r" || s === "\n") return "enter";
	if (s === "\x1b" || s === "\x03" || s === "\x04" || s === "q") return "cancel";
	if (/^[1-9]$/.test(s)) return { digit: Number(s) };
	return "other";
}

export interface PickerState {
	index: number;
	count: number;
}
export interface KeyResult {
	index: number;
	done?: "select" | "cancel";
}

/** Apply one decoded key to the picker state. Up/Down clamp at the ends; a digit
 * jumps to that 1-based row (when in range) without selecting; Enter selects the
 * current row; Esc/Ctrl-C/q cancel. Pure. */
export function applyKey(state: PickerState, token: KeyToken): KeyResult {
	if (token === "up") return { index: Math.max(0, state.index - 1) };
	if (token === "down") return { index: Math.min(state.count - 1, state.index + 1) };
	if (token === "enter") return { index: state.index, done: "select" };
	if (token === "cancel") return { index: state.index, done: "cancel" };
	if (typeof token === "object" && "digit" in token) {
		const i = token.digit - 1;
		return { index: i >= 0 && i < state.count ? i : state.index };
	}
	return { index: state.index };
}

const PICKER_TITLE = "Resume a session  (↑/↓ move · 1-9 jump · Enter select · Esc cancel)";

/** Render the full picker frame. On a redraw, prepend a cursor-up + clear so the
 * previous frame is overwritten in place rather than scrolling. Pure. */
export function renderFrame(
	rows: SessionRow[],
	index: number,
	nowMs: number,
	isRedraw: boolean,
	titles?: Map<string, string>,
): string {
	const lines = [PICKER_TITLE, ...rows.map((r, i) => oneLine(r, i, index, nowMs, titles))];
	// Move up over the prior frame (title + every row) and clear to end of screen.
	const reset = isRedraw ? `\x1b[${rows.length + 1}A\r\x1b[0J` : "";
	return `${reset}${lines.join("\n")}\n`;
}

function oneLine(
	row: SessionRow,
	i: number,
	selected: number,
	nowMs: number,
	titles?: Map<string, string>,
): string {
	const cursor = i === selected ? "\x1b[36m❯\x1b[0m" : " ";
	const n = `${i + 1}.`;
	const body = formatRow(row, nowMs, titles?.get(row.id));
	const text = i === selected ? `\x1b[1m${body}\x1b[0m` : `\x1b[2m${body}\x1b[0m`;
	return `${cursor} ${n} ${text}`;
}

/**
 * Run the interactive picker. Returns the chosen session id, or undefined when
 * there is nothing to resume or the user cancels (Esc/Ctrl-C/q/EOF). The caller
 * resumes the chosen id via the Phase A self-mount.
 */
export async function runResumePicker(deps: PickerDeps): Promise<string | undefined> {
	const rows = parseSessions(await deps.listSessions());
	if (rows.length === 0) return undefined;

	let index = 0;
	deps.setRawMode?.(true);
	try {
		deps.write(renderFrame(rows, index, deps.now(), false, deps.titles));
		for await (const chunk of deps.keys) {
			const token = decodeChunk(typeof chunk === "string" ? chunk : String(chunk));
			const r = applyKey({ index, count: rows.length }, token);
			index = r.index;
			if (r.done === "cancel") return undefined;
			if (r.done === "select") return rows[index]?.id;
			deps.write(renderFrame(rows, index, deps.now(), true, deps.titles));
		}
		return undefined; // input stream ended
	} finally {
		deps.setRawMode?.(false);
		deps.write("\n");
	}
}
