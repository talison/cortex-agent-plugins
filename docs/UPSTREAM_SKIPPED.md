# Upstream decisions we skipped or deferred

## Typing indicators

The earlier fire-once decision is superseded. The plugin now calls
`startTyping` on inbound messages, stops on the reply tool, and applies a
three-minute safety cap. `withTyping` remains appropriate for callers that
own the entire request/response lifetime.

## `edit_message` tool still uses legacy `format: 'markdownv2'`

**Phase 2 decision (2026-04-17):** Leave as-is.

The `reply` tool's `format` enum was narrowed to `['text', 'claude']`; `edit_message` still advertises `['text', 'markdownv2']`. A future refactor should move `edit_message` onto `editText` from `core/` for consistency. For now, the legacy path (manual MarkdownV2 with `parse_mode`) is preserved for edits only.
