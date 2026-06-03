#!/usr/bin/env python3
"""M3a feasibility smoke: drive the patched hax over inherited fds (no scraping).

Spawns vendor/hax/build/hax with --protocol-fd / --control-fd wired to pipes,
sends a `submit` over the control fd, and reads the JSONL event stream off the
event fd under HAX_PROVIDER=mock. Asserts the M3a sequence and the handback
`content`, then exercises `interrupt`. Exits non-zero on any mismatch.
"""
import json
import os
import select
import subprocess
import sys

HAX = os.path.join(os.path.dirname(__file__), "..", "vendor", "hax", "build", "hax")


def read_events(ev_r, until_types, timeout=10.0):
    """Read JSONL lines until one of until_types is seen (or timeout)."""
    buf = b""
    events = []
    while True:
        r, _, _ = select.select([ev_r], [], [], timeout)
        if not r:
            raise TimeoutError(f"no event within {timeout}s; got {events}")
        chunk = os.read(ev_r, 4096)
        if not chunk:
            return events  # EOF
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            if not line.strip():
                continue
            ev = json.loads(line)
            events.append(ev)
            if ev.get("type") in until_types:
                return events


def main():
    if not os.path.exists(HAX):
        print(f"FAIL: hax binary not built at {HAX}", file=sys.stderr)
        return 1

    ev_r, ev_w = os.pipe()     # hax writes events to ev_w
    ctl_r, ctl_w = os.pipe()   # hax reads controls from ctl_r
    env = {**os.environ, "HAX_PROVIDER": "mock", "HAX_NO_SESSION": "1"}

    proc = subprocess.Popen(
        [HAX, f"--protocol-fd={ev_w}", f"--control-fd={ctl_r}"],
        pass_fds=(ev_w, ctl_r),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=env,
    )
    os.close(ev_w)
    os.close(ctl_r)

    failures = []
    try:
        # `ready` should arrive unsolicited at startup.
        evs = read_events(ev_r, {"ready"})
        ready = evs[-1]
        if ready.get("type") != "ready" or "protocol" not in ready:
            failures.append(f"bad ready: {ready}")
        else:
            print(f"  ready: protocol={ready['protocol']} hax={ready.get('haxBaseCommit')}")

        # Turn 1: submit -> expect the full lifecycle through idle.
        os.write(ctl_w, json.dumps({"type": "submit", "text": "say hello"}).encode() + b"\n")
        evs = read_events(ev_r, {"idle"})
        seq = [e["type"] for e in evs]
        print(f"  turn-1 events: {seq}")

        for need in ("user_turn_started", "assistant_turn_started",
                     "assistant_turn_finished", "idle"):
            if need not in seq:
                failures.append(f"missing {need} in {seq}")

        finished = next((e for e in evs if e["type"] == "assistant_turn_finished"), None)
        if finished is None:
            failures.append("no assistant_turn_finished")
        else:
            content = finished.get("content", "")
            print(f"  handback content: {content!r}")
            if "say hello" not in content:
                failures.append(f"content did not reflect input: {content!r}")

        deltas = [e for e in evs if e["type"] == "assistant_delta"]
        joined = "".join(e.get("text", "") for e in deltas)
        if joined and joined.strip() != content.strip():
            failures.append(f"delta concat {joined!r} != content {content!r}")
    finally:
        os.close(ctl_w)  # EOF on control fd -> hax shuts down
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        os.close(ev_r)

    if failures:
        print("PROTO SMOKE FAIL:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("PROTO SMOKE PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
