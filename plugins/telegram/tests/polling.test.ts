import { expect, test } from 'bun:test'
import { runPolling, type PollFailure } from '../lib/polling.ts'

function fixture(start: (onPollSuccess: () => void) => Promise<void>) {
  const failures: PollFailure[] = []
  const delays: number[] = []
  let exhausted = false
  return {
    failures, delays, get exhausted() { return exhausted },
    run: () => runPolling({
      start, isShuttingDown: () => false, isConflict: e => e === '409',
      onFailure: f => { failures.push(f) }, onExhausted: () => { exhausted = true },
      sleep: async ms => { delays.push(ms) },
    }),
  }
}

test('409 polling failures stop after eight attempts, with backoff', async () => {
  let starts = 0
  const f = fixture(async () => { starts++; throw '409' })
  await f.run()
  expect(starts).toBe(8)
  expect(f.delays).toEqual([1000, 2000, 3000, 4000, 5000, 6000, 7000])
  expect(f.exhausted).toBe(true)
})

test('a successful poll resets the count for a later outage', async () => {
  let starts = 0
  const f = fixture(async onPollSuccess => {
    starts++
    if (starts === 3) onPollSuccess()
    if (starts === 5) return
    throw '409'
  })
  await f.run()
  expect(f.failures.map(f => f.attempt)).toEqual([1, 2, 1, 2])
  expect(f.exhausted).toBe(false)
})

test('network failures retry with a capped delay', async () => {
  let starts = 0
  const f = fixture(async () => { if (++starts <= 20) throw new Error('offline') })
  await f.run()
  expect(f.delays[0]).toBe(1000)
  expect(f.delays.at(-1)).toBe(15000)
  expect(f.exhausted).toBe(false)
})

test('shutdown and aborted setup do not restart polling', async () => {
  const f = fixture(async () => { throw new Error('Aborted delay') })
  await f.run()
  expect(f.failures).toEqual([])
  await runPolling({
    start: async () => { throw new Error('must not start') },
    isShuttingDown: () => true, isConflict: () => false,
    onFailure: () => { throw new Error('must not retry') }, onExhausted: () => {},
  })
})

test('prior network failures do not exhaust the conflict allowance', async () => {
  let starts = 0
  const f = fixture(async () => {
    starts++
    if (starts <= 10) throw new Error('offline')
    if (starts <= 12) throw '409'
  })
  await f.run()
  expect(starts).toBe(13)
  expect(f.exhausted).toBe(false)
})

test('an invalid token exits immediately without retrying', async () => {
  const failures: PollFailure[] = []
  let stopped = false
  await runPolling({
    start: async () => { throw '401' },
    isShuttingDown: () => false, isConflict: () => false, isFatal: error => error === '401',
    onFailure: failure => { failures.push(failure) },
    onExhausted: failure => { stopped = failure.fatal },
    sleep: async () => { throw new Error('must not retry an invalid token') },
  })
  expect(stopped).toBe(true)
  expect(failures).toHaveLength(1)
})
