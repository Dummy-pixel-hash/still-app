"""Real tmux/PTY mouse + OSC52 check. Uses and cleans up only a private server."""
import base64
import fcntl
import os
import pty
import re
import select
import struct
import subprocess
import tempfile
import termios
import time

with tempfile.TemporaryDirectory(prefix="still-tmux-") as temp:
    socket = os.path.join(temp, "test.sock")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
    env = dict(os.environ, TERM="xterm-256color")
    env.pop("TMUX", None)
    proc = subprocess.Popen([
        "tmux", "-S", socket, "-f", "/dev/null", "-u", "new-session", "-s", "probe",
        "seq 1 200; sleep 30", ";", "set-option", "-t", "probe", "mouse", "on",
        ";", "set-option", "-s", "set-clipboard", "on",
    ], stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
    os.close(slave)

    def tmux(*args):
        return subprocess.check_output(["tmux", "-S", socket, *args], env=env).strip()

    def drain(seconds=0.2):
        out = bytearray()
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if select.select([master], [], [], max(0, end - time.monotonic()))[0]:
                try:
                    out.extend(os.read(master, 65536))
                except OSError:
                    break
        return bytes(out)

    try:
        initial = drain(0.5)
        assert proc.poll() is None, initial.decode(errors="replace")
        assert b"\x1b[?1006h" in initial, "tmux must request SGR mouse input"
        os.write(master, b"\x1b[<64;5;5M")
        drain()
        assert tmux("display-message", "-p", "-t", "probe", "#{pane_in_mode}") == b"1", "wheel must enter copy-mode history"
        # tmux's first wheel tick enters copy mode; subsequent ticks scroll it.
        os.write(master, b"\x1b[<64;5;5M" * 3)
        drain()
        position = int(tmux("display-message", "-p", "-t", "probe", "#{scroll_position}"))
        assert position > 0, "wheel must move through history"
        tmux("send-keys", "-X", "-t", "probe", "top-line")
        tmux("send-keys", "-X", "-t", "probe", "start-of-line")
        tmux("send-keys", "-X", "-t", "probe", "begin-selection")
        tmux("send-keys", "-X", "-t", "probe", "cursor-down")
        tmux("send-keys", "-X", "-t", "probe", "copy-selection-and-cancel")
        output = drain(0.5)
        # tmux emits OSC 52 with an EMPTY selection name: ESC ] 52 ; ; <base64> ST
        transfers = re.findall(rb"\x1b\]52;([^;]*);([A-Za-z0-9+/=]+)(?:\x07|\x1b\\)", output)
        assert transfers, "tmux copy-mode selection must produce an OSC52 transfer"
        selector, payload = transfers[-1]
        assert selector in (b"", b"c"), f"unexpected OSC52 selector {selector!r}"
        text = base64.b64decode(payload).decode("utf-8")
        assert re.fullmatch(r"\d+\n?", text), f"copied text must be real pane content, got {text!r}"
        print("PASS real tmux: wheel enters copy-mode and scrolls history; copy-mode emits OSC52",
              f"({selector or b'empty'} selector, {len(text)} chars)")
    finally:
        subprocess.run(["tmux", "-S", socket, "kill-server"], env=env, capture_output=True)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        os.close(master)
