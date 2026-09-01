# cortex-agent-plugins

Personal Claude Code plugin marketplace for [Cortex](https://github.com/talison/cortex).

| Plugin | What it is |
|--------|------------|
| `telegram` | Fork of `anthropics/claude-plugins-official/external_plugins/telegram`, backed by harness's shared [`telegram-core`](https://github.com/talison/harness/tree/main/src/telegram-core) for consistent MarkdownV2 translation, paragraph-aware chunking, and typing indicators. See `plugins/telegram/core/.sync-source` for the upstream pin. |
| `comms-bridge` | Cortex-side channel plugin for the agent-to-agent comms bridge. Long-polls the local bridge service (Cortex's `comms-bridge/` HTTP service on 127.0.0.1:9475) and exposes a `send` tool for messages to Max. Not user-facing — sits alongside the Telegram plugin in Cortex's session. |

See `docs/UPSTREAM.md` for how upstream changes are tracked and merged.

## Install

These are loaded from a local marketplace, not the public Anthropic registry. From a Claude Code session with `talison/cortex-agent-plugins` registered:

```
/plugin install telegram@cortex-agent-plugins
/plugin install comms-bridge@cortex-agent-plugins
```

Both plugins are channel plugins — they need to be loaded at session start with the dev-channels flag, not just installed. Pass the flag **once per plugin**; a single comma-joined value does not parse and inbound messages are silently dropped:

```sh
claude \
  --dangerously-load-development-channels plugin:telegram@cortex-agent-plugins \
  --dangerously-load-development-channels plugin:comms-bridge@cortex-agent-plugins
```

Do not also pass `--channels` with the same value — the two flags collide and inbound drops.

Cortex's `scripts/start-cortex.sh` already wires this up.
