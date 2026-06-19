/**
 * Session title sidecar (ezio-owned). hax has no session-title concept, so ezio
 * keeps friendly titles in its own JSON map keyed by hax session id (a uuid,
 * globally unique — one flat file suffices). Pure persistence: knows nothing of
 * the picker or slash commands. The RenameController below layers the
 * id-acquisition + pending-rename behavior on top.
 */
import { join } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProtocolEvent } from "@ai-ezio/protocol";

/** Injected fs surface (tests pass an in-memory impl). */
export interface TitleFs {
	readFileSync(path: string): string | undefined;
	writeFileSync(path: string, data: string): void;
	renameSync(from: string, to: string): void;
	mkdirSync(dir: string): void;
}

interface TitleRecord {
	title: string;
	updatedAt: number;
}

export interface SessionTitleStore {
	getTitle(sessionId: string): string | undefined;
	setTitle(sessionId: string, title: string): void;
	/** id → title, for the picker merge. */
	loadTitles(): Map<string, string>;
}

const nodeTitleFs: TitleFs = {
	readFileSync: (p) => {
		try {
			return readFileSync(p, "utf8");
		} catch {
			return undefined;
		}
	},
	writeFileSync: (p, d) => writeFileSync(p, d),
	renameSync: (from, to) => renameSync(from, to),
	mkdirSync: (dir) => void mkdirSync(dir, { recursive: true }),
};

/** `$XDG_STATE_HOME/ai-ezio/session-titles.json`, falling back to
 * `$HOME/.local/state/ai-ezio/...` — the codebase's state-path convention. */
export function defaultTitleStorePath(env: NodeJS.ProcessEnv = process.env): string {
	const base = env.XDG_STATE_HOME || join(env.HOME ?? "", ".local", "state");
	return join(base, "ai-ezio", "session-titles.json");
}

export function createSessionTitleStore(
	opts: { filePath?: string; fs?: TitleFs } = {},
): SessionTitleStore {
	const filePath = opts.filePath ?? defaultTitleStorePath();
	const fs = opts.fs ?? nodeTitleFs;

	const read = (): Record<string, TitleRecord> => {
		const raw = fs.readFileSync(filePath);
		if (!raw) return {};
		try {
			const parsed: unknown = JSON.parse(raw);
			return parsed && typeof parsed === "object" ? (parsed as Record<string, TitleRecord>) : {};
		} catch {
			return {};
		}
	};

	return {
		getTitle: (id) => {
			const rec = read()[id];
			return rec && typeof rec.title === "string" ? rec.title : undefined;
		},
		setTitle: (id, title) => {
			const t = title.trim();
			if (t === "") return; // empty is a no-op; clearing is not a goal
			const all = read();
			all[id] = { title: t, updatedAt: clockNow() };
			fs.mkdirSync(dirname(filePath));
			const tmp = `${filePath}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(all, null, "\t"));
			fs.renameSync(tmp, filePath); // atomic publish
		},
		loadTitles: () => {
			const all = read();
			const map = new Map<string, string>();
			for (const [id, rec] of Object.entries(all)) {
				if (rec && typeof rec.title === "string") map.set(id, rec.title);
			}
			return map;
		},
	};
}

// Date.now is fine in production code; isolated here so tests need not stub it.
function clockNow(): number {
	return Date.now();
}

/** Backs the §1C session-id acquisition + pending-rename behavior. Fed protocol
 * events by the runtime; exposes the SlashContext-facing capabilities. */
export interface RenameController {
	currentSessionId(): string | undefined;
	getSessionTitle(): string | undefined;
	setSessionTitle(title: string): void;
	/** Feed every protocol event (handles ready / status / idle). */
	noteEvent(event: ProtocolEvent): void;
	/** Call after a `new_conversation` control settles. */
	noteNewConversation(): void;
}

function normalizeId(id: string | undefined): string | undefined {
	return id && id !== "unknown" ? id : undefined;
}

export function createRenameController(deps: {
	store: Pick<SessionTitleStore, "getTitle" | "setTitle">;
	/** Provoke the engine to emit a `status` event (runtime: () => void session.status()). */
	requestStatus: () => void;
}): RenameController {
	let currentId: string | undefined;
	let pendingTitle: string | undefined;
	// Single-flight guard: request a status refresh at most once until an id is
	// captured, so multiple idles before the first turn materializes don't stack
	// status round-trips. Reset when an id arrives or on /new.
	let statusRequested = false;

	const requestStatusOnce = (): void => {
		if (statusRequested) return;
		statusRequested = true;
		// IMPORTANT: deps.requestStatus MUST defer the actual status() call off the
		// current delivery turn (the runtime wires it with queueMicrotask). noteEvent
		// runs inside Session.deliver()'s onEvent tee, which fires BEFORE the same
		// event is routed to waiters; issuing session.status() synchronously here
		// would register a status waiter mid-delivery. Deferral keeps the settling
		// idle reaching the turn's submitAndWait waiter first.
		deps.requestStatus();
	};

	const setId = (id: string | undefined): void => {
		const next = normalizeId(id);
		if (!next || next === currentId) return;
		currentId = next;
		if (pendingTitle !== undefined) {
			deps.store.setTitle(next, pendingTitle); // flush the buffered rename
			pendingTitle = undefined;
		}
	};

	return {
		currentSessionId: () => currentId,
		getSessionTitle: () => pendingTitle ?? (currentId ? deps.store.getTitle(currentId) : undefined),
		setSessionTitle: (title) => {
			const t = title.trim();
			if (t === "") return;
			// Never write under the "unknown" sentinel: currentId is already
			// normalized (undefined when not materialized), so a pending buffer holds
			// the title until a real id arrives.
			if (currentId) deps.store.setTitle(currentId, t);
			else pendingTitle = t;
		},
		noteEvent: (event) => {
			if (event.type === "ready" || event.type === "status") {
				// An answer arrived — clear the single-flight latch FIRST, even if it
				// carries no real id yet (e.g. status("unknown") right after /new). This
				// is the fix for the post-/new suppression bug: otherwise the latch
				// would stay set and the later first-turn idle would never re-request,
				// so a pending /rename could never materialize. THEN capture any id.
				statusRequested = false;
				setId((event as { sessionId?: string }).sessionId);
			} else if (event.type === "idle" && currentId === undefined) {
				// First-turn settle on a still-unmaterialized session: ask the engine
				// for its now-real id (single-flight; the runtime defers the call).
				requestStatusOnce();
			}
		},
		noteNewConversation: () => {
			pendingTitle = undefined; // the buffered title belonged to the prior conversation
			currentId = undefined; // /new emits only idle; force a re-bind
			statusRequested = false;
			requestStatusOnce();
		},
	};
}
