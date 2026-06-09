import { createInterface } from "node:readline/promises";
export interface PromptIO {
	ask: (question: string) => Promise<string>;
}
export async function askYesNo(
	io: PromptIO,
	question: string,
	defaultYes: boolean,
): Promise<boolean> {
	const raw = (await io.ask(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).trim().toLowerCase();
	if (raw === "") return defaultYes;
	return raw === "y" || raw === "yes";
}
export function nodePromptIO(): PromptIO {
	return {
		ask: async (q) => {
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			try {
				return await rl.question(q);
			} finally {
				rl.close();
			}
		},
	};
}
