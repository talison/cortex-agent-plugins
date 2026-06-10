# Backlog

Deferred items from the 2026-06-09 plugin review (full context: cortex repo
history + Cortex/Reference/comms-bridge.md). Each was judged real but not
worth its rollout cost at review time.

## telegram-core (fix in harness first, then `scripts/sync-telegram-core.sh`)

- **Wrap `claudeToTelegramV2` in try/catch** (core/send.ts:99) — a translator
  throw currently fails the whole send with a visible tool error; falling back
  to plain text (same philosophy as the parse-entities fallback) would deliver
  the message instead. Low probability (pure string code, 6+ weeks in prod
  across both consumers), so deferred — requires harness edit + core sync +
  fork version bump + Max container rebuild.
- **Chunk-boundary mismatch** (core/send.ts:100-121) — `preparedChunks` /
  `originalChunks` can differ in count when MarkdownV2 escaping inflates text
  across the 4096 boundary; the `?? preparedChunks[i]` fallback then passes
  already-escaped text as the "original" plain-text retry. Cosmetic worst case
  (escape noise in one chunk), needs a fix in chunk alignment, same rollout
  chain as above.

## telegram plugin (fork-local)

- **MCP notification failure handling** (server.ts inbound path) — inbound
  delivery is a fire-and-forget `mcp.notification()` with `.catch` →
  fork-debug.log. A retry-once would tighten it, but the failure mode has
  never been observed and duplicate-delivery semantics of a blind retry are
  unclear. Revisit if `notification failed` ever shows up in the debug log.
- **`pendingPermissions` Map has no TTL** — unbounded only in theory
  (single operator, rare permission prompts). Revisit if permission volume
  ever changes.

## process

- **Upstream sync is manual** — `docs/UPSTREAM.md` describes a weekly check
  that isn't scheduled anywhere. Candidate: fold a `git log upstream-cc/main
  --since='1 week ago' -- external_plugins/telegram/` count into the Sunday
  briefing's drift section (cortex repo).
