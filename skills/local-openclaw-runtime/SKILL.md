---
name: local-openclaw-runtime
description: "Canonical runtime topology and operator guardrails for HaiPro's local OpenClaw source-watch setup on macOS. Use when working on gateway startup, launchd/watch mode, Discord routing, command authorization, or deciding whether restart/install/doctor actions are safe on this machine."
metadata: { "openclaw": { "emoji": "🦞" } }
---

# Local OpenClaw Runtime

Use this skill for runtime/debugging work on HaiPro's current macOS machine.

## Canonical Runtime

- `main` source: `/Users/haipro/Dev/Run/openclaw-main`
- `dev` source: `/Users/haipro/Dev/Run/openclaw-dev`
- `main` config: `/Users/haipro/.openclaw/openclaw.json`
- `dev` config: `/Users/haipro/.openclaw-dev/openclaw.json`
- `main` launch label: `ai.openclaw.gateway`
- `dev` launch label: `ai.openclaw.dev`
- `main` port: `18789`
- `dev` port: `19789`
- Both gateways run in source watch mode:
  - `node /Users/haipro/Dev/Run/openclaw-main/scripts/watch-node.mjs gateway --force --port 18789`
  - `node /Users/haipro/Dev/Run/openclaw-dev/scripts/watch-node.mjs gateway --force --port 19789`

## Guardrails

- Treat the watch launch agents as the only source of truth.
- Do not use `openclaw gateway install`, `openclaw doctor --repair`, or app-managed launchagent flows as routine restart methods here. They can overwrite the watch setup.
- If `/Applications/OpenClaw.app` or `ai.openclaw.mac` reappears, treat it as a stale GUI/app chain, not the canonical gateway runtime.
- Prefer checking current state with:
  - `launchctl list | rg 'ai\\.openclaw|application\\.ai\\.openclaw'`
  - `lsof -nP -iTCP:18789 -sTCP:LISTEN`
  - `lsof -nP -iTCP:19789 -sTCP:LISTEN`
  - `openclaw agents bindings --json`

## Discord (Main)

- `channels.discord.groupPolicy = "open"`
- Guild `1479573118140813474` has `requireMention = false`
- `commands.useAccessGroups = false`
- `agents.defaults.verboseDefault = "on"`
- `#browser` (`1480942600612614184`) and `#general` (`1480942602768355349`) are currently bound to `main`

## Debug Order

When Discord behavior looks wrong:

1. Check configured bindings with `openclaw agents bindings --json`.
2. Check the active session stores:
   - `/Users/haipro/.openclaw/agents/main/sessions/sessions.json`
   - `/Users/haipro/.openclaw/agents/<agent>/sessions/sessions.json`
3. Check `gateway.log` for reload/restart/binding lines.
4. Remember that old channel sessions can make behavior look split even after bindings were changed.

## Expected Behavior

- Guild text messages in the configured main guild do not require `@Samantha`.
- Discord native/slash commands are not gated by access groups on this machine.
- Config changes may trigger either hot reload or full watch-supervisor restart; let watch restart the gateway instead of reinstalling services.
