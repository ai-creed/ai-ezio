/** Tool namespacing: a server's tool is advertised as `<server>__<tool>`. */

/** Advertised name for a server's tool. Tool names may themselves contain "__";
 * RouteMap resolves by exact registered key, so collisions across servers can't
 * mis-route (first writer wins; the host logs on collision at the call site). */
export function encodeToolName(server: string, tool: string): string {
	return `${server}__${tool}`;
}

export interface Route {
	server: string;
	tool: string;
}

export class RouteMap {
	private readonly map = new Map<string, Route>();

	/** Register a server tool; returns its namespaced name. First writer wins. */
	add(server: string, tool: string): string {
		const name = encodeToolName(server, tool);
		if (!this.map.has(name)) this.map.set(name, { server, tool });
		return name;
	}

	resolve(name: string): Route | undefined {
		return this.map.get(name);
	}

	names(): string[] {
		return [...this.map.keys()];
	}
}
