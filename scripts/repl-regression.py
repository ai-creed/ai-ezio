#!/usr/bin/env python3
"""M3a no-fd regression: the INTERACTIVE human REPL must be byte-for-byte
unchanged by the protocol patch.

Drives two hax binaries (a pre-patch baseline and the patched build) through a
PTY with the *same* scripted interactive session under HAX_PROVIDER=mock and NO
protocol fds, captures each one's full stdout, and asserts the byte streams are
identical. The patch's no-fd code path is gated by construction, so identical
PTY input must yield identical bytes; the mock provider answers instantly so the
time-based busy spinner never arms.

Usage: repl-regression.py <baseline-hax> <patched-hax>
"""
import os
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import fcntl
import time

# The "working..." spinner cycles a Braille glyph (U+2800–U+28FF) whose frame is
# a function of wall-clock elapsed time — the one legitimately time-variant byte
# in the no-fd REPL output. Normalize it to a fixed placeholder in BOTH captures
# before comparing (documented in the M3 plan's determinism note). Everything
# else must match byte-for-byte.
_BRAILLE = re.compile(b"\xe2[\xa0-\xa3][\x80-\xbf]")
# After glyph normalization, the "working..." spinner repaints as identical units;
# the NUMBER of repaints is also wall-clock-dependent (how many ~1Hz ticks elapse
# before the instant mock answers), on identical spinner code. Collapse a run of
# repaints to one canonical frame so only genuine rendering differences remain.
_SPIN_UNIT = b"\r\x1b[K\x1b[2m\xe2\xa0\x80 working...\x1b[0m"
_SPINS = re.compile(b"(?:" + re.escape(_SPIN_UNIT) + b")+")


def normalize(b):
    b = _BRAILLE.sub(b"\xe2\xa0\x80", b)
    b = _SPINS.sub(_SPIN_UNIT, b)
    return b


def drive(binary):
    master, slave = pty.openpty()
    # Fixed 80x24 window so any wrapping is identical across both runs.
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    env = {
        **os.environ,
        "HAX_PROVIDER": "mock",
        "HAX_NO_SESSION": "1",
        "TERM": "xterm-256color",
    }
    proc = subprocess.Popen(
        [binary],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
        env=env,
        close_fds=True,
    )
    os.close(slave)

    # Quiescence-synced script: send each input only after the program has been
    # quiet for `quiet_s`, so the captured byte ORDER is identical across both
    # binaries regardless of absolute timing (the mock answers instantly).
    inputs = [b"say hello\r", b"\x04"]  # type a prompt, then Ctrl-D to exit
    quiet_s = 0.4
    out = bytearray()
    idx = 0
    last_data = time.monotonic()
    start = time.monotonic()
    while True:
        r, _, _ = select.select([master], [], [], 0.05)
        if r:
            try:
                chunk = os.read(master, 4096)
            except OSError:
                chunk = b""
            if not chunk:
                break  # EOF
            out += chunk
            last_data = time.monotonic()
            continue
        quiet = time.monotonic() - last_data
        if quiet >= quiet_s:
            if idx < len(inputs):
                try:
                    os.write(master, inputs[idx])
                except OSError:
                    pass
                idx += 1
                last_data = time.monotonic()  # wait for the response to this input
            elif proc.poll() is not None:
                break
        if time.monotonic() - start > 10.0:
            proc.kill()
            break
    os.close(master)
    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()
    return bytes(out)


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    baseline_bin, patched_bin = sys.argv[1], sys.argv[2]
    baseline = normalize(drive(baseline_bin))
    patched = normalize(drive(patched_bin))
    if baseline == patched:
        print(
            f"REPL REGRESSION PASS: interactive stdout identical ({len(patched)} bytes, "
            "spinner glyph normalized)"
        )
        return 0
    print("REPL REGRESSION FAIL: interactive stdout differs")
    print(f"  baseline {len(baseline)} bytes, patched {len(patched)} bytes")
    for i in range(min(len(baseline), len(patched))):
        if baseline[i] != patched[i]:
            lo = max(0, i - 20)
            print(f"  first diff at byte {i}:")
            print(f"    baseline: {baseline[lo:i+20]!r}")
            print(f"    patched:  {patched[lo:i+20]!r}")
            break
    return 1


if __name__ == "__main__":
    sys.exit(main())
