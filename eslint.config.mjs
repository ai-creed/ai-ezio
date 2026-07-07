// @ts-check
import tseslint from "typescript-eslint";

/** Flat ESLint config. Source-only: the vendored C engine and build output are
 * never linted by the TS toolchain. `packages/` is linted type-aware (see
 * tsconfig.eslint.json); the plain-JS scripts keep the untyped baseline. */
export default tseslint.config(
	{
		ignores: ["vendor/**", "**/dist/**", "node_modules/**", "packaging/**/bin/**"],
	},
	{
		files: ["packages/**/*.ts"],
		extends: [...tseslint.configs.recommendedTypeChecked],
		languageOptions: {
			parserOptions: {
				project: "./tsconfig.eslint.json",
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
			eqeqeq: ["error", "always"],
			// declare-then-assign-once with closure reads before the assignment
			// (e.g. an event tee consulting a slot wired later) is a deliberate
			// pattern here, not a missed const.
			"prefer-const": ["error", { ignoreReadBeforeAssign: true }],
		},
	},
	{
		// Test files: mocks legitimately declare async interface methods with no
		// awaits, get passed around unbound, and traffic in loosely-typed
		// fixtures. no-floating-promises and the rest of the preset stay on.
		files: ["packages/**/*.test.ts"],
		rules: {
			"@typescript-eslint/require-await": "off",
			"@typescript-eslint/unbound-method": "off",
			"@typescript-eslint/no-unsafe-argument": "off",
			"@typescript-eslint/no-unsafe-assignment": "off",
			"@typescript-eslint/no-unsafe-call": "off",
			"@typescript-eslint/no-unsafe-member-access": "off",
			"@typescript-eslint/no-unsafe-return": "off",
		},
	},
	{
		files: ["scripts/**/*.mjs"],
		extends: [...tseslint.configs.recommended],
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
			eqeqeq: ["error", "always"],
		},
	},
);
