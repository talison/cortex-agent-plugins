import { expect, test } from 'bun:test'
import { lastWord, runPolling, type PollFailure } from '../lib/polling.ts'

test('a process that starts shutting down inside the settle window neither claims bot.pid nor polls', async () => {
  // A phantom server loses stdin within milliseconds; the old guard ran before
  // any handler could fire, so a phantom still SIGTERMed the live poller
  // (2026-11-16 audit, finding 3).
  let shuttingDown = false
  const events: string[] = []
  await runPolling({
    settleMs: 2000,
    sleep: async ms => { events.push(`sleep ${ms}`); shuttingDown = true },
    onSettled: () => { events.push('claim') },
    start: async () => { events.push('start') },
    isShuttingDown: () => shuttingDown, isConflict: () => false,
    onFailure: () => {}, onExhausted: () => {},
  })
  expect(events).toEqual(['sleep 2000'])
})

test('a process that outlives the settle window claims once, then polls', async () => {
  const events: string[] = []
  await runPolling({
    settleMs: 2000,
    sleep: async ms => { events.push(`sleep ${ms}`) },
    onSettled: () => { events.push('claim') },
    start: async () => { events.push('start') },
    isShuttingDown: () => false, isConflict: () => false,
    onFailure: () => {}, onExhausted: () => {},
  })
  expect(events).toEqual(['sleep 2000', 'claim', 'start'])
})

test('a claim that throws is reported and polling still starts', async () => {
  // A failed bot.pid write rejected runPolling and left a live server with
  // dead inbound (Fable review).
  const events: string[] = []
  await runPolling({
    settleMs: 1,
    sleep: async () => {},
    onSettled: () => { throw new Error('EACCES') },
    onSettledError: e => { events.push(`claim failed: ${(e as Error).message}`) },
    start: async () => { events.push('start') },
    isShuttingDown: () => false, isConflict: () => false,
    onFailure: () => {}, onExhausted: () => {},
  })
  expect(events).toEqual(['claim failed: EACCES', 'start'])
})

test('the last word reaches every chat and never outlasts its timeout', async () => {
  const sent: string[] = []
  const started = Date.now()
  await lastWord(async (chat, text) => {
    if (chat === 'hangs') return new Promise(() => {})
    if (chat === 'fails') throw new Error('403')
    sent.push(`${chat}: ${text}`)
  }, ['111', 'fails', 'hangs', '222'], 'inbound stopped', 50)
  expect(sent).toEqual(['111: inbound stopped', '222: inbound stopped'])
  expect(Date.now() - started).toBeLessThan(1000)
})

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
