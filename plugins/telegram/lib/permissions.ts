type Access = { dmPolicy: string; allowFrom: string[] }
type Sender = { from?: { id: number }; chat?: { type: string } }
export type PermissionDetails = {
  tool_name: string
  description: string
  input_preview: string
}

// Group access permits conversation, never approval of local tool execution.
export function canReplyToPermission(access: Access, ctx: Sender): boolean {
  return access.dmPolicy !== 'disabled' && ctx.chat?.type === 'private' &&
    ctx.from != null && access.allowFrom.includes(String(ctx.from.id))
}

export class PermissionRequests {
  private pending = new Map<string, PermissionDetails>()
  private resolving = new Set<string>()
  // Absorb recent duplicates without confusing ordinary "yes maybe" messages
  // with an approval. Bound the history so it cannot grow for the process lifetime.
  private completed = new Set<string>()

  isKnown(id: string): boolean {
    return this.pending.has(id) || this.completed.has(id)
  }

  set(id: string, details: PermissionDetails): void {
    this.completed.delete(id)
    this.pending.set(id, details)
  }

  get(id: string): PermissionDetails | undefined {
    return this.resolving.has(id) ? undefined : this.pending.get(id)
  }

  async reply(
    id: string,
    behavior: 'allow' | 'deny',
    access: Access,
    ctx: Sender,
    notify: (params: { request_id: string; behavior: 'allow' | 'deny' }) => Promise<void>,
  ): Promise<boolean> {
    if (!canReplyToPermission(access, ctx)) return false
    const details = this.get(id)
    if (!details) return false
    // Reserve before awaiting transport IO so buttons and text cannot race.
    this.resolving.add(id)
    try {
      await notify({ request_id: id, behavior })
      if (this.pending.get(id) === details) {
        this.pending.delete(id)
        this.completed.add(id)
        if (this.completed.size > 100) this.completed.delete(this.completed.values().next().value!)
      }
      return true
    } finally {
      // A failed notification remains pending and can be retried.
      this.resolving.delete(id)
    }
  }
}
