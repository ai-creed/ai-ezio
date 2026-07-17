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
export type KeyToken =
	| "up"
	| "down"
	| "enter"
	| "cancel"
	| "pageprev"
	| "pagenext"
	| "toggleall"
	| "other";

/** Rows shown per page when not in show-all mode. */
export const PAGE_SIZE = 15;

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
 * points) lets a bare Esc ("\x1b") be told apart from an arrow ("\x1b[A"), and a
 * bare "[" / "]" from a CSI sequence — they share a prefix only across chunks. Pure. */
export function decodeChunk(s: string): KeyToken {
	if (s === "\x1b[A" || s === "\x1bOA" || s === "k") return "up";
	if (s === "\x1b[B" || s === "\x1bOB" || s === "j") return "down";
	if (s === "\r" || s === "\n") return "enter";
	if (s === "\x1b" || s === "\x03" || s === "\x04" || s === "q") return "cancel";
	if (s === "[" || s === "\x1b[5~") return "pageprev";
	if (s === "]" || s === "\x1b[6~") return "pagenext";
	if (s === "\x01") return "toggleall"; // Ctrl+A
	return "other";
}

export interface PickerState {
	index: number; // global cursor (0-based across the whole list)
	count: number; // total rows
	pageSize: number; // rows per page (PAGE_SIZE)
	showAll: boolean; // Ctrl+A toggles the all-rows view
}
export interface KeyResult {
	index: number;
	showAll: boolean;
	done?: "select" | "cancel";
}

/** Apply one decoded key to the picker state. Hard pages: up/down clamp within the
 * current page; [ / ] jump to the first row of the prev/next page (inert at the ends
 * and in show-all); Ctrl+A toggles show-all and preserves the cursor; Enter selects;
 * Esc/Ctrl-C/Ctrl-D/q cancel. Pure. */
export function applyKey(state: PickerState, token: KeyToken): KeyResult {
	const { index, count, pageSize, showAll } = state;
	const pageStart = Math.floor(index / pageSize) * pageSize;
	const pageEnd = Math.min(count - 1, pageStart + pageSize - 1);
	const keep: KeyResult = { index, showAll };
	switch (token) {
		case "up":
			return { index: Math.max(showAll ? 0 : pageStart, index - 1), showAll };
		case "down":
			return { index: Math.min(showAll ? count - 1 : pageEnd, index + 1), showAll };
		case "pageprev":
			return !showAll && pageStart > 0 ? { index: pageStart - pageSize, showAll } : keep;
		case "pagenext":
			return !showAll && pageStart + pageSize < count
				? { index: pageStart + pageSize, showAll }
				: keep;
		case "toggleall":
			return { index, showAll: !showAll };
		case "enter":
			return { index, showAll, done: "select" };
		case "cancel":
			return { index, showAll, done: "cancel" };
		default:
			return keep;
	}
}

const HINTS_PAGED = "↑/↓ move · [ ]/PgUp/PgDn page · Ctrl+A all · Enter select · Esc cancel";
const HINTS_SINGLE = "↑/↓ move · Ctrl+A all · Enter select · Esc cancel";
const HINTS_ALL = "↑/↓ move · Ctrl+A pages · Enter select · Esc cancel";

/** Render the current view: a dynamic header, the visible rows (one page, or all in
 * show-all), and a footer of key hints. Rows keep their GLOBAL 1-based number. Pure;
 * the caller (runResumePicker) owns the cursor-reset for the in-place redraw. */
export function renderView(
	rows: SessionRow[],
	state: PickerState,
	nowMs: number,
	titles?: Map<string, string>,
): string {
	const { index, count, pageSize, showAll } = state;
	const pageCount = Math.max(1, Math.ceil(count / pageSize));
	const page = Math.floor(index / pageSize);
	const sliceStart = showAll ? 0 : page * pageSize;
	const sliceEnd = showAll ? count : Math.min(count, page * pageSize + pageSize);

	let header: string;
	let footer: string;
	if (showAll) {
		header = `Resume a session  (showing all ${count} sessions)`;
		footer = HINTS_ALL;
	} else if (pageCount === 1) {
		header = `Resume a session  (${count} session${count === 1 ? "" : "s"})`;
		footer = HINTS_SINGLE;
	} else {
		header = `Resume a session  (page ${page + 1}/${pageCount} · ${count} sessions)`;
		footer = HINTS_PAGED;
	}

	const lines = [header];
	for (let i = sliceStart; i < sliceEnd; i++) {
		lines.push(oneLine(rows[i]!, i, index, nowMs, titles));
	}
	lines.push(footer);
	return `${lines.join("\n")}\n`;
}

/** One row line: global number + cursor + age/title preview. Pure. */
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
 * there is nothing to resume or the user cancels (Esc/Ctrl-C/q/EOF). The frame
 * height varies (short last page, show-all, single page), so each redraw climbs the
 * PREVIOUS frame's line count and clears to end of screen before repainting.
 */
export async function runResumePicker(deps: PickerDeps): Promise<string | undefined> {
	const rows = parseSessions(await deps.listSessions());
	if (rows.length === 0) return undefined;

	let state: PickerState = { index: 0, count: rows.length, pageSize: PAGE_SIZE, showAll: false };
	let prevLines = 0;
	const draw = (first: boolean): void => {
		const view = renderView(rows, state, deps.now(), deps.titles);
		const reset = first ? "" : `\x1b[${prevLines}A\r\x1b[0J`;
		deps.write(reset + view);
		prevLines = (view.match(/\n/g) ?? []).length;
	};

	deps.setRawMode?.(true);
	try {
		draw(true);
		for await (const chunk of deps.keys) {
			const token = decodeChunk(typeof chunk === "string" ? chunk : String(chunk));
			const r = applyKey(state, token);
			state = { ...state, index: r.index, showAll: r.showAll };
			if (r.done === "cancel") return undefined;
			if (r.done === "select") return rows[state.index]?.id;
			draw(false);
		}
		return undefined; // input stream ended
	} finally {
		deps.setRawMode?.(false);
		deps.write("\n");
	}
}
