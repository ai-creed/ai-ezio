import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type ProtocolEvent, type Transport } from "@ai-ezio/protocol";
import { Session } from "./session.js";
import type { SpawnHaxOptions, SpawnedHax } from "./spawn.js";

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

const ready = (sessionId = "s"): ProtocolEvent =>
	({
		type: "ready",
		sessionId,
		protocol: PROTOCOL_VERSION,
		haxBaseCommit: "c",
	}) as unknown as ProtocolEvent;

/** Hand-driven transport: push events, end explicitly. */
function fakeTransport() {
	let push!: (e: ProtocolEvent) => void;
	let end!: () => void;
	const events = (async function* (): AsyncGenerator<ProtocolEvent> {
		const buf: ProtocolEvent[] = [];
		let done = false;
		let wake: (() => void) | null = null;
		push = (e) => (buf.push(e), wake?.());
		end = () => ((done = true), wake?.());
		for (;;) {
			if (buf.length) {
				yield buf.shift()!;
				continue;
			}
			if (done) return;
			await new Promise<void>((r) => (wake = r));
		}
	})();
	const transport: Transport = { events: () => events, send: () => {}, close: () => {} };
	return { transport, push: (e: ProtocolEvent) => push(e), end: () => end() };
}

function makeCaptured(
	engineEnvOverrides: NodeJS.ProcessEnv | undefined,
	transports: ReturnType<typeof fakeTransport>[],
) {
	let i = 0;
	const captured: SpawnHaxOptions[] = [];
	const session = new Session({
		engineEnvOverrides,
		spawn: (options: SpawnHaxOptions): SpawnedHax => {
			captured.push(options);
			return {
				child: { on: () => {}, kill: () => {} } as never,
				eventStream: new PassThrough(),
				controlStream: new PassThrough(),
			};
		},
		transportFactory: () => transports[i++]!.transport,
	});
	return { session, captured };
}

describe("Session.engineEnvOverrides", () => {
	it("force-offs HAX_COMPACT_AUTO on a fresh start despite inherited =1", async () => {
		const t = fakeTransport();
		const { session, captured } = makeCaptured({ HAX_COMPACT_AUTO: "0" }, [t]);
		const p = session.start({ env: { HAX_COMPACT_AUTO: "1" } });
		t.push(ready());
		await p;
		expect(captured[0]!.env!.HAX_COMPACT_AUTO).toBe("0");
	});

	it("force-offs on the startWithTranscript-shaped start({ args, transcriptPath })", async () => {
		const t = fakeTransport();
		const { session, captured } = makeCaptured({ HAX_COMPACT_AUTO: "0" }, [t]);
		const p = session.start({
			env: { HAX_COMPACT_AUTO: "1" },
			args: ["--resume=x"],
			transcriptPath: "/t",
		});
		t.push(ready());
		await p;
		expect(captured[0]!.env!.HAX_COMPACT_AUTO).toBe("0");
	});

	it("force-offs on resume()", async () => {
		const t1 = fakeTransport();
		const t2 = fakeTransport();
		const { session, captured } = makeCaptured({ HAX_COMPACT_AUTO: "0" }, [t1, t2]);
		const p1 = session.start({ env: { HAX_COMPACT_AUTO: "1" } });
		t1.push(ready());
		await p1;
		const p2 = session.resume("id", { env: { HAX_COMPACT_AUTO: "1" } });
		// resume() acquires the gate, bumps the generation, calls close(), and PARKS at
		// `await pumpDone`. The fake child kill + transport.close() are no-ops, so the OLD
		// pump only ends when we call t1.end(). Without it, `await dying` (and the whole
		// resume) hangs and t2 is never spawned — mirror session-resume.test.ts's ordering.
		await flush();
		t1.end();
		await flush();
		t2.push(ready("id"));
		await p2;
		expect(captured[1]!.env!.HAX_COMPACT_AUTO).toBe("0");
	});

	it("does NOT clobber an explicit =1 when no overrides are set (subagent path)", async () => {
		const t = fakeTransport();
		const { session, captured } = makeCaptured(undefined, [t]);
		const p = session.start({ env: { HAX_COMPACT_AUTO: "1" } });
		t.push(ready());
		await p;
		expect(captured[0]!.env!.HAX_COMPACT_AUTO).toBe("1");
	});
});
