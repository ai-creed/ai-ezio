import { describe, expect, it } from "vitest";
import { ADAPTER_NAME } from "./index.js";

describe("adapter", () => {
	it("ships under the ai-whisper adapter name", () => {
		expect(ADAPTER_NAME).toBe("adapter-ai-ezio");
	});
});
