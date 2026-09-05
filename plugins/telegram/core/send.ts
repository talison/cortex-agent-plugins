import type { Api } from 'grammy';
import { chunk, type ChunkMode } from './chunk.js';
import { claudeToTelegramV2, spanningMarkdownChunks } from './markdown-translate.js';
import { isParseEntitiesError } from './markdown.js';

// Optional diagnostic logger — set by the host at boot. When present, we log
// parse-entities fallback events, 429 retries, and final non-recoverable send
// failures. Keeping this in telegram-core (not depending on host logger)
// preserves the core's no-host-imports rule.
let diagLog: ((msg: string, ctx: Record<string, unknown>) => void) | undefined;
export function setSendDiagnosticLogger(
  fn: (msg: string, ctx: Record<string, unknown>) => void,
): void {
  diagLog = fn;
}

export type MarkdownFormat = 'text' | 'claude';

export interface SendTextOpts {
  format?: MarkdownFormat;
  reply_to?: number;
  replyToMode?: 'off' | 'first' | 'all';
  chunkMode?: ChunkMode;
  chunkLimit?: number;
  message_thread_id?: number;
}

const MAX_429_RETRIES = 3;

export class PartialSendError extends Error {
  constructor(public readonly sentIds: number[], cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'PartialSendError';
  }
}

async function sendOneChunk(
  api: Pick<Api, 'sendMessage'>,
  chat_id: string | number,
  preparedText: string,
  originalText: string,
  parseMode: 'MarkdownV2' | undefined,
  extra: Record<string, unknown>,
): Promise<number> {
  let attempt = 0;
  while (true) {
    try {
      const opts = parseMode
        ? { ...extra, parse_mode: parseMode }
        : { ...extra };
      const res: any = await api.sendMessage(chat_id, preparedText, opts);
      return res.message_id;
    } catch (err) {
      if (isParseEntitiesError(err) && parseMode) {
        diagLog?.('Telegram parse_mode fallback triggered', {
          error: (err as Error).message,
          preparedPreview: preparedText.slice(0, 300),
          originalPreview: originalText.slice(0, 300),
        });
        preparedText = originalText;
        parseMode = undefined;
        continue; // Plain retries must retain the same 429 handling.
      }
      const retryAfter = (err as any)?.parameters?.retry_after;
      if (retryAfter != null && attempt < MAX_429_RETRIES) {
        attempt++;
        diagLog?.('Telegram 429 retry', {
          attempt,
          retry_after: retryAfter,
          chat_id,
        });
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      diagLog?.('Telegram send failed', {
        error: (err as Error).message,
        error_code: (err as any)?.error_code,
        description: (err as any)?.description,
        parameters: (err as any)?.parameters,
        chat_id,
        attempts: attempt + 1,
      });
      throw err;
    }
  }
}

/**
 * Send `text` as one or more Telegram messages. When `format:'claude'`, the
 * text is translated to MarkdownV2 before sending and falls back to the
 * original (no parse_mode) on a parse-entities error. 429s are retried up to
 * MAX_429_RETRIES times, respecting `retry_after`.
 */
export async function sendText(
  api: Pick<Api, 'sendMessage'>,
  chat_id: string | number,
  text: string,
  opts: SendTextOpts = {},
): Promise<number[]> {
  const format = opts.format ?? 'text';
  const replyToMode = opts.replyToMode ?? 'first';
  const chunkMode = opts.chunkMode ?? 'newline';
  const chunkLimit = Math.min(opts.chunkLimit ?? 4096, 4096);
  if (!Number.isInteger(chunkLimit) || chunkLimit < 1) {
    throw new Error('chunkLimit must be a positive integer');
  }

  const originalChunks = chunk(text, chunkLimit, chunkMode);
  // Independent translation loses context inside a spanning fence, link, or
  // emphasis region. Send affected chunks plainly, preserving literal code and
  // source markers instead of interpreting code fragments as prose Markdown.
  const plainChunks = format === 'claude' ? spanningMarkdownChunks(originalChunks) : new Set<number>();
  const threadId = opts.message_thread_id;

  const ids: number[] = [];
  for (let i = 0; i < originalChunks.length; i++) {
    const original = originalChunks[i]!;
    // Telegram rejects messages containing only whitespace. This can be a
    // trailing newline just past a boundary, even when the reply has content.
    if (!original.trim()) continue;
    let prepared = original;
    let parseMode: 'MarkdownV2' | undefined;
    if (format === 'claude' && !plainChunks.has(i)) {
      try {
        // Telegram's 4096 limit applies after entity parsing, not to the
        // escaped payload. Source chunks already fit that bound, and this
        // translator never adds visible characters.
        // https://core.telegram.org/bots/api#sendmessage
        prepared = claudeToTelegramV2(original);
        parseMode = 'MarkdownV2';
      } catch (error) {
        diagLog?.('Telegram translation failed; sending plain text', {
          error: String(error), chat_id,
        });
      }
    }
    const shouldReplyTo =
      opts.reply_to != null &&
      replyToMode !== 'off' &&
      (replyToMode === 'all' || ids.length === 0);
    const extra: Record<string, unknown> = {};
    if (shouldReplyTo) extra.reply_parameters = { message_id: opts.reply_to };
    if (threadId != null) extra.message_thread_id = threadId;

    try {
      const id = await sendOneChunk(api, chat_id, prepared, original, parseMode, extra);
      ids.push(id);
    } catch (error) {
      throw new PartialSendError([...ids], error);
    }
  }
  return ids;
}

/**
 * Edit an existing Telegram message. No chunking — truncates to `chunkLimit`.
 * On parse-entities failure (claude format), retries with the original text
 * and no parse_mode.
 */
export async function editText(
  api: Pick<Api, 'editMessageText'>,
  chat_id: string | number,
  message_id: number,
  text: string,
  opts: Pick<SendTextOpts, 'format' | 'chunkLimit'> = {},
): Promise<void> {
  const format = opts.format ?? 'text';
  const chunkLimit = opts.chunkLimit ?? 4096;
  // Truncate the SOURCE first, then translate — truncating v2 post-translation
  // can split an escape sequence and yield unparseable markup.
  // Note: escaping can inflate translated length by up to ~15% on dense
  // reserved-char content. For 4096-limit edits we may end up a few bytes
  // over. Rare in practice for typical Claude output; fallback handles it.
  const truncatedOriginal =
    text.length > chunkLimit ? text.slice(0, chunkLimit) : text;
  const truncatedPrepared =
    format === 'claude'
      ? claudeToTelegramV2(truncatedOriginal)
      : truncatedOriginal;
  const parseMode: 'MarkdownV2' | undefined =
    format === 'claude' ? 'MarkdownV2' : undefined;
  // editText does not retry on 429. Edit targets are often transient (the
  // message is about to be replaced by a follow-up anyway), so burning
  // retry budget on them isn't worth it. sendText has retries where they
  // matter.
  try {
    const opts2 = parseMode ? { parse_mode: parseMode } : {};
    await api.editMessageText(chat_id, message_id, truncatedPrepared, opts2);
  } catch (err) {
    if (isParseEntitiesError(err) && parseMode) {
      await api.editMessageText(chat_id, message_id, truncatedOriginal, {});
      return;
    }
    throw err;
  }
}
