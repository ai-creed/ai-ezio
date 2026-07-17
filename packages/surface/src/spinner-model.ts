/**
 * Pure spinner state model for the mounted renderer — no timers, no I/O; the
 * renderer owns the 80 ms tick and asks `frame()` what to draw. Ports hax's
 * spinner rework (settle-hysteresis labels, elapsed counter on long turns)
 * onto ezio's protocol events; spec:
 * docs/superpowers/specs/2026-07-15-ux-slice1-mounted-polish-design.md.
 */
import type { ProtocolEvent } from "@ai-ezio/protocol";
import stringWidth from "string-width";

/** A specific label is adopted only after its phase holds this long. */
export const SETTLE_MS = 2000;
/** Unsettled churn longer than this demotes the label to "working…". */
export const CHURN_MS = 2000;
/** The elapsed counter appears once a user turn has run this long. */
export const COUNTER_MS = 30_000;

const FRAMES_UTF8 = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAMES_ASCII = ["-", "\\", "|", "/"];

/** `42s` under a minute, `1m 32s` above — shared by the counter and stats line. */
export function fmtDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}

type Phase = { kind: "idle" } | { kind: "thinking" } | { kind: "tool"; name: string };

const specificLabel = (p: Phase): string =>
	p.kind === "tool" ? `[${p.name}] running…` : "thinking…";

export interface SpinnerModel {
	/** Fold one protocol event in. Returns the next model (immutably). */
	reduce(event: ProtocolEvent, nowMs: number): SpinnerModel;
	/** What the tick should draw (plain text, no ANSI). null = hidden. */
	frame(nowMs: number, frameIndex: number, columns: number): string | null;
}

interface Snap {
	phase: Phase;
	turnStartAt: number; // -1 = counter disarmed
	phaseChangedAt: number;
	/** Label of the last phase that settled (seeded with the turn's initial
	 * ground-truth label). Shown while a young phase hasn't settled. */
	settledLabel: string | null;
	/** Start of the current unsettled stretch; -1 when settled. */
	unsettledSince: number;
}

const cells = (s: string): number => {
	let n = 0;
	for (const cp of s) n += stringWidth(cp);
	return n;
};

export function createSpinnerModel(opts: { utf8: boolean }): SpinnerModel {
	const frames = opts.utf8 ? FRAMES_UTF8 : FRAMES_ASCII;

	const make = (s: Snap): SpinnerModel => {
		const model: SpinnerModel = {
			reduce(event, now) {
				switch (event.type) {
					case "user_turn_started":
						return make({
							phase: { kind: "thinking" },
							turnStartAt: now,
							phaseChangedAt: now,
							// Ground truth on first draw — no settle wait initially.
							settledLabel: "thinking…",
							unsettledSince: -1,
						});
					case "tool_call_started":
						return change(s, { kind: "tool", name: event.name }, now);
					case "tool_call_finished":
						return change(s, { kind: "thinking" }, now);
					case "assistant_turn_finished":
					case "idle":
					case "error":
						return make({
							phase: { kind: "idle" },
							turnStartAt: -1,
							phaseChangedAt: now,
							settledLabel: null,
							unsettledSince: -1,
						});
					default:
						return model;
				}
			},
			frame(now, frameIndex, columns) {
				if (s.phase.kind === "idle") return null;
				const glyph = frames[frameIndex % frames.length] ?? frames[0];
				const label = displayLabel(s, now);
				const elapsed = s.turnStartAt >= 0 ? now - s.turnStartAt : -1;
				if (elapsed >= COUNTER_MS) {
					const withCounter = `${glyph} ${fmtDuration(elapsed)} · ${label}`;
					// Overflow drops the counter, never the label (upstream's rule).
					if (cells(withCounter) <= columns - 1) return withCounter;
				}
				return `${glyph} ${label}`;
			},
		};
		return model;
	};

	/** Mid-turn phase change: a settled outgoing phase becomes the sticky
	 * label; an unsettled one keeps the previous sticky label and leaves the
	 * churn clock running from the stretch's first change. */
	const change = (prev: Snap, phase: Phase, now: number): SpinnerModel => {
		if (prev.phase.kind === "idle") return make(prev); // tool event outside a turn
		const prevSettled = now - prev.phaseChangedAt >= SETTLE_MS;
		return make({
			phase,
			turnStartAt: prev.turnStartAt,
			phaseChangedAt: now,
			settledLabel: prevSettled ? specificLabel(prev.phase) : prev.settledLabel,
			unsettledSince: prevSettled ? now : prev.unsettledSince === -1 ? now : prev.unsettledSince,
		});
	};

	const displayLabel = (s: Snap, now: number): string => {
		if (now - s.phaseChangedAt >= SETTLE_MS) return specificLabel(s.phase);
		if (s.settledLabel !== null && s.unsettledSince !== -1 && now - s.unsettledSince >= CHURN_MS)
			return "working…";
		return s.settledLabel ?? "working…";
	};

	return make({
		phase: { kind: "idle" },
		turnStartAt: -1,
		phaseChangedAt: 0,
		settledLabel: null,
		unsettledSince: -1,
	});
}
