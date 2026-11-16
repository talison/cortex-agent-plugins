import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { accessReader } from '../lib/access.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-access-'))
  dirs.push(dir)
  const file = join(dir, 'access.json')
  const logs: string[] = []
  const read = accessReader(file, msg => { logs.push(msg) })
  return { dir, file, logs, read }
}

const TOM = JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['111'], groups: {}, pending: {} })

test('a half-written access.json serves the last good read and stays in place', () => {
  // The access skill rewrites the file in place; a read mid-write moved the
  // allowlist aside and answered Tom with a pairing code (2026-11-16 audit, finding 10).
  const f = fixture()
  writeFileSync(f.file, TOM)
  expect(f.read().allowFrom).toEqual(['111'])
  writeFileSync(f.file, '{"dmPolicy": "allow')
  const during = f.read()
  expect(during.dmPolicy).toBe('allowlist')
  expect(during.allowFrom).toEqual(['111'])
  expect(readdirSync(f.dir)).toEqual(['access.json'])
  expect(f.logs).toHaveLength(1)
  writeFileSync(f.file, JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['111', '222'] }))
  expect(f.read().allowFrom).toEqual(['111', '222'])
})

test('the last good read is a copy, so a caller mutating it cannot change it', () => {
  const f = fixture()
  writeFileSync(f.file, TOM)
  f.read().allowFrom.push('999')
  writeFileSync(f.file, 'not json')
  const a = f.read()
  a.allowFrom.push('888')
  expect(f.read().allowFrom).toEqual(['111'])
})

test('an unreadable file is never moved aside', () => {
  const f = fixture()
  writeFileSync(f.file, TOM)
  chmodSync(f.file, 0o000)
  try {
    const a = f.read()
    if (process.getuid?.() !== 0) expect(a.allowFrom).toEqual([])
    expect(existsSync(f.file)).toBe(true)
    expect(readdirSync(f.dir)).toEqual(['access.json'])
  } finally {
    chmodSync(f.file, 0o600)
  }
})

test('a file that never parsed is moved aside as before, and a missing one is the defaults', () => {
  const f = fixture()
  expect(f.read()).toEqual({ dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {} })
  writeFileSync(f.file, 'not json')
  expect(f.read().dmPolicy).toBe('pairing')
  expect(existsSync(f.file)).toBe(false)
  expect(readdirSync(f.dir).some(n => n.startsWith('access.json.corrupt-'))).toBe(true)
})

test('a removed file is a reset: a bad file after it does not bring the old allowlist back', () => {
  // valid -> missing -> malformed served ['111'] again (codex review).
  const f = fixture()
  writeFileSync(f.file, TOM)
  expect(f.read().allowFrom).toEqual(['111'])
  rmSync(f.file)
  expect(f.read().allowFrom).toEqual([])
  writeFileSync(f.file, 'not json')
  expect(f.read().allowFrom).toEqual([])
})
