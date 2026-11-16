/**
 * Hand one inbound message to Claude. grammy confirms the update to Telegram
 * whatever the handler does, so a hand-off that fails (the MCP transport
 * closing during a restart answers "Not connected") loses the message: it was
 * fire-and-forget with a stderr line nobody reads (2026-11-16 audit, finding
 * 4). Now it is awaited, and a failure runs `onLost` — log it and tell the
 * sender to send again — which never throws back into the update loop.
 *
 * The wait is bounded: the SDK's stdio send resolves only on `drain`, which
 * never comes once stdout has failed or stalled, and grammy handles updates
 * one at a time, so an unbounded await would stop all inbound (codex review).
 * A timed-out send may still land later, so onLost's message says "may not".
 */
export async function handOff(
  deliver: () => Promise<void>,
  onLost: (error: unknown) => Promise<void> | void,
  timeoutMs = 10_000,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      deliver(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`hand-off timed out after ${timeoutMs} ms`)), timeoutMs)
      }),
    ])
    return true
  } catch (error) {
    try { await onLost(error) } catch {}
    return false
  } finally {
    clearTimeout(timer)
  }
}
