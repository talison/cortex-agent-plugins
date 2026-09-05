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
  logFile: string
  exitCode: () => number | null
  closeInput: () => Promise<number>
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
  simulateReparent = false,
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

  const preload = join(dir, 'reparent.ts')
  if (simulateReparent) {
    // Exercise the real watchdog with live MCP stdin while the parent PID
    // changes, as it does when a launcher wrapper exits normally.
    writeFileSync(preload, `const original = process.ppid;
Object.defineProperty(process, 'ppid', { configurable: true, get: () => original });
setTimeout(() => Object.defineProperty(process, 'ppid', { get: () => 1 }), 100);
`)
  }
  const proc = Bun.spawn(['bun', ...(simulateReparent ? ['--preload', preload] : []), SERVER], {
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
    logFile: join(dir, 'state', 'logs', 'fork-debug.log'),
    exitCode: () => proc.exitCode,
    closeInput: () => { proc.stdin.end(); return proc.exited },
    stop: () => {
      if (proc.exitCode == null) proc.kill()
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


test('wrapper reparenting with open stdin does not stop the real poll loop', async () => {
  booted = await bootAgainstBridge(0, { messages: [], next_cursor: 0 }, 2, true)
  await Bun.sleep(5500) // cross the production watchdog's five-second interval
  const polls = booted.sinceParams.length
  await Bun.sleep(500)
  expect(booted.sinceParams.length).toBeGreaterThan(polls)
  expect(booted.exitCode()).toBeNull()
  expect(readFileSync(booted.logFile, 'utf8')).not.toContain('watchdog:orphan')
}, 15_000)


test('closing MCP stdin shuts down the real bridge process', async () => {
  booted = await bootAgainstBridge(0, { messages: [], next_cursor: 0 }, 2)
  expect(await booted.closeInput()).toBe(0)
  expect(readFileSync(booted.logFile, 'utf8')).toContain('shutdown trigger=stdin:')
}, 15_000)
