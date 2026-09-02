/**
 * Integration cover for the `cursor_reset` rewind in server.ts's poll loop.
 *
 * The loop lives inside server.ts's module-level IIFE, so a unit test would
 * have to re-implement it and would then only be testing the copy. Instead we
 * boot the real server.ts as a subprocess against a stub bridge — every path
 * it touches is env-overridable (COMMS_BRIDGE_URL / _CURSOR_PATH / _STATE_DIR
 * / _TOKEN), so this needs no keychain, no real service, and writes nothing
 * outside a temp dir.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SERVER = join(import.meta.dir, '..', 'server.ts')

interface Booted {
  /** `since` query param of each GET /inbox, in arrival order. */
  sinceParams: number[]
  cursorFile: string
  stop: () => void
}

/**
 * Boot server.ts against a stub bridge seeded with `startCursor`.
 *
 * The first /inbox poll gets `firstResponse`; every later poll is held for
 * 200ms and answered empty, so the loop doesn't spin while we assert.
 * Resolves once `awaitPolls` polls have arrived.
 */
async function bootAgainstBridge(
  startCursor: number,
  firstResponse: Record<string, unknown>,
  awaitPolls: number,
): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), 'comms-bridge-test-'))
  const cursorFile = join(dir, 'cursor')
  writeFileSync(cursorFile, `${startCursor}\n`)

  const sinceParams: number[] = []
  let resolveWhenReady: () => void
  const ready = new Promise<void>(r => {
    resolveWhenReady = r
  })

  const bridge = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname !== '/inbox') {
        return new Response(JSON.stringify({ ok: true, updated: true }), {
          status: 200,
        })
      }
      const n = sinceParams.push(Number(url.searchParams.get('since')))
      if (n >= awaitPolls) resolveWhenReady()
      if (n === 1) {
        return new Response(JSON.stringify(firstResponse), { status: 200 })
      }
      // Stand in for the bridge's long poll so the loop idles instead of
      // hammering us for the rest of the test.
      await Bun.sleep(200)
      return new Response(
        JSON.stringify({ messages: [], next_cursor: 0 }),
        { status: 200 },
      )
    },
  })

  const proc = Bun.spawn(['bun', SERVER], {
    env: {
      ...process.env,
      COMMS_BRIDGE_URL: `http://127.0.0.1:${bridge.port}`,
      COMMS_BRIDGE_CURSOR_PATH: cursorFile,
      COMMS_BRIDGE_STATE_DIR: join(dir, 'state'),
      // Short-circuits the Keychain lookup — no `security` call from a test.
      COMMS_BRIDGE_TOKEN: 'test-token',
    },
    stdin: 'pipe', // keep it open: an EOF on stdin triggers shutdown
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const timeout = Bun.sleep(10_000).then(() => {
    throw new Error(
      `timed out waiting for ${awaitPolls} polls; saw ${JSON.stringify(sinceParams)}`,
    )
  })
  try {
    await Promise.race([ready, timeout])
  } catch (err) {
    proc.kill()
    bridge.stop(true)
    rmSync(dir, { recursive: true, force: true })
    throw err
  }

  return {
    sinceParams,
    cursorFile,
    stop: () => {
      proc.kill()
      bridge.stop(true)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

let booted: Booted | undefined
afterEach(() => {
  booted?.stop()
  booted = undefined
})

describe('poll loop: cursor_reset', () => {
  test('rewinds the cursor file to 0 and re-polls with since=0', async () => {
    booted = await bootAgainstBridge(
      42,
      // The bridge's DB was restored from backup: our 42 is past its MAX(id).
      { messages: [], next_cursor: 42, cursor_reset: true },
      2,
    )

    // First poll went out at the stored cursor...
    expect(booted.sinceParams[0]).toBe(42)
    // ...and the flag rewound us rather than advancing to next_cursor.
    expect(booted.sinceParams[1]).toBe(0)
    // The rewind is persisted, so a restart doesn't resurrect the stale cursor.
    expect(readFileSync(booted.cursorFile, 'utf8').trim()).toBe('0')
  }, 15_000)

  test('without the flag the cursor advances normally', async () => {
    booted = await bootAgainstBridge(
      42,
      { messages: [], next_cursor: 77 },
      2,
    )

    expect(booted.sinceParams[0]).toBe(42)
    expect(booted.sinceParams[1]).toBe(77)
    expect(readFileSync(booted.cursorFile, 'utf8').trim()).toBe('77')
  }, 15_000)
})
