#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["typer==0.27.2"]
# ///
"""Minimal benchmark harness: pilots a real coding CLI (Copilot CLI or opencode) through the LiteLLM
gateway. The CLI does all the work; the harness sets up the workspace, enforces the timeout and
collects what happened. Tokens, cost and timing come from the gateway's /spend/logs, read through a
fresh per-run virtual key.

  workspace/input/<task>/      prompt.md  [system.md]  [files/]  [task.json]
  workspace/output/<run_id>/   run.json  summary.jsonl  <task>/<model>/{work/, llm_raw.jsonl,
                               trace.jsonl, conversation.jsonl, llm_calls.jsonl, final.md,
                               metrics.json, errors.log}

llm_raw.jsonl is captured by a local pass-through proxy between the CLI and the gateway: the exact
request (system prompt, messages, tool schemas, params) and full response of every LLM call.

task.json (optional): {"timeout_s": 300, "expected": "400", "scorer": "number"}
"""
from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import html
import http.client
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from enum import Enum
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional

import typer

HERE = Path(__file__).resolve().parent
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp"}


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ── gateway admin API (keys + spend logs only — never model calls) ──────────────────────
class Gateway:
    def __init__(self, url: str, master: str):
        u = urllib.parse.urlsplit(url)
        if u.scheme not in ("http", "https") or not u.hostname:
            raise typer.BadParameter(f"gateway URL must be http(s)://host[:port], got {url!r}", param_hint="--gateway")
        # The master key goes in the Authorization header: never send it in clear text off this machine.
        if u.scheme == "http" and u.hostname not in ("localhost", "127.0.0.1", "::1"):
            raise typer.BadParameter(f"refusing plain http:// to {u.hostname}: the master key would be sent "
                                     "unencrypted; use https:// (or a localhost URL)", param_hint="--gateway")
        self.url, self.master = url.rstrip("/"), master

    def call(self, method: str, path: str, body: dict | None = None, retries: int = 4):
        req = urllib.request.Request(
            f"{self.url}{path}", method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {self.master}", "Content-Type": "application/json"})
        for attempt in range(retries):
            try:
                # self.url was checked in __init__: http(s) only, and plain http only to localhost.
                with urllib.request.urlopen(req, timeout=60) as r:  # nosec B310  # nosemgrep: dynamic-urllib-use-detected
                    return json.loads(r.read() or b"null")
            except urllib.error.HTTPError as e:
                if e.code < 500 or attempt == retries - 1:
                    raise RuntimeError(f"{method} {path} -> HTTP {e.code}: {e.read()[:300].decode(errors='replace')}") from e
            except OSError as e:  # connection refused/reset, timeout: gateway restarting — retry
                if attempt == retries - 1:
                    raise RuntimeError(f"{method} {path} -> gateway unreachable: {e}") from e
            time.sleep(3 * 2 ** attempt)

    def models(self) -> set[str]:
        return {m["id"] for m in self.call("GET", "/v1/models")["data"]}

    def new_key(self, alias: str, model: str, budget: float) -> str:
        return self.call("POST", "/key/generate", {"key_alias": alias, "models": [model],
                                                   "max_budget": budget, "duration": "1d"})["key"]

    def delete_key(self, key: str):
        self.call("POST", "/key/delete", {"keys": [key]})

    def spend_logs(self, key: str, expected: int, max_wait: int) -> list[dict]:
        """Logs are flushed in batches: poll until >= `expected` (calls seen in the CLI trace) and
        stable across two reads, or until max_wait."""
        deadline, last = time.time() + max_wait, None
        while True:
            # Polling for spend logs the gateway flushes in batches: waiting is the point.
            time.sleep(5)  # nosemgrep: arbitrary-sleep
            logs = self.call("GET", "/spend/logs?" + urllib.parse.urlencode({"api_key": key})) or []
            if (len(logs) >= expected and len(logs) == last) or time.time() > deadline:
                return sorted(logs, key=lambda l: l.get("startTime") or "")
            last = len(logs)


# ── recording proxy: CLI ⇄ [this] ⇄ gateway — saves every exchange verbatim ────────────
def _maybe_json(b: bytes):
    try:
        return json.loads(b) if b else None
    except ValueError:
        return b.decode(errors="replace")


def _sse_events(text: str) -> list:
    out = []
    for line in text.splitlines():
        if line.startswith("data:") and (d := line[5:].strip()) and d != "[DONE]":
            out.append(_maybe_json(d.encode()))
    return out


class Recorder:
    """Pass-through HTTP proxy on 127.0.0.1:<random>. The CLI talks to it instead of the gateway; it
    forwards each request unchanged, streams the response back unchanged, and appends the exact
    request body (system prompt, messages, tool schemas, params) and the full response (every SSE
    chunk) to a JSONL file. The Authorization header is never written."""

    def __init__(self, upstream: str, out: Path):
        u = urllib.parse.urlsplit(upstream)
        self.conn_cls = http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection
        self.host, self.prefix = u.netloc, u.path.rstrip("/")
        self.out, self.lock, self.records = out, threading.Lock(), []
        rec = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                rec.forward(self)
            do_POST = do_PUT = do_PATCH = do_DELETE = do_GET

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    @staticmethod
    def _read_body(h) -> bytes:
        if "chunked" not in h.headers.get("Transfer-Encoding", "").lower():
            return h.rfile.read(int(h.headers.get("Content-Length") or 0))
        data = b""
        while (n := int(h.rfile.readline().split(b";")[0].strip() or b"0", 16)):
            data += h.rfile.read(n)
            h.rfile.readline()
        h.rfile.readline()
        return data

    def forward(self, h):
        t0 = time.time()
        body = self._read_body(h)
        rec = {"started_at": datetime.fromtimestamp(t0, timezone.utc).isoformat(), "method": h.command,
               "path": h.path, "request": _maybe_json(body)}
        # drop hop-by-hop headers; ask for identity encoding so the recorded body is plain text
        fwd = {k: v for k, v in h.headers.items()
               if k.lower() not in ("host", "content-length", "transfer-encoding", "connection", "accept-encoding")}
        chunks, first, sent = [], None, False
        try:
            c = self.conn_cls(self.host, timeout=3600)
            c.request(h.command, self.prefix + h.path, body=body or None, headers=fwd)
            r = c.getresponse()
            rec["status"] = r.status
            h.send_response(r.status)
            for k, v in r.getheaders():
                if k.lower() not in ("transfer-encoding", "content-length", "connection", "content-encoding"):
                    h.send_header(k, v)
            h.send_header("Connection", "close")  # body is close-delimited: no re-chunking needed
            h.end_headers()
            sent = True
            rec["response_content_type"] = r.getheader("Content-Type")
            while b := r.read1(65536):
                first = first or time.time()
                chunks.append(b)
                h.wfile.write(b)
                h.wfile.flush()
        except Exception as e:  # upstream down, or the CLI hung up mid-stream (e.g. timeout kill)
            rec["error"] = f"{type(e).__name__}: {e}"
            if not sent:
                try:
                    h.send_error(502, rec["error"][:200])
                except OSError:
                    pass
        text = b"".join(chunks).decode(errors="replace")
        if "event-stream" in (rec.get("response_content_type") or ""):
            rec["response_events"] = _sse_events(text)
        else:
            rec["response"] = _maybe_json(text.encode())
        rec["ttfb_s"] = round(first - t0, 3) if first else None   # client-side, incl. gateway overhead
        rec["duration_s"] = round(time.time() - t0, 3)
        with self.lock:
            rec["seq"] = len(self.records)
            self.records.append(rec)
            with open(self.out, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec) + "\n")

    def llm_calls(self) -> int:
        """Completed model calls (POSTs the gateway answered 2xx)."""
        return sum(r["method"] == "POST" and 200 <= (r.get("status") or 0) < 300 for r in self.records)


# ── metrics from gateway logs ────────────────────────────────────────────────────────────
def _ts(s: str | None) -> float | None:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() if s else None


def call_timing(l: dict) -> dict:
    """TTFT = first streamed chunk − start; tok/s = output tokens ÷ (end − first chunk).
    Measured gateway↔provider. first == end means the call wasn't streamed: no TTFT."""
    start, first, end = _ts(l.get("startTime")), _ts(l.get("completionStartTime")), _ts(l.get("endTime"))
    if not (start and first and end and first < end):
        return {"ttft_s": None, "output_tok_s": None}
    toks = l.get("completion_tokens")
    # A response that arrives in one burst (<0.5s between first and last chunk) gives a meaningless rate
    rate = round(toks / (end - first), 1) if toks and end - first >= 0.5 else None
    return {"ttft_s": round(first - start, 3), "output_tok_s": rate}


def stats(xs: list[float]) -> dict | None:
    if not xs:
        return None
    xs = sorted(xs)
    q = lambda p: xs[min(len(xs) - 1, int(p * len(xs)))]
    return {"min": xs[0], "p50": q(0.5), "p95": q(0.95), "max": xs[-1], "mean": round(sum(xs) / len(xs), 3)}


def gateway_metrics(logs: list[dict]) -> dict:
    def cached(l):
        u = (l.get("metadata") or {}).get("usage_object") or {}
        return (u.get("prompt_tokens_details") or {}).get("cached_tokens") or u.get("cache_read_input_tokens") or 0
    inp = sum(l.get("prompt_tokens") or 0 for l in logs)
    out = sum(l.get("completion_tokens") or 0 for l in logs)
    llm_time = sum(l.get("request_duration_ms") or 0 for l in logs) / 1000
    t = [call_timing(l) for l in logs]
    return {"llm_requests": len(logs), "input_tokens": inp, "output_tokens": out,
            "cached_tokens": sum(cached(l) for l in logs), "total_tokens": inp + out,
            "cost_usd": round(sum(l.get("spend") or 0 for l in logs), 6), "llm_time_s": round(llm_time, 2),
            "ttft_s": stats([x["ttft_s"] for x in t if x["ttft_s"] is not None]),
            "output_tok_s": stats([x["output_tok_s"] for x in t if x["output_tok_s"] is not None]),
            "output_tok_s_overall": round(out / llm_time, 1) if llm_time else None}


# ── clients: how to launch each CLI and read its JSONL trace ────────────────────────────
# `system` (optional) is our own prompt. Both CLIs ADD it to their built-in system prompt as custom
# instructions (Copilot cannot replace its own). It is written outside work/ so the agent's
# workspace stays clean; llm_raw.jsonl shows exactly where it landed in the request.
SECRET_ENV = re.compile(r"KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|SESSION|^AWS_|^COPILOT_PROVIDER_", re.I)


def agent_env() -> dict:
    """The agent's environment: ours minus anything secret-looking (gateway master key, AWS creds,
    API tokens, Copilot provider overrides). The AWS SDK/CLI also get no config files, so an `aws`
    call by the agent finds no credentials. The agent only gets the per-run key we add back."""
    env = {k: v for k, v in os.environ.items() if not SECRET_ENV.search(k)}
    env.update(AWS_CONFIG_FILE=os.devnull, AWS_SHARED_CREDENTIALS_FILE=os.devnull,
               AWS_EC2_METADATA_DISABLED="true")
    return env


def copilot_cmd(prompt, model, gateway, key, attachments, run_dir, system, cwd):
    env = agent_env()
    env.update(COPILOT_PROVIDER_BASE_URL=f"{gateway}/v1", COPILOT_PROVIDER_TYPE="openai",
               COPILOT_PROVIDER_API_KEY=key, COPILOT_MODEL=model)
    if system:
        # Copilot only loads *.instructions.md (with an applyTo glob) from custom instruction dirs
        d = run_dir / "instructions" / ".github" / "instructions"
        d.mkdir(parents=True, exist_ok=True)
        (d / "bench.instructions.md").write_text(f"---\napplyTo: '**'\n---\n{system}", encoding="utf-8")
        env["COPILOT_CUSTOM_INSTRUCTIONS_DIRS"] = str(run_dir / "instructions")
    cmd = ["copilot", "-p", prompt, "--allow-all-tools", "--disable-builtin-mcps", "--output-format", "json"]
    for f in attachments:
        cmd += ["--attachment", str(f)]
    return cmd, env


def copilot_parse(events: list[dict]) -> dict:
    by = lambda t: [e.get("data") or {} for e in events if e.get("type") == t]
    tools, msgs = by("tool.execution_start"), [d.get("content") or "" for d in by("assistant.message")]
    return {"final": next((m for m in reversed(msgs) if m.strip()), ""),
            "tool_calls": len(tools),
            "tool_errors": sum(not d.get("success", True) for d in by("tool.execution_complete")),
            "tools_by_name": dict(Counter(t.get("toolName") for t in tools)),
            "turns": len(by("assistant.turn_start")), "llm_calls_in_trace": len(by("model.call_start"))}


def opencode_cmd(prompt, model, gateway, key, attachments, run_dir, system, cwd):
    cfg = {"provider": {"bench": {  # throwaway provider block, merged over the user's config
        "npm": "@ai-sdk/openai-compatible", "name": "bench gateway",
        "options": {"baseURL": f"{gateway}/v1", "apiKey": "{env:BENCH_GATEWAY_KEY}"},
        "models": {model: {"tool_call": True}}}}}
    if system:
        (run_dir / "system.md").write_text(system, encoding="utf-8")
        cfg["instructions"] = [str(run_dir / "system.md")]
    (run_dir / "opencode.json").write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    env = {**agent_env(), "OPENCODE_CONFIG": str(run_dir / "opencode.json"), "BENCH_GATEWAY_KEY": key,
           # empty data dir: opencode otherwise loads saved provider keys from
           # ~/.local/share/opencode/auth.json (e.g. AWS_BEARER_TOKEN_BEDROCK) into the agent's env
           "XDG_DATA_HOME": str(cwd.parent / "opencode-data"),
           "OPENCODE_DISABLE_CLAUDE_CODE": "1"}  # don't pull ~/.claude/CLAUDE.md into the prompt
    cmd = ["opencode", "run", "--model", f"bench/{model}", "--dir", str(cwd), "--auto", "--format", "json"]
    for f in attachments:
        cmd += ["--file", str(f)]
    return cmd + ["--", prompt], env


def opencode_parse(events: list[dict]) -> dict:
    parts = lambda t: [e.get("part") or {} for e in events if e.get("type") == t]
    tools, texts = parts("tool_use"), parts("text")
    last = texts[-1].get("messageID") if texts else None  # final answer = last message with text
    steps = len(parts("step_start"))
    return {"final": "".join(t.get("text", "") for t in texts if t.get("messageID") == last),
            "tool_calls": len(tools),
            "tool_errors": sum((t.get("state") or {}).get("status") == "error" for t in tools),
            "tools_by_name": dict(Counter(t.get("tool") for t in tools)),
            "turns": steps, "llm_calls_in_trace": steps}


class Client(str, Enum):
    copilot = "copilot"
    opencode = "opencode"


CLIENTS = {Client.copilot: (copilot_cmd, copilot_parse), Client.opencode: (opencode_cmd, opencode_parse)}


# ── scorers (task.json "scorer") — add entries here for new benchmark types ─────────────
def extract_answer(text: str) -> str:
    """Last 'ANSWER: x' line, else the last non-empty line."""
    m = re.findall(r"(?im)^\s*\**answer\**\s*[:=]\s*(.+?)\s*$", text)
    if m:
        return m[-1].strip().strip("*`$ ")
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    return lines[-1] if lines else ""


def _num(s: str) -> float | None:
    m = re.findall(r"-?\d+(?:\.\d+)?", s.replace(",", ""))
    return float(m[-1]) if m else None


def _choice(s: str) -> str | None:
    m = re.fullmatch(r"[(\[]?([A-J])[)\].]?", s.strip().upper())  # "C", "(C)", "C." — not prose
    return m.group(1) if m else None


SCORERS = {
    "exact": lambda ans, exp: ans.strip().lower() == str(exp).strip().lower(),
    "choice": lambda ans, exp: _choice(ans) == str(exp).strip().upper(),   # GPQA / MMLU / MMMU
    "number": lambda ans, exp: _num(ans) == float(exp),                      # AIME
}


def load_spec(task: Path) -> dict:
    f = task / "task.json"
    spec = json.loads(f.read_text(encoding="utf-8")) if f.is_file() else {}
    if "scorer" in spec:
        if spec["scorer"] not in SCORERS:
            raise typer.BadParameter(f"{f}: unknown scorer {spec['scorer']!r} (have {sorted(SCORERS)})")
        if "expected" not in spec:
            raise typer.BadParameter(f"{f}: scorer set but no 'expected'")
        if spec["scorer"] == "number":
            float(spec["expected"])  # fail now, not mid-run
    if "check" in spec:
        if not isinstance(spec["check"], str) or not spec["check"].strip():
            raise typer.BadParameter(f"{f}: 'check' must be a command string")
        if "scorer" in spec:
            raise typer.BadParameter(f"{f}: use either 'scorer' or 'check', not both")
    return spec


def run_check(task: Path, spec: dict, work: Path, run_dir: Path) -> float:
    """Grade by running `check` (e.g. hidden tests) against a COPY of the agent's final work/.
    Files in the task's check/ dir are added to that copy only, so the agent never sees them.
    Score 1.0 if the command exits 0. Output goes to check.log."""
    with tempfile.TemporaryDirectory(prefix="bench-check-") as tmp:
        d = Path(tmp) / "work"
        shutil.copytree(work, d, symlinks=True)
        if (task / "check").is_dir():
            shutil.copytree(task / "check", d, dirs_exist_ok=True)
        try:
            p = subprocess.run(shlex.split(spec["check"]), cwd=d, env=agent_env(), capture_output=True,
                               text=True, timeout=spec.get("check_timeout_s", 120), stdin=subprocess.DEVNULL)
            rc, log = p.returncode, p.stdout + p.stderr
        except subprocess.TimeoutExpired:
            rc, log = "timeout", "[harness] check timed out\n"
    (run_dir / "check.log").write_text(f"$ {spec['check']}\nexit: {rc}\n\n{log}", encoding="utf-8")
    return 1.0 if rc == 0 else 0.0


# ── one run ──────────────────────────────────────────────────────────────────────────────
def run_agent(cmd, env, cwd: Path, run_dir: Path, timeout: int) -> tuple[str, int]:
    """Run the CLI in its own process group so timeout / Ctrl-C kill it and everything it spawned."""
    with open(run_dir / "trace.jsonl", "w", encoding="utf-8") as out, open(run_dir / "errors.log", "w", encoding="utf-8") as err:
        p = subprocess.Popen(cmd, cwd=cwd, env={**env, "PWD": str(cwd)}, stdout=out, stderr=err,
                             stdin=subprocess.DEVNULL, start_new_session=True)
        try:
            p.wait(timeout=timeout)
            return ("ok" if p.returncode == 0 else "error"), p.returncode
        except subprocess.TimeoutExpired:
            err.write(f"\n[harness] killed after {timeout}s timeout\n")
            return "timeout", _kill(p)
        except BaseException:  # Ctrl-C: don't leave an orphaned agent running
            _kill(p)
            raise


def _kill(p: subprocess.Popen) -> int:
    for sig, wait in ((signal.SIGTERM, 10), (signal.SIGKILL, None)):
        try:
            os.killpg(p.pid, sig)
            return p.wait(wait)
        except ProcessLookupError:
            return p.wait()
        except subprocess.TimeoutExpired:
            continue
    return p.wait()


def run_one(gw: Gateway, client: Client, task: Path, spec: dict, model: str, run_dir: Path,
            default_timeout: int, max_budget: float, spend_wait: int, default_system: str | None) -> dict:
    # The agent runs in a scratch dir OUTSIDE this repo: both CLIs walk up the tree collecting
    # AGENTS.md / repo context, and inside the toolkit they'd pull its instructions into the prompt.
    # Its final state is copied back to run_dir/work afterwards.
    scratch = Path(tempfile.mkdtemp(prefix="bench-"))
    work = scratch / "work"
    if (task / "files").is_dir():
        shutil.copytree(task / "files", work)
    else:
        work.mkdir()
    run_dir.mkdir(parents=True)
    timeout = spec.get("timeout_s", default_timeout)
    m = {"task": task.name, "model": model, "client": client.value, "timeout_s": timeout, "started_at": now()}
    notes: list[str] = []
    key = rec = None
    try:
        # fresh virtual key per run: scoped to this one model, budget-capped, attributable
        key = gw.new_key(f"bench-{run_dir.parent.parent.name}-{task.name}-{model}", model, max_budget)
        # CLI talks to the recorder, which forwards to the gateway and saves every exchange verbatim
        rec = Recorder(gw.url, run_dir / "llm_raw.jsonl")
        build, parse = CLIENTS[client]
        attachments = [f for f in sorted(work.rglob("*")) if f.suffix.lower() in IMAGE_EXT]
        system = (task / "system.md").read_text(encoding="utf-8") if (task / "system.md").is_file() else default_system
        m["system_prompt"] = ("task system.md" if (task / "system.md").is_file() else "--system") if system else None
        cmd, env = build((task / "prompt.md").read_text(encoding="utf-8"), model, rec.url, key, attachments, run_dir, system, work)

        t0 = time.perf_counter()
        m["status"], m["exit_code"] = run_agent(cmd, env, work, run_dir, timeout)
        m["wall_time_s"], m["ended_at"] = round(time.perf_counter() - t0, 2), now()
        # Let the recorder finish writing the last exchange (it runs in another thread).
        time.sleep(0.5)  # nosemgrep: arbitrary-sleep
        m["llm_calls_recorded"] = rec.llm_calls()

        events = []
        for line in (run_dir / "trace.jsonl").read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                m["trace_unparsed_lines"] = m.get("trace_unparsed_lines", 0) + 1
        # conversation.jsonl = the trace minus streaming deltas / UI noise (Copilot marks them ephemeral)
        with open(run_dir / "conversation.jsonl", "w", encoding="utf-8") as f:
            f.writelines(json.dumps(e) + "\n" for e in events if not e.get("ephemeral"))
        parsed = parse(events)
        final = parsed.pop("final")
        (run_dir / "final.md").write_text(final, encoding="utf-8")
        m.update(parsed)

        expected = max(m["llm_calls_recorded"], m["llm_calls_in_trace"])
        logs = gw.spend_logs(key, expected, spend_wait)
        with open(run_dir / "llm_calls.jsonl", "w", encoding="utf-8") as f:
            for l in logs:
                row = {k: l.get(k) for k in ("request_id", "startTime", "completionStartTime", "endTime",
                                             "request_duration_ms", "model_group", "prompt_tokens",
                                             "completion_tokens", "total_tokens", "spend")}
                f.write(json.dumps({**row, **call_timing(l)}) + "\n")
        m.update(gateway_metrics(logs))
        if not logs and not len(rec.records):
            m["status"] = "error" if m["status"] == "ok" else m["status"]
            notes.append("no LLM calls reached the gateway")
        elif len(logs) < expected or len(logs) < len([r for r in rec.records if r["method"] == "POST"]):
            # e.g. a call cut off by the timeout: in llm_raw.jsonl, but the gateway never logged it
            m["metrics_incomplete"] = True
            notes.append(f"gateway logged {len(logs)} calls; recorder saw {len(rec.records)} exchanges")

        if "scorer" in spec:
            m["expected"], m["answer"] = spec["expected"], extract_answer(final)
            m["score"] = float(SCORERS[spec["scorer"]](m["answer"], spec["expected"]))
        elif "check" in spec and m["status"] in ("ok", "timeout"):
            m["score"] = run_check(task, spec, work, run_dir)
    except KeyboardInterrupt:
        m["status"] = "interrupted"
        raise
    except Exception as e:  # harness-side failure: record it and move on to the next run
        m["status"] = "harness_error"
        notes.append(f"{type(e).__name__}: {e}")
    finally:
        # each cleanup step is independent: one failing must never skip the others (esp. key delete)
        def step(name, fn):
            try:
                fn()
            except Exception as e:
                notes.append(f"cleanup '{name}' failed: {type(e).__name__}: {e}")
        if key:
            step("delete key", lambda: gw.delete_key(key))
        if rec:
            step("stop recorder", rec.close)
        step("save work/", lambda: shutil.copytree(work, run_dir / "work", symlinks=True, dirs_exist_ok=True))
        shutil.rmtree(scratch, ignore_errors=True)
        m["agent_cwd"] = str(work)  # paths in the traces refer to this (now removed) scratch dir
        with open(run_dir / "errors.log", "a", encoding="utf-8") as err:
            err.writelines(f"[harness] {n}\n" for n in notes)
        (run_dir / "metrics.json").write_text(json.dumps(m, indent=2), encoding="utf-8")
    return m


def one_line(m: dict) -> str:
    g = lambda k, sub=None: (m.get(k) or {}).get(sub) if sub else m.get(k)
    parts = [m["status"], f"{g('wall_time_s')}s", f"in={g('input_tokens')}", f"out={g('output_tokens')}",
             f"cached={g('cached_tokens')}", f"tools={g('tool_calls')}", f"${g('cost_usd')}"]
    if g("ttft_s"):
        parts.append(f"ttft_p50={g('ttft_s', 'p50')}s")
    if g("output_tok_s"):
        parts.append(f"tok/s_p50={g('output_tok_s', 'p50')}")
    if "score" in m:
        parts.append(f"score={m['score']}")
    return "  ".join(parts)


# ── HTML report: one plain table per run, rebuilt after every task ───────────────────────
REPORT_COLS = [("task", "task"), ("model", "model"), ("status", "status"), ("score", "score"),
               ("wall_time_s", "wall s"), ("input_tokens", "in tok"), ("output_tokens", "out tok"),
               ("cached_tokens", "cached"), ("tool_calls", "tools"), ("cost_usd", "cost $"),
               ("ttft_s", "TTFT p50 s"), ("output_tok_s", "tok/s p50")]


def write_report(out: Path):
    rows = [json.loads(l) for l in (out / "summary.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    run = json.loads((out / "run.json").read_text(encoding="utf-8"))
    e = lambda v: html.escape("" if v is None else str(v))
    lines = []
    for m in rows:
        cells = [(m.get(k) or {}).get("p50") if k in ("ttft_s", "output_tok_s") else m.get(k) for k, _ in REPORT_COLS]
        model = re.sub(r"[^\w.-]", "_", m["model"])
        d = f"{m['task']}/{model}"
        links = " ".join(f'<a href="{e(d)}/{f}">{f}</a>' for f in ("final.md", "metrics.json", "errors.log", "check.log")
                         if (out / d / f).exists())
        lines.append("<tr>" + "".join(f"<td>{e(c)}</td>" for c in cells) + f"<td>{links}</td></tr>")
    head = "".join(f"<th>{h}</th>" for _, h in REPORT_COLS) + "<th>files</th>"
    total = sum(m.get("cost_usd") or 0 for m in rows)
    (out / "report.html").write_text(
        f"<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><title>Benchmark {e(run['run_id'])}</title></head>\n"
        f"<body>\n<h1>Benchmark {e(run['run_id'])}</h1>\n"
        f"<p>client: {e(run['client'])}, timeout {e(run['timeout_s'])}s, total cost ${total:.4f}</p>\n"
        f"<table border=\"1\" cellpadding=\"4\">\n<tr>{head}</tr>\n" + "\n".join(lines) + "\n</table>\n</body></html>\n", encoding="utf-8")


# ── CLI ──────────────────────────────────────────────────────────────────────────────────
def main(
    models: str = typer.Option(..., help="Comma-separated model_names from the gateway config."),
    client: Client = typer.Option(Client.copilot, help="Coding CLI to pilot."),
    tasks: Optional[str] = typer.Option(None, help="Comma-separated task names (default: all)."),
    system: Optional[Path] = typer.Option(None, exists=True, dir_okay=False,
                                          help="Our own system prompt for every task, added to the CLI's "
                                               "built-in one (a task's system.md overrides it)."),
    timeout: int = typer.Option(600, help="Seconds per run; task.json timeout_s overrides."),
    max_budget: float = typer.Option(5.0, help="USD cap on each per-run gateway key."),
    spend_wait: int = typer.Option(90, help="Max seconds to wait for the gateway's spend logs."),
    input_dir: Path = typer.Option(HERE / "workspace" / "input", "--input", exists=True, file_okay=False),
    output_dir: Path = typer.Option(HERE / "workspace" / "output", "--output"),
    gateway: str = typer.Option("http://localhost:4000", envvar="BENCH_GATEWAY"),
    master_key: str = typer.Option(..., envvar="LITELLM_MASTER_KEY", show_default=False,
                                   help="Gateway master key (mints the per-run keys)."),
):
    """Pilot a coding CLI on every task × model and record work, traces and metrics."""
    if not shutil.which(client.value):
        raise typer.BadParameter(f"`{client.value}` not on PATH", param_hint="--client")
    gw = Gateway(gateway, master_key)
    model_list = [x.strip() for x in models.split(",") if x.strip()]
    if missing := sorted(set(model_list) - gw.models()):
        raise typer.BadParameter(f"not in gateway catalogue: {missing}", param_hint="--models")
    wanted = {x.strip() for x in tasks.split(",")} if tasks else None
    task_dirs = [d for d in sorted(input_dir.iterdir())
                 if (d / "prompt.md").is_file() and (wanted is None or d.name in wanted)]
    if wanted and (unknown := wanted - {d.name for d in task_dirs}):
        raise typer.BadParameter(f"no such task(s): {sorted(unknown)}", param_hint="--tasks")
    if not task_dirs:
        raise typer.BadParameter(f"no tasks in {input_dir} (a task is a folder with prompt.md)")
    specs = {d: load_spec(d) for d in task_dirs}  # validate every task.json before spending anything

    run_id = datetime.now().strftime("%Y%m%d-%H%M%S")
    out = output_dir / run_id
    out.mkdir(parents=True)
    (out / "run.json").write_text(json.dumps({
        "run_id": run_id, "started_at": now(), "gateway": gw.url, "client": client.value,
        "models": model_list, "tasks": [d.name for d in task_dirs], "timeout_s": timeout,
        "system_prompt_file": str(system) if system else None}, indent=2), encoding="utf-8")

    for task in task_dirs:
        for model in model_list:
            typer.echo(f"[{task.name} × {model}] {client.value} ... ", nl=False)
            run_dir = out / task.name / re.sub(r"[^\w.-]", "_", model)
            m = run_one(gw, client, task, specs[task], model, run_dir, timeout, max_budget, spend_wait,
                        system.read_text(encoding="utf-8") if system else None)
            with open(out / "summary.jsonl", "a", encoding="utf-8") as f:
                f.write(json.dumps(m) + "\n")
            write_report(out)
            typer.echo(one_line(m))
    typer.echo(f"\nresults: {out}\nreport:  {out / 'report.html'}")


if __name__ == "__main__":
    typer.run(main)
