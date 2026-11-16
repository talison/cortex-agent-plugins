import { expect, test } from 'bun:test'
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

test('a delivered hand-off runs nothing else, and a throwing onLost stays inside', async () => {
  let lostCalls = 0
  expect(await handOff(async () => {}, () => { lostCalls++ })).toBe(true)
  expect(lostCalls).toBe(0)
  expect(await handOff(async () => { throw new Error('x') }, () => { throw new Error('reply failed too') })).toBe(false)
})
