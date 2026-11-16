import { expect, test } from 'bun:test'
import { PassThrough, Writable } from 'stream'
import { handOff } from '../lib/inbound.ts'

const base = '../node_modules/@modelcontextprotocol/sdk/dist/esm'

test('a hand-off on a closed MCP transport rejects, and the sender is told', async () => {
  // The transport closing during a restart: the SDK answers "Not connected",
  // and the message, already confirmed to Telegram, was lost with only a
  // stderr line (2026-11-16 audit, finding 4).
  const { Server } = await import(`${base}/server/index.js`)
  const { InMemoryTransport } = await import(`${base}/inMemory.js`)
  const server = new Server({ name: 't', version: '0' }, { capabilities: { experimental: { 'claude/channel': {} } } })
  const [ours, theirs] = InMemoryTransport.createLinkedPair()
  await server.connect(ours)
  await theirs.close()

  const lost: string[] = []
  const delivered = await handOff(
    () => server.notification({ method: 'notifications/claude/channel', params: { content: 'hi', meta: {} } }),
    error => { lost.push(String(error)) },
  )
  expect(delivered).toBe(false)
  expect(lost).toEqual(['Error: Not connected'])
})

test('a stdio transport whose stdout never drains cannot hold the update loop', async () => {
  // The production transport resolves a send only on 'drain'; a stalled or
  // failed stdout never emits it, and an unbounded await would stop every
  // later update (codex review).
  const { Server } = await import(`${base}/server/index.js`)
  const { StdioServerTransport } = await import(`${base}/server/stdio.js`)
  const stalled = new Writable({ highWaterMark: 1, write() { /* never calls back */ } })
  const server = new Server({ name: 't', version: '0' }, { capabilities: { experimental: { 'claude/channel': {} } } })
  await server.connect(new StdioServerTransport(new PassThrough(), stalled))

  const lost: string[] = []
  const started = Date.now()
  const delivered = await handOff(
    () => server.notification({ method: 'notifications/claude/channel', params: { content: 'hi', meta: {} } }),
    error => { lost.push(String(error)) },
    { timeoutMs: 100 },
  )
  expect(delivered).toBe(false)
  expect(lost).toEqual(['Error: hand-off timed out after 100 ms'])
  expect(Date.now() - started).toBeLessThan(2000)
})

test('a stdout that stalls past the timeout, then drains: the timeout ends the transport first', async () => {
  // The write is queued before the wait, so it arrives once the pipe drains:
  // after the sender was told to resend, or a verdict retried the other way.
  // A timeout therefore calls onTimeout, which the server wires to
  // shutdown('stdout:stalled') (Fable review).
  const { Server } = await import(`${base}/server/index.js`)
  const { StdioServerTransport } = await import(`${base}/server/stdio.js`)
  const written: string[] = []
  let release: (() => void) | undefined
  const out = new Writable({
    highWaterMark: 1,
    write(chunk, _e, cb) { written.push(String(chunk)); release = cb },   // held until released
  })
  const server = new Server({ name: 't', version: '0' }, { capabilities: { experimental: { 'claude/channel': {} } } })
  await server.connect(new StdioServerTransport(new PassThrough(), out))

  const events: string[] = []
  let dead = false
  const delivered = await handOff(
    () => server.notification({ method: 'notifications/claude/channel', params: { content: 'hi', meta: {} } }),
    e => { events.push(`lost: ${String(e)}`) },
    { timeoutMs: 50, isDead: () => dead, onTimeout: () => { dead = true; events.push('transport ended') } },
  )
  expect(delivered).toBe(false)
  expect(events).toEqual(['transport ended', 'lost: Error: hand-off timed out after 50 ms'])
  expect(written).toHaveLength(1)   // queued before the wait: why the transport must end
  release?.()                       // the pipe drains late
  await new Promise(r => setTimeout(r, 20))
  expect(events).toHaveLength(2)    // nothing further, no throw
  expect(dead).toBe(true)
})

test('a stalled notice cannot hold the update loop either; its signal is aborted', async () => {
  // grammy's request timeout is 500 s, so an unbounded ctx.reply in onLost
  // stalled every later update (codex review).
  let aborted = false
  const started = Date.now()
  const ok = await handOff(
    async () => { throw new Error('Not connected') },
    (_e, signal) => new Promise(() => { signal.addEventListener('abort', () => { aborted = true }) }),
    { noticeTimeoutMs: 50 },
  )
  expect(ok).toBe(false)
  expect(aborted).toBe(true)
  expect(Date.now() - started).toBeLessThan(1000)
})

test('a settled send leaves no shutdown subscription behind', async () => {
  // One subscription per send on a shared promise grew until shutdown (codex review).
  const subs = new Set<() => void>()
  const onDying = (cb: () => void) => { subs.add(cb); return () => { subs.delete(cb) } }
  for (let i = 0; i < 5; i++) expect(await handOff(async () => {}, () => {}, { onDying })).toBe(true)
  await handOff(async () => { throw new Error('x') }, () => {}, { onDying })
  expect(subs.size).toBe(0)
})

test('a destroyed stdout is a lost hand-off at once, never a send into the void', async () => {
  // During a restart stdout dies with the session; the old await either
  // "succeeded" into a dead pipe or stalled past the exit (Fable review).
  const { Server } = await import(`${base}/server/index.js`)
  const { StdioServerTransport } = await import(`${base}/server/stdio.js`)
  const out = new Writable({ write(_c, _e, cb) { cb() } })
  out.on('error', () => {})
  const server = new Server({ name: 't', version: '0' }, { capabilities: { experimental: { 'claude/channel': {} } } })
  await server.connect(new StdioServerTransport(new PassThrough(), out))
  out.destroy()

  let sends = 0
  const lost: string[] = []
  const delivered = await handOff(
    () => { sends++; return server.notification({ method: 'notifications/claude/channel', params: { content: 'hi', meta: {} } }) },
    error => { lost.push(String(error)) },
    { isDead: () => out.destroyed || out.writableEnded },
  )
  expect(delivered).toBe(false)
  expect(sends).toBe(0)
  expect(lost).toEqual(['Error: transport closed'])
})

test('a send that is waiting when shutdown starts gives up at once', async () => {
  const subs = new Set<() => void>()
  const onDying = (cb: () => void) => { subs.add(cb); return () => { subs.delete(cb) } }
  const lost: string[] = []
  const started = Date.now()
  const pending = handOff(() => new Promise(() => {}), e => { lost.push(String(e)) }, { onDying, timeoutMs: 10_000 })
  setTimeout(() => { for (const cb of [...subs]) cb() }, 20)
  expect(await pending).toBe(false)
  expect(lost).toEqual(['Error: transport closed'])
  expect(Date.now() - started).toBeLessThan(1000)
})

test('a send accepted while the transport died counts as lost', async () => {
  let dead = false
  const lost: string[] = []
  const ok = await handOff(async () => { dead = true }, e => { lost.push(String(e)) }, { isDead: () => dead })
  expect(ok).toBe(false)
  expect(lost).toEqual(['Error: transport closed while sending'])
})

test('a delivered hand-off runs nothing else, and a throwing onLost stays inside', async () => {
  let lostCalls = 0
  expect(await handOff(async () => {}, () => { lostCalls++ })).toBe(true)
  expect(lostCalls).toBe(0)
  expect(await handOff(async () => { throw new Error('x') }, () => { throw new Error('reply failed too') })).toBe(false)
})
