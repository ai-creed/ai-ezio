#!/usr/bin/env python3
"""M3a feasibility smoke: drive the patched hax over inherited fds (no scraping).

Phase 1 (lifecycle): send a `submit` and assert the EXACT ordered M3a sequence
  ready, user_turn_started, assistant_turn_started, assistant_delta(>=1),
  assistant_turn_finished{content}, idle — with deltas concatenating to content.
Phase 2 (interrupt): with a slow mock script, submit, then `interrupt` the live
  turn and assert it aborts back to idle promptly without delivering the full
  scripted text.

Exits non-zero on any mismatch.
"""
import json
import os
import subprocess
import sys
import tempfile
import time

HAX = os.path.join(os.path.dirname(__file__), "..", "vendor", "hax", "build", "hax")


class Engine:
    """Spawn hax with protocol fds wired and read/write JSONL over them."""

    def __init__(self, extra_env=None):
        self.ev_r, ev_w = os.pipe()
        ctl_r, self.ctl_w = os.pipe()
        env = {**os.environ, "HAX_PROVIDER": "mock", "HAX_NO_SESSION": "1"}
        if extra_env:
            env.update(extra_env)
        self.proc = subprocess.Popen(
            [HAX, f"--protocol-fd={ev_w}", f"--control-fd={ctl_r}"],
            pass_fds=(ev_w, ctl_r),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
        )
        os.close(ev_w)
        os.close(ctl_r)
        self._buf = b""

    def send(self, control):
        os.write(self.ctl_w, json.dumps(control).encode() + b"\n")

    def read_until(self, types, timeout=10.0):
        """Read events until one whose type is in `types`; return all collected."""
        import select

        events = []
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"no {types} within {timeout}s; got {events}")
            r, _, _ = select.select([self.ev_r], [], [], remaining)
            if not r:
                continue
            chunk = os.read(self.ev_r, 4096)
            if not chunk:
                return events
            self._buf += chunk
            while b"\n" in self._buf:
                line, self._buf = self._buf.split(b"\n", 1)
                if not line.strip():
                    continue
                ev = json.loads(line)
                events.append(ev)
                if ev.get("type") in types:
                    return events

    def close(self):
        try:
            os.close(self.ctl_w)
        except OSError:
            pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        os.close(self.ev_r)


def phase_lifecycle(failures):
    eng = Engine()
    try:
        ready = eng.read_until({"ready"})[-1]
        if ready.get("type") != "ready" or "protocol" not in ready:
            failures.append(f"bad ready: {ready}")
        eng.send({"type": "submit", "text": "say hello"})
        evs = eng.read_until({"idle"})
        seq = [e["type"] for e in evs]
        print(f"  lifecycle: ready + {seq}")

        # Exact required ordered subsequence (deltas required).
        required = [
            "user_turn_started",
            "assistant_turn_started",
            "assistant_delta",
            "assistant_turn_finished",
            "idle",
        ]
        pos = 0
        for t in seq:
            if pos < len(required) and t == required[pos]:
                pos += 1
        if pos != len(required):
            failures.append(f"sequence missing/oo-order; need {required} as subseq of {seq}")

        deltas = [e for e in evs if e["type"] == "assistant_delta"]
        if not deltas:
            failures.append("no assistant_delta emitted (required in M3a)")
        finished = next((e for e in evs if e["type"] == "assistant_turn_finished"), None)
        content = finished.get("content", "") if finished else ""
        if "say hello" not in content:
            failures.append(f"content did not reflect input: {content!r}")
        joined = "".join(e.get("text", "") for e in deltas)
        if joined.strip() != content.strip():
            failures.append(f"delta concat {joined!r} != content {content!r}")
    finally:
        eng.close()


def phase_interrupt(failures):
    script = tempfile.NamedTemporaryFile("w", suffix=".mock", delete=False)
    # One slow turn: a 2.5s delay before any text. The agent's stream tick polls
    # the control fd every ~50ms during the delay, so `interrupt` aborts it.
    script.write("delay 2500\ntext THIS_SHOULD_NOT_APPEAR\nend-turn\n")
    script.close()
    eng = Engine(extra_env={"HAX_MOCK_SCRIPT": script.name})
    try:
        eng.read_until({"ready"})
        eng.send({"type": "submit", "text": "go"})
        # Wait until the assistant turn is live, then interrupt it.
        eng.read_until({"assistant_turn_started"})
        t0 = time.monotonic()
        eng.send({"type": "interrupt"})
        evs = eng.read_until({"idle"}, timeout=5.0)
        elapsed = time.monotonic() - t0
        print(f"  interrupt: returned to idle in {elapsed:.2f}s; {[e['type'] for e in evs]}")
        if elapsed >= 2.0:
            failures.append(f"interrupt did not abort promptly ({elapsed:.2f}s ~ full 2.5s delay)")
        if any("THIS_SHOULD_NOT_APPEAR" in e.get("text", "") for e in evs):
            failures.append("interrupted turn still delivered the scripted text")
        if not any(e["type"] == "idle" for e in evs):
            failures.append("no idle after interrupt")
    finally:
        eng.close()
        os.unlink(script.name)


def main():
    if not os.path.exists(HAX):
        print(f"FAIL: hax binary not built at {HAX}", file=sys.stderr)
        return 1
    failures = []
    phase_lifecycle(failures)
    phase_interrupt(failures)
    if failures:
        print("PROTO SMOKE FAIL:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("PROTO SMOKE PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
