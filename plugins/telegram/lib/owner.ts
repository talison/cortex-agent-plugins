// Channel ownership: only the Cortex session launched by scripts/start-cortex.sh
// may consume inbound traffic (Telegram getUpdates, bridge inbox). Every other
// Claude Code session loads this plugin too (it is enabled user-wide), and
// without this gate its instance takes the bot over — 2026-09-26, a second
// ssh session SIGTERM'd the Cortex poller and long-polled the bridge inbox.
//
// Two signals, both required when they can be read:
// 1. start-cortex.sh exports CORTEX_CHANNEL_OWNER=1 before `exec claude`.
//    A session started any other way lacks it.
// 2. start-cortex.sh stamps its own pid into ~/.cortex/data/session.json and
//    then execs claude, so that pid IS the Cortex claude. Walking up from this
//    process, that pid must be reached before any other `claude` — which
//    rejects a claude started from inside the Cortex session (it inherits the
//    env marker). CORTEX_CHANNEL_SESSION_FILE overrides the path (tests only).
// If the ancestor walk finds no claude (the bun wrapper exited and we were
// reparented to launchd) or session.json is unreadable, the marker decides:
// failing closed there would silence Cortex itself.
//
// A non-owner keeps serving its tools (reply, send); it only never polls,
// never claims the bot pid file and never signals another poller.

import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'

export type OwnerVerdict = { owner: boolean; reason: string }

export type OwnerProbe = {
  env: Record<string, string | undefined>
  startPid: number
  sessionPid: () => number | undefined
  parentOf: (pid: number) => { ppid: number; args: string } | undefined
}

const MAX_HOPS = 8

export function isClaudeProcess(args: string): boolean {
  const first = args.trim().split(/\s+/)[0] ?? ''
  return basename(first) === 'claude' || first.includes('/claude/versions/')
}

export function channelOwner(probe: OwnerProbe = defaultProbe()): OwnerVerdict {
  if (probe.env.CORTEX_CHANNEL_OWNER !== '1') {
    return { owner: false, reason: 'no CORTEX_CHANNEL_OWNER marker (not the start-cortex.sh session)' }
  }
  const sessionPid = probe.sessionPid()
  if (!sessionPid) return { owner: true, reason: 'marker set; session.json unreadable' }
  let pid = probe.startPid
  for (let hop = 0; hop < MAX_HOPS && pid > 1; hop++) {
    if (pid === sessionPid) return { owner: true, reason: `ancestor pid ${pid} is the Cortex session` }
    const info = probe.parentOf(pid)
    if (!info) break
    if (isClaudeProcess(info.args)) {
      return { owner: false, reason: `nearest claude ancestor pid ${pid} is not the Cortex session (pid ${sessionPid})` }
    }
    pid = info.ppid
  }
  return { owner: true, reason: 'marker set; no claude ancestor visible' }
}

function defaultProbe(): OwnerProbe {
  return {
    env: process.env,
    startPid: process.ppid,
    sessionPid: () => {
      try {
        const file = process.env.CORTEX_CHANNEL_SESSION_FILE || join(homedir(), '.cortex', 'data', 'session.json')
        const pid = Number(JSON.parse(readFileSync(file, 'utf8')).pid)
        return Number.isInteger(pid) && pid > 1 ? pid : undefined
      } catch {
        return undefined
      }
    },
    parentOf: pid => {
      try {
        const out = execFileSync('ps', ['-o', 'ppid=,args=', '-p', String(pid)], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
        const m = out.match(/^(\d+)\s+(.*)$/s)
        return m ? { ppid: Number(m[1]), args: m[2] } : undefined
      } catch {
        return undefined
      }
    },
  }
}
