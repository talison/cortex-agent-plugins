# comms-bridge (Cortex side)

Claude Code channel plugin that connects Cortex to the agent-to-agent comms bridge — the HTTP service Cortex runs locally for exchanging structured messages with Max (the harness container agent).

This is **not** a Tom-facing channel. Tom-facing replies still go via the Telegram plugin. See Cortex's `CLAUDE.md` reply-routing block for the per-message routing rules.

## How it works

The plugin is a sidecar Bun process loaded by Claude Code via `--dangerously-load-development-channels plugin:comms-bridge@cortex-agent-plugins`.

- **Inbound** — long-polls `GET http://127.0.0.1:9475/inbox?agent=cortex&since=<cursor>` and surfaces each message as a `<channel source="plugin:comms-bridge:agent" from="..." uuid="..." kind="..." [reply_to_uuid="..."]>BODY</channel>` block in Cortex's session. Cursor persisted at `~/.cortex/data/comms-bridge.cortex.cursor`.
- **Outbound** — exposes one MCP tool, `mcp__plugin_comms-bridge_comms-bridge__send`, that posts to `POST /send`. Default `to_agent` is `max` (currently the only addressable peer). Set `kind` to `request` (expects response), `response` (closes a thread, requires `reply_to_uuid`), or `notify` (default, fire-and-forget). 64KB payload cap enforced by the bridge.

## Backing service

The bridge service lives in [`talison/cortex/comms-bridge/`](https://github.com/talison/cortex/tree/main/comms-bridge) (FastAPI + SQLite WAL on port 9475). It must be running for this plugin to function — managed by launchd (`ai.cortex.comms-bridge`).

### Auth

The service gates `/send`, `/inbox` and `/ack` behind `Authorization: Bearer <token>`. The plugin resolves the token once at startup: `COMMS_BRIDGE_TOKEN` if the environment sets it, otherwise the Keychain item the service's other clients read —

```sh
security find-generic-password -a comms-bridge -s agent-token -w
```

No token found is non-fatal (one line in the debug log, requests go out unauthenticated) — correct while the service runs in `report-only` mode, a 401 once it flips to `required`. The token value is never logged.

Plugin debug log: `~/.claude/channels/comms-bridge/logs/fork-debug.log`.

## Tests

```sh
bun test
```

Covers the four modules under `lib/`: bridge-client (POST /send + GET /inbox), cursor (read/write atomic), payload (channel-tag construction), backoff (exponential).

## Source layout

```
plugins/comms-bridge/
├── .claude-plugin/plugin.json    # plugin metadata (name, version, keywords)
├── .mcp.json                     # MCP server config: bun run start
├── server.ts                     # main entry: long-poll loop + MCP send tool
├── lib/                          # bridge-client, cursor, payload, backoff
├── tests/                        # vitest specs for each lib module
└── package.json                  # bun deps
```

Mirrors the telegram plugin's layout — see that plugin's source for the same architectural pattern (channel + MCP server in one process).
