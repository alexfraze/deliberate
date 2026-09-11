"""Sandboxed Python for the game master.

Vendored and adapted from ARC-AGI-3 `inference/agent/python_tool_sandbox.py`, which is
itself Tufa Labs "Duck" ARC3-Inference (MIT). See `services/gm/VENDORED.md` for provenance.

What was kept: the RPC design (a child process talks JSON lines to the host, so the only way
out of the sandbox is a call the host executes), globals refreshed after every RPC, a hard
wall-clock timeout that kills the process group, restricted builtins and an import allowlist,
and `resource` limits.

What was replaced: the ARC frame/segmentation views, and the `action(actions)` RPC. The
sandbox's one RPC here is `gm_tool(name, **arguments)`, which the host forwards to the engine.
The sandbox therefore cannot mutate anything the engine did not validate -- it is the third
wall, behind quoted player text and engine validation.
"""

from __future__ import annotations

import json
import os
import queue
import signal
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
from collections.abc import Callable
from typing import Any

_SANDBOX_BOOTSTRAP = textwrap.dedent(
    r"""
    import builtins
    import contextlib
    import io
    import json
    import os
    import sys
    import traceback

    try:
        import resource
    except ImportError:  # pragma: no cover - not present on every platform
        resource = None

    HOST_STDOUT = sys.stdout

    SAFE_MODULES = {
        "bisect",
        "collections",
        "copy",
        "fractions",
        "functools",
        "heapq",
        "itertools",
        "json",
        "math",
        "operator",
        "re",
        "statistics",
        "string",
    }
    SAFE_BUILTINS = {
        "abs", "all", "any", "ascii", "bin", "bool", "bytearray", "bytes", "callable",
        "chr", "complex", "dict", "dir", "divmod", "enumerate", "Exception", "filter",
        "float", "format", "frozenset", "getattr", "hasattr", "hash", "hex", "int",
        "isinstance", "issubclass", "iter", "KeyError", "len", "list", "map", "max", "min",
        "next", "oct", "ord", "pow", "print", "range", "repr", "reversed", "round", "set",
        "slice", "sorted", "str", "sum", "tuple", "TypeError", "type", "ValueError",
        "RuntimeError", "zip",
    }


    def _send(payload):
        HOST_STDOUT.write(json.dumps(payload, ensure_ascii=False) + "\n")
        HOST_STDOUT.flush()


    def _recv():
        line = sys.stdin.readline()
        if not line:
            raise EOFError("sandbox input closed")
        return json.loads(line)


    def _json_safe(value):
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, dict):
            return {str(key): _json_safe(item) for key, item in value.items()}
        if isinstance(value, (list, tuple, set)):
            return [_json_safe(item) for item in value]
        return str(value)


    def _sanitize_exception(exc):
        # Only frames from the model's own code are shown. A host traceback would leak the
        # service's file layout into the model's context.
        extracted = traceback.extract_tb(exc.__traceback__)
        user_frames = [frame for frame in extracted if frame.filename == "<gm_python>"]
        lines = ["Traceback (most recent call last):"]
        for frame in user_frames or extracted[-1:]:
            lines.append('  File "<gm_python>", line %s, in %s' % (frame.lineno, frame.name))
        lines.append("%s: %s" % (exc.__class__.__name__, exc))
        return "\n".join(lines)


    def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
        root = str(name or "").split(".", 1)[0]
        if root not in SAFE_MODULES:
            raise ImportError("Module '%s' is not allowed in the sandbox." % name)
        return builtins.__import__(name, globals, locals, fromlist, level)


    def _set_limits(timeout_seconds):
        if resource is None:
            return
        cpu_limit = max(1, int(timeout_seconds)) + 1
        for limit, value in (
            (getattr(resource, "RLIMIT_CPU", None), cpu_limit),
            (getattr(resource, "RLIMIT_FSIZE", None), 1_000_000),
            (getattr(resource, "RLIMIT_NOFILE", None), 32),
        ):
            if limit is None:
                continue
            try:
                resource.setrlimit(limit, (value, value))
            except (OSError, ValueError):
                pass


    def main():
        initial = _recv()
        timeout_seconds = max(1, int(initial.get("timeout_seconds", 5)))
        sandbox_cwd = str(initial.get("sandbox_cwd", "")).strip()
        if sandbox_cwd:
            os.chdir(sandbox_cwd)
        _set_limits(timeout_seconds)

        verdicts = []
        stdout = io.StringIO()
        runtime_globals = {
            "__builtins__": {name: getattr(builtins, name) for name in SAFE_BUILTINS},
            "result": None,
        }
        runtime_globals["__builtins__"]["__import__"] = _safe_import

        def _refresh(payload):
            # Refreshed after every RPC: code that acts and then reads `state` sees what the
            # engine says now, not a snapshot from before the call.
            runtime_globals["state"] = payload.get("state") or {}
            runtime_globals["turn"] = payload.get("turn")
            runtime_globals["phase"] = payload.get("phase")
            runtime_globals["verdicts"] = list(verdicts)
            runtime_globals["last_verdict"] = verdicts[-1] if verdicts else None

        def gm_tool(name, **arguments):
            tool_name = str(name or "").strip()
            if not tool_name:
                raise ValueError("gm_tool(name, **arguments) requires a tool name.")
            _send({"type": "tool", "tool": tool_name, "input": _json_safe(arguments)})
            reply = _recv()
            if reply.get("type") != "tool_result":
                raise RuntimeError("Invalid tool response from the sandbox host.")
            verdict = reply.get("verdict") or {}
            verdicts.append(verdict)
            _refresh(reply)
            return verdict

        runtime_globals["gm_tool"] = gm_tool
        _refresh(initial)

        try:
            compiled = compile(str(initial.get("code", "")), "<gm_python>", "exec")
            with contextlib.redirect_stdout(stdout):
                exec(compiled, runtime_globals, runtime_globals)
            _send({
                "type": "final",
                "stdout": stdout.getvalue(),
                "result": _json_safe(runtime_globals.get("result")),
                "verdicts": _json_safe(verdicts),
            })
        except Exception as exc:
            _send({
                "type": "error",
                "error": _sanitize_exception(exc),
                "stdout": stdout.getvalue(),
                "verdicts": _json_safe(verdicts),
            })


    if __name__ == "__main__":
        main()
    """
)

ToolHandler = Callable[[str, dict[str, Any]], dict[str, Any]]


def _sandbox_env() -> dict[str, str]:
    # A deliberately bare environment: no API keys, no repo paths, nothing inherited.
    return {
        "PYTHONUNBUFFERED": "1",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONDONTWRITEBYTECODE": "1",
        "HOME": "/tmp",
        "TMPDIR": "/tmp",
        "PATH": os.environ.get("PATH", ""),
    }


def _send_json_line(handle: Any, payload: dict[str, Any]) -> None:
    handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
    handle.flush()


def _kill_process_group(process: subprocess.Popen[str]) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except OSError:
        try:
            process.kill()
        except OSError:
            pass


def _wait_for_exit(process: subprocess.Popen[str], *, timeout: float = 1.0) -> None:
    try:
        process.wait(timeout=timeout)
        return
    except subprocess.TimeoutExpired:
        _kill_process_group(process)
    except OSError:
        return
    try:
        process.wait(timeout=timeout)
    except (subprocess.TimeoutExpired, OSError):
        pass


def run_sandboxed_python(
    *,
    code: str,
    timeout_seconds: int,
    context: dict[str, Any],
    tool_handler: ToolHandler,
) -> dict[str, Any]:
    """Run `code` in a throwaway child process. Returns `{stdout, result, error, verdicts}`.

    The timeout is wall clock and enforced by the host, not by the child: a child that stops
    answering is killed along with anything it spawned.
    """
    with tempfile.TemporaryDirectory(prefix="gm_python_") as sandbox_dir:
        host_verdicts: list[dict[str, Any]] = []
        try:
            process = subprocess.Popen(  # noqa: S603 - fixed argv, no shell
                [sys.executable, "-I", "-S", "-c", _SANDBOX_BOOTSTRAP],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                cwd=sandbox_dir,
                env=_sandbox_env(),
                start_new_session=True,
            )
        except OSError:
            return {"error": "Sandbox process could not start.", "stdout": "", "verdicts": []}

        assert process.stdin is not None
        assert process.stdout is not None
        assert process.stderr is not None

        stdout_queue: queue.Queue[str | None] = queue.Queue()

        def _reader() -> None:
            for raw_line in process.stdout:  # type: ignore[union-attr]
                stdout_queue.put(raw_line)
            stdout_queue.put(None)

        threading.Thread(target=_reader, daemon=True).start()

        _send_json_line(
            process.stdin,
            {
                "code": code,
                "timeout_seconds": timeout_seconds,
                "sandbox_cwd": sandbox_dir,
                **context,
            },
        )

        deadline = time.monotonic() + max(1, int(timeout_seconds))
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                _kill_process_group(process)
                _wait_for_exit(process)
                return {
                    "error": f"The python tool timed out after {timeout_seconds}s.",
                    "stdout": "",
                    "verdicts": list(host_verdicts),
                }

            try:
                line = stdout_queue.get(timeout=remaining)
            except queue.Empty:
                continue
            if line is None:
                _wait_for_exit(process)
                return {
                    "error": "Sandbox process exited unexpectedly.",
                    "stdout": "",
                    "verdicts": list(host_verdicts),
                }

            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                _kill_process_group(process)
                _wait_for_exit(process)
                return {
                    "error": "Sandbox process returned an invalid response.",
                    "stdout": "",
                    "verdicts": list(host_verdicts),
                }

            kind = str(message.get("type", "")).strip()
            if kind == "tool":
                reply = tool_handler(str(message.get("tool", "")), message.get("input") or {})
                verdict = reply.get("verdict") or {}
                if isinstance(verdict, dict):
                    host_verdicts.append(dict(verdict))
                _send_json_line(
                    process.stdin,
                    {
                        "type": "tool_result",
                        "verdict": verdict,
                        "state": reply.get("state") or {},
                        "turn": reply.get("turn"),
                        "phase": reply.get("phase"),
                    },
                )
                continue

            if kind in {"final", "error"}:
                _wait_for_exit(process)
                return {
                    "stdout": str(message.get("stdout", "") or ""),
                    "result": message.get("result"),
                    "error": str(message.get("error", "") or ""),
                    "verdicts": list(message.get("verdicts") or host_verdicts),
                }

            _wait_for_exit(process)
            return {
                "error": "Sandbox process returned an unknown message type.",
                "stdout": "",
                "verdicts": list(host_verdicts),
            }
