#!/usr/bin/env python3
"""Drive a command under a real pty and feed it one line of input.

  printf '%s\\n' "$VALUE" | python3 pty-drive.py <cwd> -- <cmd> [args...]

The line to type is read from this process's OWN stdin, one line, and never
taken from an argument or an environment variable: both are readable through
/proc/<pid>/cmdline and /proc/<pid>/environ by anything that can see the
process. This is a credential-store test harness; the values it types are
stand-ins for real secrets, so it must not itself expose them the way `f creds
set <name> <value>` does.

Env:
  PTY_NOEOL  do not append a newline — the child must terminate the input itself

Prints one JSON object on stdout: {"code": int, "text": str} where text is the
whole terminal transcript (child output plus the tty's own echo).

Why this exists as a real file rather than an inline string in the test:

  1. The test suite needs `isTTY === true` in the child. Every piped test has
     isTTY false no matter what is written into the pipe, so the interactive
     `set <name>` prompt branch is unreachable from a pipe — which is exactly
     how `f creds set gh-token` at a keyboard came to refuse with "set needs a
     value" while the suite stayed green.
  2. Embedding this as a JS template literal cost two debugging cycles: `\\n`
     inside a template becomes a real newline, so the Python source arrived
     with a newline inside a string literal and died with a SyntaxError that
     surfaced only as "driver failed". A .py file has one escaping regime: its
     own.

The input line is written only AFTER the child emits output (its prompt):

  * Writing first means the tty echoes the keystroke back before the child has
    entered raw mode, so a test asserting "the secret must not appear on
    screen" would fail on the driver's own echo rather than the child's.
  * It makes a missing prompt observable. If a future version stops printing a
    prompt, nothing is ever written and the transcript shows that directly,
    instead of a hang or a value stored from an unrelated read.
"""
import json
import os
import pty
import select
import sys

cwd = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
cmd = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if not cmd:
    print("usage: pty-drive.py <cwd> -- <cmd> [args...]", file=sys.stderr)
    sys.exit(2)

_raw = sys.stdin.readline().rstrip("\n") if not sys.stdin.isatty() else ""
# PTY_NOEOL: no trailing newline. A raw-mode reader has no tty line discipline,
# so it must recognise \r as well as \n — a terminal sends \r. Feeding an
# unterminated line is how you find out whether it does: the child either
# resolves on its own or hangs, and the driver's select() timeout says which.
line = _raw if os.environ.get("PTY_NOEOL") else _raw + chr(10)

pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvp(cmd[0], cmd)

buf = b""
code = None
written = False
while True:
    try:
        ready, _, _ = select.select([fd], [], [], 20)
    except OSError:
        break
    if not ready:
        break
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    buf += chunk
    if not written:
        written = True
        try:
            os.write(fd, line.encode())
        except OSError:
            pass
    if code is None:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            code = os.waitstatus_to_exitcode(status)

try:
    os.close(fd)
except OSError:
    pass

if code is None:
    try:
        _, status = os.waitpid(pid, 0)
        code = os.waitstatus_to_exitcode(status)
    except ChildProcessError:
        code = 0

json.dump({"code": code, "text": buf.decode("utf-8", "replace")}, sys.stdout)
sys.stdout.write("\n")
