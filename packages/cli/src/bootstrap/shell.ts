/** POSIX single-quote escaping: wrap in '...', render embedded ' as '\''. Safe
 * for sh/bash/zsh; paths with spaces/$/"/backticks survive intact (finding B). */
export function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
