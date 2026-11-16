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
 * (codex review). It only happens with stdout stalled, which ends the session.
 */
export async function deliverBounded(deliver: () => Promise<void>, opts: BoundedOpts = {}): Promise<void> {
  const { timeoutMs = 10_000, isDead = () => false, onDying } = opts
  if (isDead()) throw new Error('transport closed')
  let timer: ReturnType<typeof setTimeout> | undefined
  let unsubscribe = () => {}
  try {
    await Promise.race([
      deliver(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`hand-off timed out after ${timeoutMs} ms`)), timeoutMs)
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
