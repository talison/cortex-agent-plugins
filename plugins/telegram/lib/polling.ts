export type PollFailure = { error: unknown; attempt: number; delay: number; exhausted: boolean; fatal: boolean }

/** Retry startup/poll failures; only a successful poll clears the failure count. */
export async function runPolling(opts: {
  start: (onPollSuccess: () => void) => Promise<void>
  isShuttingDown: () => boolean
  isConflict: (error: unknown) => boolean
  isFatal?: (error: unknown) => boolean
  onFailure: (failure: PollFailure) => void
  onExhausted: (failure: PollFailure) => void
  sleep?: (ms: number) => Promise<void>
}): Promise<void> {
  const sleep = opts.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
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
