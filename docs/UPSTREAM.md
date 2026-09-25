# Monitoring upstream

The telegram plugin in this marketplace is a fork of `anthropics/claude-plugins-official/external_plugins/telegram`. Upstream keeps improving, and we want to absorb their improvements without giving up our shared-core integration.

## Weekly check

```bash
git fetch upstream-cc
git log upstream-cc/main --since='1 week ago' -- external_plugins/telegram/
```

For each commit touching `external_plugins/telegram/`:

1. Open `git show <sha> -- external_plugins/telegram/` and read the diff.
2. If it touches `server.ts` behavior we rely on: cherry-pick manually into `plugins/telegram/server.ts`, run `bun run typecheck` and `bun test` in each affected plugin, commit.
3. If it's a refactor we chose not to adopt (e.g., upstream reinlines something we now get from `core/`): note the SHA and rationale in `docs/UPSTREAM_SKIPPED.md`.

## Why a remote instead of a submodule

A submodule would force our fork to track upstream's full tree. A remote is a lightweight read-only reference that lets us `git log`/`git show` against upstream without constraining our directory layout.

## Sync log

- 2026-06-09 — cherry-picked `5a71459` (#894): gate /start, /help, /status
  behind dmPolicy via `dmCommandGate()`; commands previously replied to any
  DM user, leaking bot presence under allowlist/disabled policies. Only
  upstream telegram change since the bb77301 seed. Shipped as 0.1.0-fork.5.


## Fork-local core delivery changes

`plugins/telegram/core/.sync-source` records the vendored base, not a claim that
all files remain identical to that revision. The audit fixes modify `chunk.ts`,
`send.ts`, `markdown-translate.ts`, and `index.ts` locally: preserve source whitespace, translate source chunks independently (use plain text only in chunks intersecting a spanning Markdown region), retain 429 retry handling on plain fallback, and
expose `PartialSendError` with confirmed message IDs.

Harness's `audit-batch2` branch (commits `94b2138` and `f5710bd`, 2026-09-24,
audit M19 and its codex review) ports these changes, except `PartialSendError`,
into `src/telegram-core/`. Both copies also gained `startChunk`/`onChunkSent`
resumption with a `CHUNK_PLAN_VERSION`, plain text on both sides of a
mid-line cut, and a `sendStream` that no longer forwards resume options.
Neither re-splits a chunk whose escaped payload passes 4096: Telegram counts
the limit after entity parsing. After those commits, `core/send.ts` differs
from harness's copy only by `PartialSendError`, its wrapping of send and
`onChunkSent` failures, and the `onChunkSent` comment; `core/stream.ts`
differs only by its SOURCE header. The other fork-local deltas are the `PartialSendError`
export in `index.ts` and a `let` in `markdown-translate.ts`. `typing.ts` lags
harness (no `stopAllTyping`).

Do not sync from harness until that branch reaches its `main` on GitHub: the
sync script clones from there, and the old `send.ts` it would bring back has
the M19 mismatch. Port `PartialSendError` to harness before the next normal core
sync, or explicitly reapply it after syncing. `scripts/sync-telegram-core.sh` replaces the core
directory; it does not merge local changes. Run the Telegram tests and typecheck
before accepting a sync so delivery regressions cannot ship silently. The
regression tests stay outside `core/` and are not overwritten by the sync.
