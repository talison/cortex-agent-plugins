import { readFileSync, renameSync } from 'fs'

export type PendingEntry = {
  senderId: string
  chatId: string
  createdAt: number
  expiresAt: number
  replies: number
}

export type GroupPolicy = {
  requireMention: boolean
  allowFrom: string[]
}

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  groups: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  // delivery/UX config — optional, defaults live in the reply handler
  /** Emoji to react with on receipt. Empty string disables. Telegram only accepts its fixed whitelist. */
  ackReaction?: string
  /** Which chunks get Telegram's reply reference when reply_to is passed. Default: 'first'. 'off' = never thread. */
  replyToMode?: 'off' | 'first' | 'all'
  /** Max chars per outbound message before splitting. Default: 4096 (Telegram's hard cap). */
  textChunkLimit?: number
  /** 'newline' (default): last paragraph, line or space break past half the limit, else the limit. 'length': the limit. */
  chunkMode?: 'length' | 'newline'
}

export function defaultAccess(): Access {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    pending: {},
  }
}

/**
 * A reader for access.json. A missing file is the defaults. Any other failure
 * (a parse error from a half-written file, EACCES) used to move the file
 * aside and fall back to pairing with an empty allowlist: Tom's own DMs got
 * "Pairing required" and the allowlist sat in a `.corrupt-*` file until
 * someone restored it (2026-11-16 audit, finding 10). Now a failed read
 * serves the last good read, and the file stays where it is; only a file
 * that never parsed in this process, and does not parse now, is moved aside.
 */
export function accessReader(
  file: string,
  log: (msg: string, ctx: Record<string, unknown>) => void,
): () => Access {
  let lastGood: Access | undefined
  return () => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Access>
      const access: Access = {
        dmPolicy: parsed.dmPolicy ?? 'pairing',
        allowFrom: parsed.allowFrom ?? [],
        groups: parsed.groups ?? {},
        pending: parsed.pending ?? {},
        mentionPatterns: parsed.mentionPatterns,
        ackReaction: parsed.ackReaction,
        replyToMode: parsed.replyToMode,
        textChunkLimit: parsed.textChunkLimit,
        chunkMode: parsed.chunkMode,
      }
      lastGood = structuredClone(access)
      return access
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // A removed file is a reset: a later bad read must not bring back
        // the allowlist it had (codex review).
        lastGood = undefined
        return defaultAccess()
      }
      if (lastGood) {
        log('access.json unreadable, serving the last good read', { error: String(err) })
        return structuredClone(lastGood)
      }
      if (err instanceof SyntaxError) {
        try {
          renameSync(file, `${file}.corrupt-${Date.now()}`)
        } catch {}
        log('access.json is corrupt, moved aside; starting fresh', { error: String(err) })
      } else {
        log('access.json unreadable; using defaults', { error: String(err) })
      }
      return defaultAccess()
    }
  }
}
