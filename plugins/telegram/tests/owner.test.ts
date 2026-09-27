import { describe, expect, test } from 'bun:test'

import { channelOwner, isClaudeProcess, type OwnerProbe } from '../lib/owner.ts'

// Process table: pid -> [ppid, args]
type Table = Record<number, [number, string]>

function probe(table: Table, opts: { marker?: string; session?: number; start: number }): OwnerProbe {
  return {
    env: opts.marker === undefined ? {} : { CORTEX_CHANNEL_OWNER: opts.marker },
    startPid: opts.start,
    sessionPid: () => opts.session,
    parentOf: pid => (table[pid] ? { ppid: table[pid][0], args: table[pid][1] } : undefined),
  }
}

// launchd 1 <- tmux 100 <- start-cortex 200 (execs into claude, same pid) <- bun run 300 <- server.ts
const CORTEX: Table = {
  100: [1, 'tmux new-session -s cortex'],
  200: [100, 'claude --resume abc --dangerously-load-development-channels plugin:telegram@cortex-agent-plugins'],
  300: [200, 'bun run --cwd /cache/telegram/0.1.0-fork.9 --shell=bun --silent start'],
}

describe('channelOwner', () => {
  test('the start-cortex.sh session owns the channel', () => {
    const v = channelOwner(probe(CORTEX, { marker: '1', session: 200, start: 300 }))
    expect(v.owner).toBe(true)
  })

  test('a session without the marker never owns it (plain `claude` over ssh)', () => {
    const table: Table = { 500: [1, 'sshd'], 600: [500, '-zsh'], 700: [600, 'claude'], 800: [700, 'bun run start'] }
    expect(channelOwner(probe(table, { session: 200, start: 800 })).owner).toBe(false)
    expect(channelOwner(probe(table, { marker: '0', session: 200, start: 800 })).owner).toBe(false)
  })

  test('a claude started from inside the Cortex session inherits the marker but is not the owner', () => {
    const table: Table = { ...CORTEX, 400: [200, '/bin/zsh -c claude'], 410: [400, 'claude'], 420: [410, 'bun run start'] }
    const v = channelOwner(probe(table, { marker: '1', session: 200, start: 420 }))
    expect(v.owner).toBe(false)
    expect(v.reason).toContain('410')
  })

  test('a reparented server (no claude ancestor visible) falls back to the marker', () => {
    const table: Table = { 300: [1, 'bun run start'] }
    expect(channelOwner(probe(table, { marker: '1', session: 200, start: 300 })).owner).toBe(true)
  })

  test('an unreadable session.json falls back to the marker', () => {
    expect(channelOwner(probe(CORTEX, { marker: '1', session: undefined, start: 300 })).owner).toBe(true)
  })

  test('a stale session.json pid (Cortex restarted, stamp not yet rewritten) is not trusted over the process tree', () => {
    expect(channelOwner(probe(CORTEX, { marker: '1', session: 999, start: 300 })).owner).toBe(false)
  })
})

test('the session pid is honoured wherever it sits in the chain (a non-claude session pid, as the integration tests use)', () => {
  const table: Table = { 50: [1, 'bun test'], 60: [50, 'bun run start'] }
  expect(channelOwner(probe(table, { marker: '1', session: 50, start: 60 })).owner).toBe(true)
})

describe('isClaudeProcess', () => {
  test('matches the launcher name and the versioned binary path', () => {
    expect(isClaudeProcess('claude --resume x')).toBe(true)
    expect(isClaudeProcess('/Users/t/.local/bin/claude')).toBe(true)
    expect(isClaudeProcess('/Users/t/.local/share/claude/versions/2.1.283 --resume x')).toBe(true)
    expect(isClaudeProcess('bun run --cwd /cache/claude-channel start')).toBe(false)
    expect(isClaudeProcess('/bin/zsh -c claude')).toBe(false)
  })
})
