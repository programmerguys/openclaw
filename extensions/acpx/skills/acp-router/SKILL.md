---
name: acp-router
description: Route plain-language requests for Pi, Claude Code, Codex, OpenCode, Gemini CLI, or ACP harness work into OpenClaw ACP runtime sessions. For coding work, treat `coding` as the owner lane: other agents should route coding needs to `coding`, and `coding` should use ACP runtime sessions as the default control plane.
user-invocable: false
---

# ACP Harness Router

When user intent is "run this in Pi/Claude Code/Codex/OpenCode/Gemini/Kimi (ACP harness)", do not use subagent runtime or PTY scraping as the default path. Route through ACP-aware flows.

## Core stance

### Coding work belongs to the coding lane

- If the real task is coding / repo work / implementation / code inspection, the preferred owner lane is `coding`.
- Other agents should not each learn or maintain Codex/ACP execution details.
- Other agents should route coding needs to `coding`.
- `coding` then uses ACP runtime sessions as the default control plane for Codex.

### ACP runtime is the default control plane

For harness-backed coding work, prefer:

- `sessions_spawn(runtime="acp", ...)`
- `sessions_send(sessionKey=..., message=...)`

Direct `acpx` driving is fallback / special-case tooling, not the default coding workflow.

## Intent detection

Trigger this skill when the user asks OpenClaw to:

- run something in Pi / Claude Code / Codex / OpenCode / Gemini
- continue existing harness work
- relay instructions to an external coding harness
- keep an external harness conversation in a thread-like conversation

Mandatory preflight for coding-agent thread requests:

- Before creating any thread for Pi/Claude/Codex/OpenCode/Gemini work, read this skill first in the same turn.
- After reading, follow `OpenClaw ACP runtime path` below; do not use `message(action="thread-create")` for ACP harness thread spawn.

## AgentId mapping

Use these defaults when user names a harness directly:

- "pi" -> `agentId: "pi"`
- "claude" or "claude code" -> `agentId: "claude"`
- "codex" -> `agentId: "codex"`
- "opencode" -> `agentId: "opencode"`
- "gemini" or "gemini cli" -> `agentId: "gemini"`
- "kimi" or "kimi cli" -> `agentId: "kimi"`

If policy rejects the chosen id, report the policy error clearly and ask for the allowed ACP agent id.

## OpenClaw ACP runtime path

Required behavior:

1. For ACP harness thread spawn requests, read this skill first in the same turn before calling tools.
2. Use `sessions_spawn` with:
   - `runtime: "acp"`
   - `thread: true`
   - `mode: "session"` (unless user explicitly wants one-shot)
3. For ACP harness thread creation, do not use `message` with `action=thread-create`; `sessions_spawn` is the only thread-create path.
4. Put requested work in `task` so the ACP session gets it immediately.
5. Set `agentId` explicitly unless ACP default agent is known.
6. For coding work in Discord, treat the returned `threadSession` as the immediate read model for the created thread-bound session.
7. Do not ask user to run slash commands or CLI when this path works directly.

Example:

```json
{
  "task": "Say hi.",
  "runtime": "acp",
  "agentId": "codex",
  "thread": true,
  "mode": "session"
}
```

## `threadSession` for coding work

When `sessions_spawn(..., thread=true, mode="session")` succeeds for coding work, use the returned `threadSession` as the primary read model.

Key fields:

- `threadSession.threadId`
- `threadSession.sessionKey`
- `threadSession.ownerSessionKey`
- `threadSession.cwd`
- `threadSession.status`

Meaning:

- automatic continuation -> `sessions_send(sessionKey=threadSession.sessionKey, ...)`
- human/manual takeover -> speak directly in `threadSession.threadId`

Do not propose a workspace-side registry as the primary source of truth.

## Mode selection

Choose one of these paths:

1. OpenClaw ACP runtime path (default)
2. Direct `acpx` path (fallback / special case)

Use direct `acpx` only when one of these is true:

- user explicitly asks for direct `acpx` driving
- ACP runtime/plugin path is unavailable or unhealthy
- the task is truly just relay-to-harness and OpenClaw ACP lifecycle features are not needed

Do not use:

- `subagents` runtime for harness control
- `/acp` command delegation as a requirement for the user
- PTY scraping of pi/claude/codex/opencode/gemini/kimi CLIs when ACP runtime or direct `acpx` is available

## Thread spawn recovery policy

When the user asks to start a coding harness in a thread, treat that as an ACP runtime request and try to satisfy it end-to-end.

Required behavior when ACP backend is unavailable:

1. Do not immediately ask the user to pick an alternate path.
2. First attempt automatic local repair:
   - ensure plugin-local pinned acpx is installed in `extensions/acpx`
   - verify `${ACPX_CMD} --version`
3. After reinstall/repair, restart the gateway and explicitly offer to run that restart for the user.
4. Retry ACP thread spawn once after repair.
5. Only if repair+retry fails, report the concrete error and then offer fallback options.

Fallback order:

- Option 1: retry ACP spawn after showing exact failing step
- Option 2: direct acpx telephone-game flow

Do not default to subagent runtime for these requests.

## ACPX install and version policy (fallback path)

For this repo, direct `acpx` calls must follow the same pinned policy as the `@openclaw/acpx` extension.

1. Prefer plugin-local binary, not global PATH:
   - `./extensions/acpx/node_modules/.bin/acpx`
2. Resolve pinned version from extension dependency:
   - `node -e "console.log(require('./extensions/acpx/package.json').dependencies.acpx)"`
3. If binary is missing or version mismatched, install plugin-local pinned version:
   - `cd extensions/acpx && npm install --omit=dev --no-save acpx@<pinnedVersion>`
4. Verify before use:
   - `./extensions/acpx/node_modules/.bin/acpx --version`
5. If install/repair changed ACPX artifacts, restart the gateway and offer to run the restart.
6. Do not run `npm install -g acpx` unless the user explicitly asks for global install.

Set and reuse:

```bash
ACPX_CMD="./extensions/acpx/node_modules/.bin/acpx"
```

## Direct acpx path (fallback)

Use this path to drive harness sessions without ACP runtime only when fallback conditions above are met.

Rules:

1. Use `exec` commands that call `${ACPX_CMD}`.
2. Reuse a stable session name per conversation so follow-up prompts stay in the same harness context.
3. Prefer `--format quiet` for clean assistant text to relay back to user.
4. Use `exec` one-shot only when the user wants one-shot behavior.
5. Keep working directory explicit (`--cwd`) when task scope depends on repo context.

## Failure handling

- `acpx: command not found`:
  - for thread-spawn ACP requests, install plugin-local pinned acpx in `extensions/acpx`
  - restart gateway after install and offer to run the restart automatically
  - then retry once
  - do not install global `acpx` unless explicitly requested
- adapter command missing:
  - first restore built-in defaults by removing broken `~/.acpx/config.json` agent overrides
  - then retry once before offering fallback
- `NO_SESSION`: create a session, then retry prompt
- queue busy: wait for completion by default unless async behavior is explicitly desired

## Output relay

When relaying to user, return the final assistant text output from ACP runtime or `acpx` result. Avoid relaying raw local tool noise unless user asked for verbose logs.
