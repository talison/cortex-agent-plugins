import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { accessReader, isStaleAccess, writeAccessFile, type AccessReaderOpts } from '../lib/access.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function fixture(opts: AccessReaderOpts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tg-access-'))
  dirs.push(dir)
  const file = join(dir, 'access.json')
  const logs: string[] = []
  let clock = 1_000_000
  const sleeps: number[] = []
  const read = accessReader(file, msg => { logs.push(msg) }, {
    now: () => clock, sleep: ms => { sleeps.push(ms) }, ...opts,
  })
  return { dir, file, logs, sleeps, read, advance: (ms: number) => { clock += ms } }
}

const TOM = JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['111'], groups: {}, pending: {} })
const CLOSED = { dmPolicy: 'disabled', allowFrom: [], groups: {}, pending: {} }

test('a read caught mid-rewrite is retried, and the finished file wins', () => {
  // The access skill rewrites the file in place (2026-11-16 audit, finding 10).
  let file = ''
  const f = fixture({
    sleep: () => { writeFileSync(file, JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['111', '222'] })) },
  })
  file = f.file
  writeFileSync(f.file, '{"dmPolicy": "allow')
  const a = f.read()
  expect(a.allowFrom).toEqual(['111', '222'])
  expect(isStaleAccess(a)).toBe(false)
  expect(f.logs).toEqual([])
})

test('a persistent failure serves the last good read, marked stale, and it is never saved', () => {
  const f = fixture()
  writeFileSync(f.file, TOM)
  expect(f.read().allowFrom).toEqual(['111'])
  writeFileSync(f.file, '{"dmPolicy": "allowlist", "allowFrom": ["111"],}')   // a hand edit with a trailing comma
  const during = f.read()
  expect(during.allowFrom).toEqual(['111'])
  expect(isStaleAccess(during)).toBe(true)
  expect(f.sleeps).toEqual([50, 50])
  // gate() prunes and saves what it read: the stand-in must not overwrite the edit.
  expect(writeAccessFile(f.file, during, () => {})).toBe(false)
  expect(readFileSync(f.file, 'utf8')).toContain('"allowFrom": ["111"],}')
  expect(readdirSync(f.dir)).toEqual(['access.json'])
  expect(f.logs).toHaveLength(1)
})

test('the stand-in expires: after the window the reader fails closed, then recovers', () => {
  const f = fixture({ staleWindowMs: 60_000 })
  writeFileSync(f.file, TOM)
  f.read()
  writeFileSync(f.file, 'not json')
  expect(f.read().allowFrom).toEqual(['111'])
  f.advance(59_000)
  expect(f.read().allowFrom).toEqual(['111'])
  f.advance(2_000)
  const closed = f.read()
  expect(closed).toEqual(CLOSED)
  expect(isStaleAccess(closed)).toBe(true)
  expect(f.logs).toHaveLength(2)
  writeFileSync(f.file, TOM)
  const back = f.read()
  expect(back.allowFrom).toEqual(['111'])
  expect(isStaleAccess(back)).toBe(false)
  expect(writeAccessFile(f.file, back, () => {})).toBe(true)
})

test('a good read followed by EACCES serves the stand-in, then fails closed; the file stays', () => {
  if (process.getuid?.() === 0) return   // root reads through chmod 000
  const f = fixture()
  writeFileSync(f.file, TOM)
  f.read()
  chmodSync(f.file, 0o000)
  try {
    expect(f.read().allowFrom).toEqual(['111'])
    f.advance(61_000)
    expect(f.read()).toEqual(CLOSED)
    expect(existsSync(f.file)).toBe(true)
    expect(readdirSync(f.dir)).toEqual(['access.json'])
  } finally {
    chmodSync(f.file, 0o600)
  }
})

test('with no good read in this process, a bad file fails closed and is left in place', () => {
  // Every session spawns its own server, so a "first read" recurs; moving the
  // file aside there lost the allowlist again (Fable review).
  const f = fixture()
  writeFileSync(f.file, 'not json')
  expect(f.read()).toEqual(CLOSED)
  expect(readFileSync(f.file, 'utf8')).toBe('not json')
  expect(readdirSync(f.dir)).toEqual(['access.json'])
})

test('a missing file is the defaults, and a removal resets: a bad file after it does not bring the allowlist back', () => {
  // valid -> missing -> malformed served ['111'] again (codex review).
  const f = fixture()
  expect(f.read()).toEqual({ dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} })
  expect(f.sleeps).toEqual([])   // never existed: no retry
  writeFileSync(f.file, TOM)
  expect(f.read().allowFrom).toEqual(['111'])
  rmSync(f.file)
  expect(f.read().allowFrom).toEqual([])
  writeFileSync(f.file, 'not json')
  expect(f.read()).toEqual(CLOSED)
})

test('the last good read is a copy, so a caller mutating it cannot change it', () => {
  const f = fixture()
  writeFileSync(f.file, TOM)
  f.read().allowFrom.push('999')
  writeFileSync(f.file, 'not json')
  f.read().allowFrom.push('888')
  expect(f.read().allowFrom).toEqual(['111'])
})
