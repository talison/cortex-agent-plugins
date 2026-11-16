export type BoundedOpts = {
  /** Give up after this long. The SDK's stdio send resolves only on 'drain'. */
  timeoutMs?: number
  /** True once the transport cannot carry a message: shutting down, stdin or stdout ended. */
  isDead?: () => boolean
  /**
   * Subscribe to the start of shutdown, so a stalled send gives up at once;
   * returns the unsubscribe, called when the send settles (a subscription
   * per send left on a shared promise grew until shutdown: codex review).
   */
  onDying?: (cb: () => void) => () => void
  /**
   * Called when `timeoutMs` passes. The write is already queued on stdout and
   * would still arrive if the pipe recovered, after the sender was told to
   * resend (a duplicate) or a permission verdict was retried the other way;
   * the server treats a timeout as a dead transport and shuts down (Fable review).
   */
  onTimeout?: () => void
}

/**
 * Deliver one MCP message to Claude, or reject. It rejects when the transport
 * is already dead, when shutdown starts while the send waits, after
 * `timeoutMs`, and when the send is accepted but the transport died
 * meanwhile, since whether Claude read it is then unknown.
 *
 * Why: the SDK's StdioServerTransport.send never rejects; it resolves on
 * 'drain', which never comes once stdout has failed or stalled, and grammy
 * handles updates one at a time, so an unbounded await stops all inbound
 * (codex review). During a restart the process exits within seconds of
 * stdin's end, so the dead checks, not the timeout, are what let the sender
 * hear about it (Fable review).
 *
 * An abandoned send leaves the SDK's once('drain') listener on stdout. It is
 * not removed: from out here it cannot be told apart from a concurrent send's
 * listener (a tool result), and removing that one strands its response
 * (codex review). It only happens with stdout stalled, which ends the session
 * (onTimeout).
 */
export async function deliverBounded(deliver: () => Promise<void>, opts: BoundedOpts = {}): Promise<void> {
  const { timeoutMs = 10_000, isDead = () => false, onDying, onTimeout } = opts
  if (isDead()) throw new Error('transport closed')
  let timer: ReturnType<typeof setTimeout> | undefined
  let unsubscribe = () => {}
  try {
    await Promise.race([
      deliver(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`hand-off timed out after ${timeoutMs} ms`))
          onTimeout?.()
        }, timeoutMs)
        if (onDying) unsubscribe = onDying(() => reject(new Error('transport closed')))
      }),
    ])
  } finally {
    clearTimeout(timer)
    unsubscribe()
  }
  if (isDead()) throw new Error('transport closed while sending')
}

/**
 * Hand one inbound message to Claude. grammy confirms the update to Telegram
 * whatever the handler does, so a lost hand-off loses the message: it was
 * fire-and-forget with a stderr line nobody reads (2026-11-16 audit, finding
 * 4). Now a failure (deliverBounded) runs `onLost` — log it and tell the
 * sender it may not have arrived — which never throws into the update loop,
 * and is itself bounded: grammy's request timeout is 500 s, so a stalled
 * notice would hold the loop too (codex review). Its signal aborts at the bound.
 */
export async function handOff(
  deliver: () => Promise<void>,
  onLost: (error: unknown, signal: AbortSignal) => Promise<void> | void,
  opts: BoundedOpts & { noticeTimeoutMs?: number } = {},
): Promise<boolean> {
  try {
    await deliverBounded(deliver, opts)
    return true
  } catch (error) {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.resolve().then(() => onLost(error, abort.signal)),
        new Promise<void>(resolve => {
          timer = setTimeout(() => { abort.abort(); resolve() }, opts.noticeTimeoutMs ?? 5_000)
        }),
      ])
    } catch {} finally {
      clearTimeout(timer)
    }
    return false
  }
}

/**
 * The onTimeout the server uses: destroy stdout synchronously, then shut
 * down. Shutdown keeps the process up for up to 2 s to send notices, and a
 * stalled pipe that drained in that window would still deliver the queued
 * message, after "may not have reached" or a "Delivery failed" verdict that
 * Claude Code would then act on (codex review). Destroying discards what is
 * still buffered; bytes the kernel already took cannot be recalled.
 */
export function endOnStall(stdout: { destroy(): unknown }, shutdown: () => void): () => void {
  return () => {
    try { stdout.destroy() } catch {}
    shutdown()
  }
}
