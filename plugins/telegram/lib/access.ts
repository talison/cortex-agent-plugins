import { readFileSync, renameSync, writeFileSync } from 'fs'

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

const stale = new WeakSet<Access>()

/**
 * True for an Access that is not what access.json says: the last good read
 * served while the file is unreadable, or the fail-closed answer after that.
 * saveAccess must never write one, or it would erase the file it stands in for.
 */
export function isStaleAccess(a: Access): boolean {
  return stale.has(a)
}

/**
 * Write access.json atomically (tmp + rename). Refuses a stale Access and
 * returns false: a stand-in written back would erase the file it stands in
 * for, and whatever edit made it unreadable (Fable review).
 */
export function writeAccessFile(file: string, a: Access, log: (msg: string) => void): boolean {
  if (isStaleAccess(a)) {
    log('access.json not saved: it is unreadable and this is a stand-in')
    return false
  }
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
  return true
}

/**
 * Why a reply/react/edit to `chatId` is refused, or null when it is allowed.
 * While access.json is unreadable the allowlist message was wrong and steered
 * Claude to the access skill, which reads and rewrites the broken file
 * (Fable review): the refusal names the file instead.
 */
export function outboundRefusal(access: Access, chatId: string, file: string): string | null {
  if (access.allowFrom.includes(chatId)) return null
  if (chatId in access.groups) return null
  if (isStaleAccess(access)) return `access.json is unreadable; fix the file (${file}), then retry`
  return `chat ${chatId} is not allowlisted — add via /telegram:access`
}

function markStale(a: Access): Access {
  stale.add(a)
  return a
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export type AccessReaderOpts = {
  /** Read attempts before a failure counts (a rewrite in progress). */
  attempts?: number
  retryMs?: number
  /** How long the last good read may stand in for an unreadable file. */
  staleWindowMs?: number
  now?: () => number
  sleep?: (ms: number) => void
  /**
   * Called once when a failure streak starts serving the last good read,
   * with that read: the owner warns its allowlist before inbound fails closed.
   */
  onStale?: (lastGood: Access, error: unknown) => void
}

/**
 * A reader for access.json. A missing file is the defaults (pairing).
 *
 * Any other failure used to move the file aside and fall back to pairing
 * with an empty allowlist: Tom's own DMs got "Pairing required" and the
 * allowlist sat in a `.corrupt-*` file (2026-11-16 audit, finding 10). Now:
 *  - the first failed read is retried briefly, which covers a rewrite in
 *    progress; later reads of a known-bad file try once, never blocking the
 *    event loop on every read (Fable review);
 *  - a failure that persists serves the last good read, marked stale (never
 *    saved), for at most `staleWindowMs` from the first failure;
 *  - after that, or with no good read in this process, it fails closed:
 *    dmPolicy "disabled", nothing allowed, also marked stale;
 *  - a read never renames or rewrites the file.
 * Each transition is logged once. A removed file is a reset: a later bad
 * read must not bring back the allowlist it had (codex review). While a good
 * read exists a missing file is retried too, then forgets it.
 */
export function accessReader(
  file: string,
  log: (msg: string, ctx: Record<string, unknown>) => void,
  opts: AccessReaderOpts = {},
): () => Access {
  const attempts = opts.attempts ?? 3
  const retryMs = opts.retryMs ?? 50
  const staleWindowMs = opts.staleWindowMs ?? 60_000
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? sleepSync
  let lastGood: Access | undefined
  let failingSince: number | undefined
  let reported: 'stale' | 'closed' | undefined

  const parse = (): Access => {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Access>
    return {
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
  }
  const isMissing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT'

  return () => {
    let error: unknown
    const tries = failingSince === undefined ? attempts : 1
    for (let i = 0; i < tries; i++) {
      if (i > 0) sleep(retryMs)
      try {
        const access = parse()
        lastGood = structuredClone(access)
        failingSince = undefined
        if (reported) log('access.json readable again', {})
        reported = undefined
        return access
      } catch (err) {
        error = err
        if (isMissing(err) && !lastGood) break   // not there before either: no retry
      }
    }
    if (isMissing(error)) {
      lastGood = undefined
      failingSince = undefined
      reported = undefined
      return defaultAccess()
    }
    failingSince ??= now()
    if (lastGood && now() - failingSince <= staleWindowMs) {
      if (reported !== 'stale') {
        log('access.json unreadable: serving the last good read (not saved)', { error: String(error) })
        reported = 'stale'
        try { opts.onStale?.(structuredClone(lastGood), error) } catch {}
      }
      return markStale(structuredClone(lastGood))
    }
    if (reported !== 'closed') {
      log('access.json unreadable: failing closed (dmPolicy disabled) until it reads again', { error: String(error) })
      reported = 'closed'
    }
    return markStale({ ...defaultAccess(), dmPolicy: 'disabled' })
  }
}
