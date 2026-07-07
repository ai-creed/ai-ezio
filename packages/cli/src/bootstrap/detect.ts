/** Read-only environment + peer detection. Presence = bin on PATH OR package in
 * a manager's global list; owning manager = the one whose -g list has ai-ezio. */
import type { PeerName } from "./versions.js";

export interface PeerState {
	name: PeerName;
	bin: string;
	present: boolean;
	version: string | null;
}
export interface Environment {
	isTTY: boolean;
	isCI: boolean;
	manager: "npm" | "pnpm" | null;
	peers: Record<PeerName, PeerState>;
}
export interface DetectDeps {
	which: (cmd: string) => string | null;
	versionOf: (bin: string) => string | null;
	globalList: (manager: "npm" | "pnpm") => string[]; // package names; [] if absent/errors
	isTTY: () => boolean;
	env: NodeJS.ProcessEnv;
}

const BIN: Record<PeerName, string> = { cortex: "ai-cortex", whisper: "whisper" };
const PKG: Record<PeerName, string> = { cortex: "ai-cortex", whisper: "ai-whisper" };

/** Parse `<mgr> ls -g --depth=0 --json`: npm emits an OBJECT (`{dependencies:{…}}`)
 * while pnpm emits an ARRAY (`[{dependencies:{…}}]`, possibly with no deps key) —
 * handle both shapes, else []. (init-cli wires execFileSync to this.) */
export function parseGlobalList(jsonText: string): string[] {
	try {
		type ListEntry = { dependencies?: Record<string, unknown> } | null;
		const parsed = JSON.parse(jsonText) as ListEntry | ListEntry[];
		const entries = Array.isArray(parsed) ? parsed : [parsed];
		const names = new Set<string>();
		for (const e of entries) for (const k of Object.keys(e?.dependencies ?? {})) names.add(k);
		return [...names];
	} catch {
		return [];
	}
}

export function detectEnvironment(deps: DetectDeps): Environment {
	const hasNpm = deps.which("npm") !== null;
	const hasPnpm = deps.which("pnpm") !== null;
	const npmList = hasNpm ? deps.globalList("npm") : [];
	const pnpmList = hasPnpm ? deps.globalList("pnpm") : [];
	const all = new Set([...npmList, ...pnpmList]);
	const manager: Environment["manager"] = npmList.includes("ai-ezio")
		? "npm"
		: pnpmList.includes("ai-ezio")
			? "pnpm"
			: hasNpm
				? "npm"
				: hasPnpm
					? "pnpm"
					: null;
	const peerState = (name: PeerName): PeerState => {
		const present = deps.which(BIN[name]) !== null || all.has(PKG[name]);
		return { name, bin: BIN[name], present, version: present ? deps.versionOf(BIN[name]) : null };
	};
	return {
		isTTY: deps.isTTY(),
		isCI: Boolean(deps.env.CI),
		manager,
		peers: { cortex: peerState("cortex"), whisper: peerState("whisper") },
	};
}
