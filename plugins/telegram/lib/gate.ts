import { randomBytes } from 'crypto'
import { isStaleAccess, type Access } from './access.js'

/** The parts of a grammy Context the gate reads. */
export type GateCtx = {
  from?: { id: number }
  chat?: { id: number; type: string }
}

export type GateResult =
  | { action: 'deliver'; access: Access }
  | { action: 'drop' }
  | { action: 'pair'; code: string; isResend: boolean }

export type GateDeps = {
  load: () => Access
  /** Persist access.json; false when it refused (a stale stand-in). */
  save: (a: Access) => boolean
  mentioned: (ctx: GateCtx, patterns?: string[]) => boolean
  newCode?: () => string
  now?: () => number
}

export function pruneExpired(a: Access, now = Date.now()): boolean {
  let changed = false
  for (const [code, p] of Object.entries(a.pending)) {
    if (p.expiresAt < now) {
      delete a.pending[code]
      changed = true
    }
  }
  return changed
}

/**
 * The inbound gate (moved out of server.ts so it can be tested). Pairing
 * needs a saved access.json: while the file is unreadable the reader serves a
 * stale stand-in that is never written, so a code handed out then could never
 * be approved, and every read restored the old pending state, which undid the
 * reply limit (codex review). Strangers are dropped until the file reads.
 */
export function gate(ctx: GateCtx, deps: GateDeps): GateResult {
  const now = deps.now ?? Date.now
  const access = deps.load()
  const pruned = pruneExpired(access, now())
  // A stale stand-in is never saved; pruning it would only log a refusal per message.
  if (pruned && !isStaleAccess(access)) deps.save(access)

  if (access.dmPolicy === 'disabled') return { action: 'drop' }

  const from = ctx.from
  if (!from) return { action: 'drop' }
  const senderId = String(from.id)
  const chatType = ctx.chat?.type

  if (chatType === 'private') {
    if (access.allowFrom.includes(senderId)) return { action: 'deliver', access }
    if (access.dmPolicy === 'allowlist') return { action: 'drop' }
    if (isStaleAccess(access)) return { action: 'drop' }

    // pairing mode — check for existing non-expired code for this sender
    for (const [code, p] of Object.entries(access.pending)) {
      if (p.senderId === senderId) {
        // Reply twice max (initial + one reminder), then go silent.
        if ((p.replies ?? 1) >= 2) return { action: 'drop' }
        p.replies = (p.replies ?? 1) + 1
        if (!deps.save(access)) return { action: 'drop' }
        return { action: 'pair', code, isResend: true }
      }
    }
    // Cap pending at 3. Extra attempts are silently dropped.
    if (Object.keys(access.pending).length >= 3) return { action: 'drop' }

    const code = deps.newCode?.() ?? randomBytes(3).toString('hex') // 6 hex chars
    const t = now()
    access.pending[code] = {
      senderId,
      chatId: String(ctx.chat!.id),
      createdAt: t,
      expiresAt: t + 60 * 60 * 1000, // 1h
      replies: 1,
    }
    if (!deps.save(access)) return { action: 'drop' }
    return { action: 'pair', code, isResend: false }
  }

  if (chatType === 'group' || chatType === 'supergroup') {
    const groupId = String(ctx.chat!.id)
    const policy = access.groups[groupId]
    if (!policy) return { action: 'drop' }
    const groupAllowFrom = policy.allowFrom ?? []
    const requireMention = policy.requireMention ?? true
    if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
      return { action: 'drop' }
    }
    if (requireMention && !deps.mentioned(ctx, access.mentionPatterns)) {
      return { action: 'drop' }
    }
    return { action: 'deliver', access }
  }

  return { action: 'drop' }
}
