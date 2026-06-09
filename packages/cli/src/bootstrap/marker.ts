import { configDir, markerPath } from "./paths.js";
export interface MarkerWriteDeps {
	mkdirp: (dir: string) => void;
	writeFile: (path: string, text: string) => void;
}
export function isBootstrapped(
	env: NodeJS.ProcessEnv,
	fileExists: (p: string) => boolean,
): boolean {
	return fileExists(markerPath(env));
}
export function writeMarker(env: NodeJS.ProcessEnv, deps: MarkerWriteDeps): void {
	deps.mkdirp(configDir(env));
	deps.writeFile(markerPath(env), "bootstrapped\n");
}
