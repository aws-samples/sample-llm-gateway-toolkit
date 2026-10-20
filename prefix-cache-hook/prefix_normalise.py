"""LiteLLM callback that makes GitHub Copilot CLI's prompt prefix-cacheable across sessions.

THE PROBLEM
  Copilot CLI embeds a per-session state folder in the MIDDLE of its system prompt. A self-hosted
  engine (e.g. vLLM) matches the KV-cache prefix from token 0 and stops at the first differing
  token, so a fresh session invalidates everything after that point — including all the tool
  schemas — and pays a full cold prefill every time, so time to first token is long (how long depends
  on the instance, e.g. g5 vs g6e).

THE FIX
  Move the two volatile blocks (<environment_context> and <session_context>) VERBATIM to the end of
  the last message, which the chat template renders AFTER the tool schemas. Nothing is falsified or
  duplicated — the model still sees its real cwd and session folder, just at the tail. The large,
  shared system-prompt-plus-tool-schema prefix then stays cacheable across every session and user.
  After the fix, time to first token drops sharply.

WHY A PRE-CALL HOOK (not a provider handler)
  `async_pre_call_hook` runs for EVERY provider, and returning a dict from it replaces the request
  downstream — so one hook covers every backend route. A fix inside one provider handler would
  silently do nothing for the others.

ENABLE
  Set NORMALIZE_SESSION_PREFIX=1, and in your LiteLLM config.yaml:
      litellm_settings:
        callbacks: ["prefix_normalise.handler"]   # append to any existing entries
  Unset (the default) => the hook returns None and requests pass through byte-identical, so
  rollback is a config change, not a code revert.

SCOPE
  Copilot CLI only, gated on four client-specific markers — no other client's prompt is touched.
  Keyed to the current Copilot CLI prompt layout. If a future CLI version renames or
  reformats the blocks, the transform no-ops and TTFT silently regresses — so a mismatch logs a loud
  WARNING. Re-diff two captured requests from different sessions and update _VOLATILE_BLOCK_RES.

Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: MIT-0
"""
import os
import re

from litellm.integrations.custom_logger import CustomLogger

# Each block is self-contained between its own tags, non-greedy so it stops at the first closing
# tag, and absorbs surrounding blank lines so removing it leaves no ragged gap.
#   <environment_context>  cwd + git root + OS   -> varies per user / project
#   <session_context>      session-state/<uuid>  -> varies per session
# Order = the original prompt order Copilot emits them in.
_VOLATILE_BLOCK_RES = (
    re.compile(r"\n*<environment_context>.*?</environment_context>\n*", re.DOTALL),
    re.compile(r"\n*<session_context>.*?</session_context>\n*", re.DOTALL),
)


def _is_copilot_cli(content: str) -> bool:
    """Require ALL FOUR Copilot-CLI-specific markers before touching a prompt.

    A single loose marker would risk rewriting another client's prompt that merely mentions a
    similar path. All four are things only this client emits, so every other request is left alone.
    """
    return all(s in content for s in (
        "<session_context>",
        "Session folder:",
        "session-state/",
        "GitHub Copilot CLI",
    ))


def normalize_messages(messages):
    """Move Copilot CLI's volatile blocks past the tool schemas. Returns (messages, changed).

    Non-mutating (LiteLLM may reuse message objects); edits only the system message; re-attaches
    the blocks verbatim at the end so two sessions never see each other's context.
    """
    out, changed, blocks = [], False, []
    for m in messages or []:
        c = m.get("content")
        if m.get("role") == "system" and isinstance(c, str) and _is_copilot_cli(c):
            new_c, found_any = c, False
            for rx in _VOLATILE_BLOCK_RES:
                block = rx.search(new_c)
                if block:
                    new_c = rx.sub("\n\n", new_c, count=1)
                    blocks.append(block.group(0).strip())
                    found_any = True
            if found_any:
                m = {**m, "content": new_c}
                changed = True
            else:
                # Markers present but no block matched — a client update probably renamed them.
                # Say so loudly: a silent no-op means the latency regression comes back with
                # nothing failing and no alert firing.
                print("WARNING [prefix-normalise] recognised Copilot CLI but no volatile block "
                      "matched; prefix caching will MISS and TTFT will regress on a fresh session. "
                      "The prompt layout has probably changed — re-diff two captured requests and "
                      "update _VOLATILE_BLOCK_RES.", flush=True)
        out.append(m)

    # Re-attach the blocks at the very END, past the tool schemas, in prompt order.
    if changed and blocks:
        for i in range(len(out) - 1, -1, -1):
            c = out[i].get("content")
            if isinstance(c, str):
                out[i] = {**out[i], "content": c + "\n\n" + "\n\n".join(blocks)}
                break
        else:
            # No string-content message to append to (e.g. all-multimodal parts). Returning the
            # original is the only safe move — keeping the cut without the re-attach would hide
            # the cwd and session folder from the model entirely.
            return messages, False
    return out, changed


class PrefixNormalise(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        """Rewrite the prompt for every provider, before the request is dispatched.

        Returning a dict replaces `data` downstream; returning None leaves the request untouched.
        """
        if os.environ.get("NORMALIZE_SESSION_PREFIX", "0") != "1":
            return None
        try:
            messages, changed = normalize_messages(data.get("messages"))
            if not changed:
                return None
            return {**data, "messages": messages}
        except Exception as e:
            # A prompt rewrite must NEVER break inference. Fall through unchanged.
            print(f"[prefix-normalise] ERROR {e!r} — passing request through unchanged", flush=True)
            return None


handler = PrefixNormalise()


# Printed once at import so the module's state is visible — a missing callbacks entry otherwise
# looks exactly like a working fix until someone measures TTFT.
_active = os.environ.get("NORMALIZE_SESSION_PREFIX", "0") == "1"
print(f"[prefix-normalise] loaded — {'ACTIVE' if _active else 'INERT (set NORMALIZE_SESSION_PREFIX=1 to enable)'}",
      flush=True)
