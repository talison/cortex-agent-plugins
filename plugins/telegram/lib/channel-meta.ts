import type { Context } from 'grammy'

export type AttachmentMeta = {
  kind: string
  file_id: string
  size?: number
  mime?: string
  name?: string
}

export function buildChannelMeta(
  ctx: Pick<Context, 'chat' | 'from' | 'message'>,
  imagePath?: string,
  attachment?: AttachmentMeta,
): Record<string, string> {
  const from = ctx.from!
  const message = ctx.message
  const meta: Record<string, string> = {
    chat_id: String(ctx.chat!.id),
    user: from.username ?? String(from.id),
    user_id: String(from.id),
    ts: new Date((message?.date ?? 0) * 1000).toISOString(),
  }
  if (message?.message_id != null) meta.message_id = String(message.message_id)
  const reply = message?.reply_to_message
  if (reply?.message_id != null) meta.reply_to_message_id = String(reply.message_id)
  const replyText = reply?.text ?? reply?.caption
  if (replyText != null) meta.reply_to_message_text = replyText
  if (imagePath) meta.image_path = imagePath
  if (attachment) {
    meta.attachment_kind = attachment.kind
    meta.attachment_file_id = attachment.file_id
    if (attachment.size != null) meta.attachment_size = String(attachment.size)
    if (attachment.mime) meta.attachment_mime = attachment.mime
    if (attachment.name) meta.attachment_name = attachment.name
  }
  return meta
}
