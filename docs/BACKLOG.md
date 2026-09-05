# Backlog

Deferred items from the 2026-06-09 plugin review (full context: cortex repo
history + Cortex/Reference/comms-bridge.md). Each was judged real but not
worth its rollout cost at review time.

## Resolved in the audit fixes

- Source-first chunking keeps translated text and plain fallback aligned.
  The former mismatch could lose and duplicate content, not just add escape
  noise. Translation errors now also fall back to the original source chunk.
- Partial-send errors preserve confirmed message IDs, including file sends.
- Permission replies require a paired DM, an enabled policy, and a pending
  request. Concurrent text/button replies cannot emit duplicate approvals.
- Telegram resets retry counts only after a successful poll. The bridge
  watchdog uses stdin state so normal wrapper reparenting does not stop it.
- CI runs tests and pinned TypeScript checks on macOS and Linux.

The shared-core delivery fixes are currently fork-local; see `UPSTREAM.md`
before syncing from harness.

## telegram plugin (fork-local)

- **MCP notification failure handling** (server.ts inbound path) — inbound
  delivery is a fire-and-forget `mcp.notification()` with `.catch` →
  stderr. A retry-once would tighten it, but the failure mode has
  never been observed and duplicate-delivery semantics of a blind retry are
  unclear. Revisit if `failed to deliver inbound to Claude` appears on stderr.
- **`pendingPermissions` Map has no TTL** — unbounded only in theory
  (single operator, rare permission prompts). Revisit if permission volume
  ever changes.

## watch-for (blocked on Claude Code support)

- **Session-control commands over Telegram** (`/compact` etc., asked
  2026-06-09) — channel messages arrive as model-visible text; slash commands
  are TUI input-layer constructs. Nothing in the channel/MCP protocol lets a
  plugin invoke session commands today. If Claude Code ever exposes session
  control to channels, add a `/compact` bot command alongside /status.

## process

- **Upstream sync is manual** — `docs/UPSTREAM.md` describes a weekly check
  that isn't scheduled anywhere. Candidate: fold a `git log upstream-cc/main
  --since='1 week ago' -- external_plugins/telegram/` count into the Sunday
  briefing's drift section (cortex repo).
