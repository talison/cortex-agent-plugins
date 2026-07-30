/**
 * HTTP client for the comms-bridge service (Phase 1).
 *
 * Three endpoints used:
 *   GET  /inbox?agent=cortex&since=N&timeout=25  → InboxResponse
 *   POST /send                                   → SendResponse
 *   POST /ack                                    → AckResponse
 *
 * Errors throw `BridgeError` with the upstream status + body when present, so
 * the caller can log a meaningful diagnostic. Network-level failures (the
 * service being down) throw the underlying fetch error.
 */

export interface InboxMessage {
  id: number
  uuid: string
  from_agent: string
  to_agent: string
  kind: string
  payload: unknown
  reply_to_uuid: string | null
  created_at: string
}

export interface InboxResponse {
  messages: InboxMessage[]
  next_cursor: number
}

export interface SendArgs {
  uuid: string
  from_agent: string
  to_agent: string
  kind: 'request' | 'response' | 'notify'
  payload?: unknown
  reply_to_uuid?: string
}

export interface SendResponse {
  id: number
  uuid: string
  stored_at: string
  duplicate: boolean
}

export class BridgeError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message)
    this.name = 'BridgeError'
  }
}

export interface BridgeClientOpts {
  baseUrl?: string
  fetchImpl?: typeof fetch
  /**
   * Bearer token for the service's auth gate. Omitted/empty means send
   * unauthenticated — fine while the service runs in report-only mode, a 401
   * once it flips to required. Resolved by the caller (server.ts) so this
   * module stays a pure HTTP client.
   */
  token?: string
}

export class BridgeClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly token: string | undefined

  constructor(opts: BridgeClientOpts = {}) {
    this.baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:9475').replace(/\/+$/, '')
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.token = opts.token?.trim() || undefined
  }

  /**
   * `base` plus the bearer token when one is configured. Returns `base`
   * untouched (including `undefined`) when there's no token, so the tokenless
   * request is byte-identical to the pre-auth behaviour.
   */
  private headers(
    base?: Record<string, string>,
  ): Record<string, string> | undefined {
    if (!this.token) return base
    return { ...base, authorization: `Bearer ${this.token}` }
  }

  /**
   * Long-poll for new messages. The bridge holds the connection open up to
   * `timeoutSeconds` (max 60) and returns immediately when a message arrives.
   *
   * AbortSignal lets the caller cancel during shutdown — the bridge will close
   * the connection and we exit the poll loop cleanly.
   */
  async inbox(
    agent: string,
    since: number,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<InboxResponse> {
    const url = new URL(`${this.baseUrl}/inbox`)
    url.searchParams.set('agent', agent)
    url.searchParams.set('since', String(since))
    url.searchParams.set('timeout', String(timeoutSeconds))
    const res = await this.fetchImpl(url.toString(), {
      headers: this.headers(),
      signal,
    })
    if (!res.ok) {
      const body = await safeText(res)
      throw new BridgeError(
        `inbox returned ${res.status}: ${body}`,
        res.status,
        body,
      )
    }
    return (await res.json()) as InboxResponse
  }

  async send(args: SendArgs): Promise<SendResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/send`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        uuid: args.uuid,
        from_agent: args.from_agent,
        to_agent: args.to_agent,
        kind: args.kind,
        payload: args.payload ?? null,
        reply_to_uuid: args.reply_to_uuid ?? null,
      }),
    })
    if (!res.ok) {
      const body = await safeText(res)
      throw new BridgeError(
        `send returned ${res.status}: ${body}`,
        res.status,
        body,
      )
    }
    return (await res.json()) as SendResponse
  }

  async ack(uuid: string): Promise<{ ok: boolean; updated: boolean }> {
    const res = await this.fetchImpl(`${this.baseUrl}/ack`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ uuid }),
    })
    if (!res.ok) {
      const body = await safeText(res)
      throw new BridgeError(
        `ack returned ${res.status}: ${body}`,
        res.status,
        body,
      )
    }
    return (await res.json()) as { ok: boolean; updated: boolean }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}
