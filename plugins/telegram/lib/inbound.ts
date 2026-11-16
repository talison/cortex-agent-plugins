/**
 * Hand one inbound message to Claude. grammy confirms the update to Telegram
 * whatever the handler does, so a hand-off that fails (the MCP transport
 * closing during a restart answers "Not connected") loses the message: it was
 * fire-and-forget with a stderr line nobody reads (2026-11-16 audit, finding
 * 4). Now it is awaited, and a failure runs `onLost` — log it and tell the
 * sender to send again — which never throws back into the update loop.
 */
export async function handOff(
  deliver: () => Promise<void>,
  onLost: (error: unknown) => Promise<void> | void,
): Promise<boolean> {
  try {
    await deliver()
    return true
  } catch (error) {
    try { await onLost(error) } catch {}
    return false
  }
}
