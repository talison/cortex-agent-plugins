import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// A session that is not the start-cortex.sh session must never read the inbox
// (2026-09-26: a second ssh session long-polled Cortex's inbox). The real
// server is spawned against a stand-in bridge that counts inbox requests.

const SERVER = join(import.meta.dir, '..', 'server.ts')
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function inboxPolls(extraEnv: Record<string, string>): Promise<{ polls: number; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'cb-owner-'))
  dirs.push(dir)
  let polls = 0
  const bridge = Bun.serve({
    port: 0,
    fetch: async req => {
      if (new URL(req.url).pathname === '/inbox') polls++
      await Bun.sleep(200)
      return new Response(JSON.stringify({ messages: [], next_cursor: 0 }), { status: 200 })
    },
  })
  const env: Record<string, string | undefined> = {
    ...process.env,
    COMMS_BRIDGE_URL: `http://127.0.0.1:${bridge.port}`,
    COMMS_BRIDGE_CURSOR_PATH: join(dir, 'cursor'),
    COMMS_BRIDGE_STATE_DIR: join(dir, 'state'),
    COMMS_BRIDGE_TOKEN: 'test-token',
    ...extraEnv,
  }
  if (!('CORTEX_CHANNEL_OWNER' in extraEnv)) delete env.CORTEX_CHANNEL_OWNER
  const proc = Bun.spawn(['bun', SERVER], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  await Bun.sleep(2500)
  proc.stdin.end()
  await proc.exited
  bridge.stop(true)
  return { polls, stderr: await new Response(proc.stderr).text() }
}

test('without the owner marker the server never polls the inbox', async () => {
  const { polls, stderr } = await inboxPolls({})
  expect(polls).toBe(0)
  expect(stderr).toContain('inbound disabled')
}, 15_000)
