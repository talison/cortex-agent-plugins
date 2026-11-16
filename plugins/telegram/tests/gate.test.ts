import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { accessReader, writeAccessFile } from '../lib/access.ts'
import { gate } from '../lib/gate.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function setup(initial: object) {
  const dir = mkdtempSync(join(tmpdir(), 'tg-gate-'))
  dirs.push(dir)
  const file = join(dir, 'access.json')
  writeFileSync(file, JSON.stringify(initial))
  const load = accessReader(file, () => {}, { sleep: () => {} })
  let n = 0
  const deps = {
    load,
    save: (a: Parameters<typeof writeAccessFile>[1]) => writeAccessFile(file, a, () => {}),
    mentioned: () => false,
    newCode: () => `code${++n}`,
  }
  return { file, deps }
}

const stranger = { from: { id: 999 }, chat: { id: 999, type: 'private' } }
const tom = { from: { id: 111 }, chat: { id: 111, type: 'private' } }
const PAIRING = { dmPolicy: 'pairing', allowFrom: ['111'], groups: {}, pending: {} }

test('pairing works as before while access.json reads', () => {
  const { file, deps } = setup(PAIRING)
  expect(gate(stranger, deps)).toEqual({ action: 'pair', code: 'code1', isResend: false })
  expect(JSON.parse(readFileSync(file, 'utf8')).pending.code1.senderId).toBe('999')
  expect(gate(stranger, deps)).toEqual({ action: 'pair', code: 'code1', isResend: true })
  expect(gate(stranger, deps)).toEqual({ action: 'drop' })
})

test('no pairing codes while access.json is unreadable, and Tom still gets through', () => {
  // The stand-in is never saved, so a code handed out could never be
  // approved, and each read restored the old pending state: five fresh codes
  // for one sender, none persisted (codex review).
  const { file, deps } = setup(PAIRING)
  expect(gate(tom, deps).action).toBe('deliver')      // a good read first
  writeFileSync(file, '{"dmPolicy": "pairing",')     // then the file breaks
  for (let i = 0; i < 5; i++) expect(gate(stranger, deps)).toEqual({ action: 'drop' })
  expect(gate(tom, deps).action).toBe('deliver')
  expect(readFileSync(file, 'utf8')).toBe('{"dmPolicy": "pairing",')
})

test('a refused save hands out no code', () => {
  const { deps } = setup(PAIRING)
  expect(gate(stranger, { ...deps, save: () => false })).toEqual({ action: 'drop' })
})
