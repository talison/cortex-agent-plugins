import type { EventEmitter } from 'events'

export type BoundedOpts = {
  /** Give up after this long. The SDK's stdio send resolves only on 'drain'. */
  timeoutMs?: number
  /** True once the transport cannot carry a message: shutting down, stdin or stdout ended. */
  isDead?: () => boolean
  /** Settles when the process starts shutting down, so a stalled send gives up at once. */
  dying?: Promise<unknown>
  /** The transport's stdout: 'drain' listeners an abandoned send left on it are removed. */
  stream?: EventEmitter
}

/**
 * Deliver one MCP message to Claude, or reject. It rejects when the transport
 * is already dead, when it dies (or `dying` settles) while the send waits,
 * after `timeoutMs`, and when the send is accepted but the transport died
 * meanwhile, since whether Claude read it is then unknown.
 *
 * Why: the SDK's StdioServerTransport.send never rejects; it resolves on
 * 'drain', which never comes once stdout has failed or stalled, and grammy
 * handles updates one at a time, so an unbounded await stops all inbound
 * (codex review). During a restart the process exits within seconds of
 * stdin's end, so the dead checks, not the timeout, are what let the sender
 * hear about it (Fable review).
 */
export async function deliverBounded(deliver: () => Promise<void>, opts: BoundedOpts = {}): Promise<void> {
  const { timeoutMs = 10_000, isDead = () => false, dying, stream } = opts
  if (isDead()) throw new Error('transport closed')
  const drainBefore = new Set(stream?.listeners('drain') ?? [])
  let timer: ReturnType<typeof setTimeout> | undefined
  // Handled here too: it rejects at shutdown even for sends long finished.
  const died = dying?.then(() => { throw new Error('transport closed') })
  died?.catch(() => {})
  try {
    await Promise.race([
      deliver(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`hand-off timed out after ${timeoutMs} ms`)), timeoutMs)
      }),
      ...(died ? [died] : []),
    ])
  } catch (error) {
    // The abandoned send's once('drain') would otherwise stay on stdout.
    for (const l of stream?.listeners('drain') ?? []) {
      if (!drainBefore.has(l)) stream!.removeListener('drain', l as (...a: unknown[]) => void)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
  if (isDead()) throw new Error('transport closed while sending')
}

/**
 * Hand one inbound message to Claude. grammy confirms the update to Telegram
 * whatever the handler does, so a lost hand-off loses the message: it was
 * fire-and-forget with a stderr line nobody reads (2026-11-16 audit, finding
 * 4). Now a failure (deliverBounded) runs `onLost` — log it and tell the
 * sender it may not have arrived — which never throws into the update loop.
 */
export async function handOff(
  deliver: () => Promise<void>,
  onLost: (error: unknown) => Promise<void> | void,
  opts: BoundedOpts = {},
): Promise<boolean> {
  try {
    await deliverBounded(deliver, opts)
    return true
  } catch (error) {
    try { await onLost(error) } catch {}
    return false
  }
}
