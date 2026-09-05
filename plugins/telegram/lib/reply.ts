import { InputFile, type Api } from 'grammy'
import { extname } from 'path'
import { PartialSendError, sendText, type SendTextOpts } from '../core/send.js'

const PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])

export async function sendReply(
  api: Pick<Api, 'sendMessage' | 'sendPhoto' | 'sendDocument'>,
  chatId: string,
  text: string,
  files: string[],
  opts: SendTextOpts,
): Promise<number[]> {
  const sentIds: number[] = []
  try {
    if (!text.trim() && files.length === 0) throw new Error('text or at least one file is required')
    // An attachment-only reply must not send an empty Telegram message.
    if (text) sentIds.push(...await sendText(api, chatId, text, opts))
    for (const file of files) {
      const extra = opts.reply_to != null && opts.replyToMode !== 'off'
        ? { reply_parameters: { message_id: opts.reply_to } }
        : undefined
      const input = new InputFile(file)
      const sent = PHOTO_EXTS.has(extname(file).toLowerCase())
        ? await api.sendPhoto(chatId, input, extra)
        : await api.sendDocument(chatId, input, extra)
      sentIds.push(sent.message_id)
    }
    return sentIds
  } catch (error) {
    if (error instanceof PartialSendError) sentIds.push(...error.sentIds)
    const detail = error instanceof Error ? error.message : String(error)
    const delivered = sentIds.length ? ` (ids: ${sentIds.join(', ')}); do not resend these parts` : ''
    throw new Error(`reply failed after ${sentIds.length} part(s) sent${delivered}: ${detail}`, { cause: error })
  }
}
