export type PollFailure = { error: unknown; attempt: number; delay: number; exhausted: boolean; fatal: boolean }

/**
 * Retry startup/poll failures; only a successful poll clears the failure count.
 *
 * `settleMs` holds everything back until the process has lived that long:
 * Claude Code sometimes spawns a phantom server that loses stdin within
 * milliseconds. The bot.pid claim used to sit behind a `shuttingDown` check
 * that ran in the same synchronous stretch as the handlers that set it, so it
 * could never be true, and a phantom could SIGTERM the live poller (2026-11-16
 * audit, finding 3). `onSettled` (the claim) runs once, after the window and
 * only if the process is not shutting down; polling starts after it.
 */
export async function runPolling(opts: {
  start: (onPollSuccess: () => void) => Promise<void>
  isShuttingDown: () => boolean
  isConflict: (error: unknown) => boolean
  isFatal?: (error: unknown) => boolean
  onFailure: (failure: PollFailure) => void
  onExhausted: (failure: PollFailure) => void
  settleMs?: number
  onSettled?: () => void
  sleep?: (ms: number) => Promise<void>
}): Promise<void> {
  const sleep = opts.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  if (opts.settleMs) await sleep(opts.settleMs)
  if (opts.isShuttingDown()) return
  opts.onSettled?.()
  let attempt = 0
  let conflicts = 0
  while (!opts.isShuttingDown()) {
    try {
      await opts.start(() => { attempt = 0; conflicts = 0 })
      return
    } catch (error) {
      if (opts.isShuttingDown()) return
      if (error instanceof Error && error.message === 'Aborted delay') return
      attempt++
      conflicts = opts.isConflict(error) ? conflicts + 1 : 0
      const fatal = opts.isFatal?.(error) ?? false
      const exhausted = fatal || conflicts >= 8
      const delay = Math.min(1000 * attempt, 15_000)
      const failure = { error, attempt, delay, exhausted, fatal }
      opts.onFailure(failure)
      if (exhausted) {
        opts.onExhausted(failure)
        return
      }
      await sleep(delay)
    }
  }
}

/**
 * Best-effort last word before the poller exits: one message to each chat,
 * given at most `timeoutMs` in all, never throwing. A poller that dies on a
 * persistent 409 can still send, and without this Tom learned of it only when
 * a DM went unanswered (2026-11-16 audit, finding 1).
 */
export async function lastWord(
  send: (chat: string, text: string) => Promise<unknown>,
  chats: string[],
  text: string,
  timeoutMs: number,
): Promise<void> {
  const sends = Promise.allSettled(chats.map(async chat => send(chat, text)))
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs) })
  await Promise.race([sends, timeout])
  clearTimeout(timer)
}
