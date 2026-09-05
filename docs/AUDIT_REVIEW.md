# Plugin audit fixes and Fable review

The five audit findings are fixed: paired-DM permission authorization, aligned
Markdown fallback, polling retry accounting, bridge reparenting, and accurate
partial-send reporting. Regression tests exercise the production helper modules
and the real bridge subprocess with isolated state.

Fable (`claude-fable-5-1`) reviewed the patch in three read-only runs through the
user-provided `claude_delegate.py` runner. Review findings prompted these follow-ups:

- Preserve formatting with custom limits and full-size source chunks. Telegram's
  [sendMessage limit](https://core.telegram.org/bots/api#sendmessage) applies after
  entity parsing; escaped transport length does not consume that limit.
- Detect actual Markdown regions crossing boundaries, using the translator's
  own patterns. Only affected chunks become plain; identifiers, list bullets,
  and unrelated formatted chunks retain their formatting.
- Test a mixed formatted/plain retry explicitly, plus code spanning chunks,
  nested emphasis, and a 4096-character source containing escaped punctuation.
- Keep a bounded history of completed permission IDs. Recent duplicates are
  absorbed, ordinary phrases remain chat, and failed permission deliveries
  tell the user to retry without consuming the request.
- Report invalid input clearly, distinguish fatal token errors from retryable
  failures, and exit with failure status after invalid credentials or repeated
  polling conflicts. Shutdown behavior is documented in the Telegram README.
- Retain the bridge reparenting regression: restoring the old PID guard in a
  temporary copy makes it fail. Also verify clean shutdown when stdin closes.

Leading chunk separators are deliberately preserved with source whitespace;
stripping them risks changing code indentation. Tests cover paragraph-boundary
translation. This addresses the speculative whitespace concern without trimming
source content.

The final review's follow-ups were tested locally after that review; this is not
an assertion that Fable issued a clean verdict on the final snapshot. Validation
uses mocked Telegram APIs and a local mock bridge, not a live Telegram bot or
Claude Code session. CI now runs tests and pinned TypeScript checks on macOS and
Linux; remote CI will run when the branch is published.

The shared-core edits remain fork-local. See [UPSTREAM.md](UPSTREAM.md) before
syncing from harness so these fixes are retained.
