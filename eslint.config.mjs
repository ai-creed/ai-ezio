// @ts-check
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

/** Flat ESLint config. Source-only: the vendored C engine and build output are
 * never linted by the TS toolchain. */
export default [
	{
		ignores: ["vendor/**", "**/dist/**", "node_modules/**", "packaging/**/bin/**"],
	},
	{
		files: ["packages/**/*.ts", "scripts/**/*.mjs"],
		languageOptions: {
			parser: tsparser,
			parserOptions: {
				ecmaVersion: 2023,
				sourceType: "module",
			},
		},
		plugins: {
			"@typescript-eslint": tseslint,
		},
		rules: {
			"no-unused-vars": "off",
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
			"no-console": "off",
			eqeqeq: ["error", "always"],
		},
	},
];
