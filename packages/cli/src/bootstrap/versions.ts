export type PeerName = "cortex" | "whisper";
export const MIN_CORTEX = "0.14.0";
export const MIN_WHISPER = "0.5.0";
const PKG: Record<PeerName, string> = { cortex: "ai-cortex", whisper: "ai-whisper" };
const MIN: Record<PeerName, string> = { cortex: MIN_CORTEX, whisper: MIN_WHISPER };

export type CompatResult =
	| { state: "compatible" }
	| { state: "below-min"; min: string; guide: string }
	| { state: "unknown" };

export function compareSemver(a: string, b: string): number {
	const pa = a.split(".").map((n) => Number.parseInt(n, 10));
	const pb = b.split(".").map((n) => Number.parseInt(n, 10));
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}
export function checkCompat(peer: PeerName, installed: string | null): CompatResult {
	if (installed === null || !/^\d+\.\d+\.\d+/.test(installed)) return { state: "unknown" };
	if (compareSemver(installed, MIN[peer]) >= 0) return { state: "compatible" };
	return {
		state: "below-min",
		min: MIN[peer],
		guide: `Detected ${PKG[peer]} ${installed}; ezio needs >= ${MIN[peer]}. To upgrade: npm i -g ${PKG[peer]}@latest`,
	};
}
