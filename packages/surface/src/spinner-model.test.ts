import { describe, expect, it } from "vitest";
import {
	CHURN_MS,
	COUNTER_MS,
	createSpinnerModel,
	fmtDuration,
	SETTLE_MS,
	type SpinnerModel,
} from "./spinner-model.js";

const turnStart = (t: number, m: SpinnerModel) =>
	m.reduce({ type: "user_turn_started", turnId: "t1" }, t);
const toolStart = (t: number, m: SpinnerModel, name = "bash") =>
	m.reduce({ type: "tool_call_started", turnId: "t1", callId: "c1", name }, t);
const toolEnd = (t: number, m: SpinnerModel) =>
	m.reduce(
		{
			type: "tool_call_finished",
			turnId: "t1",
			callId: "c1",
			name: "bash",
			status: "ok",
		},
		t,
	);

describe("fmtDuration", () => {
	it("formats seconds below a minute and m/s above", () => {
		expect(fmtDuration(42_000)).toBe("42s");
		expect(fmtDuration(59_999)).toBe("59s");
		expect(fmtDuration(92_000)).toBe("1m 32s");
	});
});

describe("createSpinnerModel", () => {
	it("is hidden when idle and visible with an immediate specific label on turn start", () => {
		let m = createSpinnerModel({ utf8: true });
		expect(m.frame(0, 0, 80)).toBeNull();
		m = turnStart(1000, m);
		// Ground truth on first draw — no settle wait for the initial label.
		expect(m.frame(1000, 0, 80)).toBe("⠋ thinking…");
	});

	it("keeps the previous settled label until a young phase settles", () => {
		let m = turnStart(0, createSpinnerModel({ utf8: true }));
		m = toolStart(SETTLE_MS + 500, m); // thinking held 2.5s -> settled
		// Tool phase is young: still shows the settled "thinking…".
		expect(m.frame(SETTLE_MS + 600, 0, 80)).toBe("⠋ thinking…");
		// Tool phase held SETTLE_MS: adopts its specific label.
		expect(m.frame(SETTLE_MS + 500 + SETTLE_MS, 0, 80)).toBe("⠋ [bash] running…");
	});

	it("never flashes a short tool burst's label", () => {
		let m = turnStart(0, createSpinnerModel({ utf8: true }));
		m = toolStart(3000, m, "read"); // thinking settled first
		m = toolEnd(3300, m); // 300ms read burst
		// During and right after the burst: still the settled "thinking…".
		expect(m.frame(3100, 0, 80)).toBe("⠋ thinking…");
		expect(m.frame(3400, 0, 80)).toBe("⠋ thinking…");
	});

	it("demotes to working… under sustained churn and recovers after settling", () => {
		let m = turnStart(0, createSpinnerModel({ utf8: true }));
		m = toolStart(3000, m, "a"); // first unsettled change at t=3000
		m = toolEnd(3500, m);
		m = toolStart(4000, m, "b");
		m = toolEnd(4500, m);
		// Churn stretch outlives CHURN_MS (started 3000): demoted.
		expect(m.frame(3000 + CHURN_MS + 100, 0, 80)).toBe("⠋ working…");
		// The last phase (thinking since 4500) settles after SETTLE_MS: recovers.
		expect(m.frame(4500 + SETTLE_MS, 0, 80)).toBe("⠋ thinking…");
	});

	it("shows the elapsed counter only from COUNTER_MS, leading the label", () => {
		const m = turnStart(0, createSpinnerModel({ utf8: true }));
		expect(m.frame(COUNTER_MS - 100, 0, 80)).toBe("⠋ thinking…");
		expect(m.frame(COUNTER_MS, 0, 80)).toBe("⠋ 30s · thinking…");
		expect(m.frame(92_000, 0, 80)).toBe("⠋ 1m 32s · thinking…");
	});

	it("counter survives a label swap (computed from the armed base)", () => {
		let m = turnStart(0, createSpinnerModel({ utf8: true }));
		m = toolStart(35_000, m);
		m = m.reduce(
			{
				type: "tool_call_finished",
				turnId: "t1",
				callId: "c1",
				name: "bash",
				status: "ok",
			},
			40_000,
		);
		expect(m.frame(41_000, 0, 80)).toContain("41s · ");
	});

	it("drops the counter (never the label) when the row would overflow", () => {
		const m = turnStart(0, createSpinnerModel({ utf8: true }));
		// "⠋ 30s · thinking…" is 17 cells; at columns=17 it exceeds columns-1.
		expect(m.frame(COUNTER_MS, 0, 17)).toBe("⠋ thinking…");
		expect(m.frame(COUNTER_MS, 0, 80)).toBe("⠋ 30s · thinking…");
	});

	it("uses ASCII frames when utf8 is false", () => {
		let m = createSpinnerModel({ utf8: false });
		m = turnStart(0, m);
		expect(m.frame(0, 0, 80)).toBe("- thinking…");
		expect(m.frame(0, 1, 80)).toBe("\\ thinking…");
	});

	it("hides on turn end, idle, and error; unknown events are no-ops", () => {
		const m = turnStart(0, createSpinnerModel({ utf8: true }));
		const finished = m.reduce({ type: "assistant_turn_finished", turnId: "t1", content: "" }, 1000);
		expect(finished.frame(1000, 0, 80)).toBeNull();
		expect(m.reduce({ type: "idle" }, 1000).frame(1000, 0, 80)).toBeNull();
		expect(m.reduce({ type: "error", message: "boom" }, 1000).frame(1000, 0, 80)).toBeNull();
		// Unknown/other events change nothing.
		const same = m.reduce({ type: "assistant_delta", turnId: "t1", text: "x" }, 500);
		expect(same.frame(500, 0, 80)).toBe("⠋ thinking…");
	});

	it("ignores tool events outside a turn", () => {
		const m = toolStart(100, createSpinnerModel({ utf8: true }));
		expect(m.frame(100, 0, 80)).toBeNull();
	});
});
