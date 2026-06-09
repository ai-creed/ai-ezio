export type Manager = "npm" | "pnpm";
export interface InstallDeps {
	run: (cmd: string, args: string[]) => { ok: boolean; stderr?: string };
}
export interface InstallResult {
	ok: boolean;
	error?: string;
}
export function installPeer(manager: Manager, pkg: string, deps: InstallDeps): InstallResult {
	const args = manager === "pnpm" ? ["add", "-g", pkg] : ["install", "-g", pkg];
	const r = deps.run(manager, args);
	return r.ok ? { ok: true } : { ok: false, error: r.stderr ?? "install failed" };
}
