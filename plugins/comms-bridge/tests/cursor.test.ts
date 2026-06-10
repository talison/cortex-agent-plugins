import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { Cursor } from '../lib/cursor.ts'

function fixtureDir(): string {
  return mkdtempSync(join(tmpdir(), 'comms-cursor-'))
}

describe('Cursor', () => {
  test('returns 0 when file is missing', () => {
    const dir = fixtureDir()
    try {
      const c = new Cursor(join(dir, 'missing.cursor'))
      expect(c.read()).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('round-trips an integer', () => {
    const dir = fixtureDir()
    try {
      const path = join(dir, 'roundtrip.cursor')
      const c = new Cursor(path)
      c.write(42)
      expect(c.read()).toBe(42)
      const raw = readFileSync(path, 'utf8')
      expect(raw.trim()).toBe('42')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('treats parse failure as 0 (defensive recovery)', () => {
    const dir = fixtureDir()
    try {
      const path = join(dir, 'corrupt.cursor')
      writeFileSync(path, 'not-a-number\n')
      const c = new Cursor(path)
      expect(c.read()).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('treats negative numbers as 0', () => {
    const dir = fixtureDir()
    try {
      const path = join(dir, 'negative.cursor')
      writeFileSync(path, '-7\n')
      const c = new Cursor(path)
      expect(c.read()).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('write creates parent dir if missing', () => {
    const dir = fixtureDir()
    try {
      const path = join(dir, 'nested', 'sub', 'pos.cursor')
      const c = new Cursor(path)
      c.write(123)
      expect(c.read()).toBe(123)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('write floors fractional input and clamps negative to 0', () => {
    const dir = fixtureDir()
    try {
      const path = join(dir, 'clamp.cursor')
      const c = new Cursor(path)
      c.write(7.9)
      expect(c.read()).toBe(7)
      c.write(-5)
      expect(c.read()).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Cursor.onReset', () => {
  test('fires on unparseable content, not on missing file', () => {
    const dir = fixtureDir()
    try {
      const path = join(dir, 'reset.cursor')
      const c = new Cursor(path)
      const reasons: string[] = []
      c.onReset = r => reasons.push(r)

      expect(c.read()).toBe(0) // missing file — normal first boot
      expect(reasons).toEqual([])

      writeFileSync(path, 'not-a-number\n')
      expect(c.read()).toBe(0)
      expect(reasons.length).toBe(1)
      expect(reasons[0]).toContain('not-a-number')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
