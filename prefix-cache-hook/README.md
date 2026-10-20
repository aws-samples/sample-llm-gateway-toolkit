# Prefix-cache hook

> Faster first responses for GitHub Copilot CLI on a self-hosted model.

`prefix_normalise.py` is an optional LiteLLM callback. It reorders Copilot CLI's prompt so a self-hosted engine (vLLM on SageMaker) can reuse its prompt cache across sessions, which cuts the time to first token on every new chat.

[When to use it](#when-to-use-it) · [How it works](#how-it-works) · [Enable](#enable) · [Limits](#limits)

## When to use it

| Your setup | Use the hook? |
| --- | --- |
| Copilot CLI on a self-hosted model, and new chats are slow to start | **Yes** |
| Bedrock models only | No. Managed endpoints handle their own caching. |
| Other agents (Claude Code, Codex, OpenCode) | No. The hook only changes Copilot CLI requests. |

## How it works

Copilot CLI puts per-session details (working directory, session folder) in the **middle** of its system prompt. vLLM reuses its cache only up to the first token that differs, so every new session misses the cache for everything after that point, including all the tool schemas, and the model has to process the whole prompt again. How long that takes depends on the instance (for example g5 vs g6e).

The hook moves those two blocks (`<environment_context>`, `<session_context>`), unchanged, to the **end** of the last message. The large system prompt and tool schemas then stay identical across sessions and users, so they stay cached. The model still sees the same information, only later in the prompt.

It runs as an `async_pre_call_hook`, so one hook covers every route. If anything fails, it passes the request through unchanged.

## Enable

1. Make `prefix_normalise.py` available to LiteLLM, next to its config file:
   - **Local gateway:** mount it in [`gateway-local/docker-compose.yml`](../gateway-local/docker-compose.yml), under `volumes`: `- ../prefix-cache-hook/prefix_normalise.py:/app/prefix_normalise.py:ro`
   - **Gateway on AWS:** build a custom image from the LiteLLM image with the file copied in, and use it in [`gateway-cdk`](../gateway-cdk/).
2. Register it in the LiteLLM config:
   ```yaml
   litellm_settings:
     callbacks: ["prefix_normalise.handler"]
   ```
3. Set `NORMALIZE_SESSION_PREFIX=1` in the gateway's environment.

At startup the gateway logs `[prefix-normalise] loaded — ACTIVE` (or `INERT` when the variable isn't set). Without the variable, requests pass through untouched, so you can turn it off without removing the code.

## Limits

- **Copilot CLI only.** The hook recognises Copilot's prompt by four markers and leaves other prompts alone. VS Code Copilot isn't handled.
- **Tied to the current prompt layout.** If a Copilot update changes those blocks, the hook stops matching and logs a warning. Compare two captured requests from different sessions and update `_VOLATILE_BLOCK_RES`.
- **Instruction files aren't moved.** Keep `AGENTS.md` or `copilot-instructions.md` the same across projects, or they split the cached prompt.
