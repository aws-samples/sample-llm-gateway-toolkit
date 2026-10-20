# Benchmark harness

`bench.py` benchmarks models by piloting a real coding CLI (Copilot CLI or opencode) through the
gateway, so the results reflect what a developer actually gets.

## Run

Needs the gateway running (`../gateway-local`), [uv](https://docs.astral.sh/uv/), and `copilot` or `opencode` on PATH.

From `benchmark/`, load the running local gateway's master key:

```bash
export LITELLM_MASTER_KEY="$(docker compose -f ../gateway-local/docker-compose.yml exec -T litellm printenv LITELLM_MASTER_KEY)"
```

The harness uses this key to create a temporary virtual key for each run and read its spend logs.

```bash
uv run bench.py --models claude-sonnet-5-5,minimax-m2.5            # all tasks, copilot
uv run bench.py --client opencode --models claude-sonnet-5-5 --tasks smoke --timeout 300
uv run bench.py --help                                            # all options
```

It talks to `http://localhost:4000` by default; point it elsewhere with `--gateway URL` or `BENCH_GATEWAY`
(a plain `http://` URL is accepted only for localhost). Results go to `workspace/output/` unless you pass
`--output DIR`.

## Tasks

One folder per task in `workspace/input/<task>/`:

| File | |
|---|---|
| `prompt.md` | the prompt (required) |
| `files/` | copied into the agent's working dir |
| `system.md` | your own system prompt, added to the CLI's (or `--system FILE` for all tasks) |
| `task.json` | `{"timeout_s": 300, "expected": "400", "scorer": "number"}`. Scorers: `number`, `choice` (A–J), `exact`, graded on the last `ANSWER: …` line |
| `check/` + `"check"` | hidden tests: after the run, `check/` is added to a copy of the agent's work and `task.json`'s `"check"` command runs there (exit 0 = score 1). See `fix-pricing-bugs` |

For official benchmarks (AIME, GPQA, MMMU…), convert each item into one task folder.

## Results

`workspace/output/<run_id>/` has `report.html` (a plain table of every task × model; open it in a
browser), `summary.jsonl` (the same data, one line per task × model), plus for each run
`<task>/<model>/` (and `run.json` for the run as a whole):

| File | |
|---|---|
| `work/` | what the agent produced |
| `metrics.json` | status, wall time, input/output/cached tokens, cost, TTFT, tokens/s, tool calls, score |
| `llm_raw.jsonl` | every LLM request and response, verbatim |
| `llm_calls.jsonl` | one line per LLM call from the gateway's spend logs: tokens, cost, timing |
| `opencode.json` | the config the run used (opencode runs only) |
| `conversation.jsonl` | messages, tool calls, tool results |
| `trace.jsonl` | the CLI's raw event stream |
| `final.md` | the agent's final answer |
| `errors.log` | stderr, timeouts, harness errors |
| `check.log` | output of the hidden-test check, if the task has one |

## Notes

- Each run gets its own budget-capped gateway key. Tokens, cost and TTFT come from the gateway.
  `llm_raw.jsonl` is captured by a local pass-through proxy. LiteLLM prompt logging truncates to
  2,048 chars, and its OTel spans drop reasoning and some request params.
- The agent runs with all tools auto-approved, on your machine, in a scratch dir outside this repo.
  Its environment has secret-looking variables removed (master key, `AWS_*`, tokens) and no AWS
  config, so it only holds the per-run key. It can still read your files, e.g. `~/.aws`: don't run it
  where that matters.
- `judge-prompt.md` is a rubric template for LLM-as-judge scoring of open-ended tasks. `bench.py` does not
  run a judge: give the template and a run's `final.md` or `work/` to a strong model yourself. Such
  scores are directional, not rankings.
