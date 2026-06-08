import { describe, expect, it } from "vitest";
import { classifyLine } from "./slash.js";

const KNOWN = new Set(["help", "new", "clear", "status", "skills", "copy", "usage", "quit", "exit"]);

describe("classifyLine", () => {
	it("plain text → submit", () => {
		expect(classifyLine("hello world", KNOWN)).toEqual({ kind: "submit" });
	});
	it("known command → command", () => {
		expect(classifyLine("/help", KNOWN)).toEqual({ kind: "command", name: "help", args: "" });
	});
	it("alias is known → command with the alias name", () => {
		expect(classifyLine("/clear", KNOWN)).toEqual({ kind: "command", name: "clear", args: "" });
	});
	it("captures args after the first whitespace, trimmed", () => {
		expect(classifyLine("/status   now ", KNOWN)).toEqual({
			kind: "command",
			name: "status",
			args: "now",
		});
	});
	it("case-insensitive name", () => {
		expect(classifyLine("/HELP", KNOWN)).toEqual({ kind: "command", name: "help", args: "" });
	});
	it("unknown command → unknown", () => {
		expect(classifyLine("/halp", KNOWN)).toEqual({ kind: "unknown", name: "halp" });
	});
	it("embedded slash (path) → submit", () => {
		expect(classifyLine("/tmp/foo.txt", KNOWN)).toEqual({ kind: "submit" });
		expect(classifyLine("/etc/hosts", KNOWN)).toEqual({ kind: "submit" });
		expect(classifyLine("/a.b", KNOWN)).toEqual({ kind: "submit" });
	});
	it("bare slash → submit", () => {
		expect(classifyLine("/", KNOWN)).toEqual({ kind: "submit" });
		expect(classifyLine("/ status", KNOWN)).toEqual({ kind: "submit" });
	});
	it("multiline (contains newline) → submit", () => {
		expect(classifyLine("foo\n/bar", KNOWN)).toEqual({ kind: "submit" });
		expect(classifyLine("/help\nmore", KNOWN)).toEqual({ kind: "submit" });
	});
});
