import { describe, expect, it } from "vitest";
import { TurnGate } from "./turn-gate.js";

describe("TurnGate", () => {
	it("serializes acquirers in order", async () => {
		const gate = new TurnGate();
		const order: number[] = [];
		const r1 = await gate.acquire();
		const p2 = gate.acquire().then((r) => {
			order.push(2);
			r();
		});
		order.push(1);
		r1();
		await p2;
		expect(order).toEqual([1, 2]);
	});

	it("third waiter runs after second releases", async () => {
		const gate = new TurnGate();
		const log: string[] = [];
		const r1 = await gate.acquire();
		const p2 = gate.acquire().then((r) => {
			log.push("two");
			r();
		});
		const p3 = gate.acquire().then((r) => {
			log.push("three");
			r();
		});
		r1();
		await Promise.all([p2, p3]);
		expect(log).toEqual(["two", "three"]);
	});

	it("a held gate blocks until released", async () => {
		const gate = new TurnGate();
		const r1 = await gate.acquire();
		let entered = false;
		const p2 = gate.acquire().then((r) => {
			entered = true;
			r();
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(entered).toBe(false);
		r1();
		await p2;
		expect(entered).toBe(true);
	});
});
