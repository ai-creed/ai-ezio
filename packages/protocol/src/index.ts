/**
 * @ai-ezio/protocol — the wire contract between the hax engine and the ai-ezio
 * harness.
 *
 * M1 scope: the package skeleton plus the protocol version constant and the
 * semver-major compatibility check the harness uses to refuse driving an engine
 * it does not understand. The full JSONL event/control schema, codec, and fd
 * transport land in M3 (see docs/protocol.md and docs/superpowers/plans).
 */

/** Protocol version this harness speaks. Bump major only on breaking changes. */
export const PROTOCOL_VERSION = "0.1.0";

/** Parse a semver "MAJOR.MINOR.PATCH" string into its numeric major component. */
export function semverMajor(version: string): number {
	const major = Number.parseInt(version.split(".", 1)[0] ?? "", 10);
	if (Number.isNaN(major)) {
		throw new Error(`Invalid semver version string: "${version}"`);
	}
	return major;
}

/**
 * True when the harness (speaking `ours`) can drive an engine announcing
 * `theirs` in its `ready` event. Same major version is required.
 */
export function isProtocolCompatible(theirs: string, ours: string = PROTOCOL_VERSION): boolean {
	return semverMajor(theirs) === semverMajor(ours);
}
