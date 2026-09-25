import type { Api } from 'grammy';
import { chunk, type ChunkMode } from './chunk.js';
import {
  claudeToTelegramV2,
  spanningMarkdownChunks,
} from './markdown-translate.js';
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
  /**
   * Source characters per message, at most 4096 (the default). Escapes may
   * lengthen a MarkdownV2 payload past it; Telegram counts the limit after
   * entity parsing, so that is fine.
   */
  chunkLimit?: number;
  message_thread_id?: number;
  /**
   * First chunk to send, from an earlier `onChunkSent`. Valid only under the
   * same `CHUNK_PLAN_VERSION`. The chunk count (the checkpoint after the last
   * chunk) sends nothing: the text was delivered. Beyond it is an error.
   */
  startChunk?: number;
  /**
   * Called after each confirmed chunk with the index to resume from. If it
   * throws, sendText sends nothing more and rethrows as a PartialSendError
   * that includes the chunk just confirmed.
   */
  onChunkSent?: (nextChunk: number) => void;
}

/**
 * Identifies how `sendText` splits a text into chunks. A saved `startChunk`
 * means the same thing only under the same plan; bump this whenever the same
 * text could split differently. 2: source-first chunking (2026-09-24).
 */
export const CHUNK_PLAN_VERSION = 2;

const MAX_429_RETRIES = 3;

/** Telegram's sendMessage text limit. https://core.telegram.org/bots/api#sendmessage */
const TELEGRAM_TEXT_LIMIT = 4096;

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
        continue; // The plain retry keeps the same 429 handling.
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

/** One message: its exact source slice, and its MarkdownV2 form if formatted. */
interface PlannedChunk {
  source: string;
  markdownV2?: string;
}

/**
 * Chunks on either side of a cut inside a line. Translated alone, a chunk's
 * edge reads as a line start and a word boundary, so `_name_`, `# ` or `>`
 * beside the cut would become Markdown the whole text never had. A cut at a
 * newline keeps line-start semantics.
 */
function midLineCutChunks(chunks: string[]): Set<number> {
  const affected = new Set<number>();
  for (let i = 1; i < chunks.length; i++) {
    if (!chunks[i - 1]!.endsWith('\n') && !chunks[i]!.startsWith('\n')) {
      affected.add(i - 1).add(i);
    }
  }
  return affected;
}

/**
 * The messages `sendText` delivers for `text`. The source is chunked first and
 * each chunk translated on its own, so a parse-error fallback sends exactly
 * the text its failed payload encoded. The plan depends only on its inputs:
 * `startChunk` indexes into it, so a resumed send continues on the same
 * boundaries.
 *
 * No chunk is split again when escaping lengthens its payload past 4096.
 * Telegram counts that limit after entity parsing, and translation adds only
 * escapes and entity markers, never visible characters, so a source chunk
 * within 4096 always fits. A re-split would only add messages.
 * https://core.telegram.org/bots/api#sendmessage
 */
function planChunks(
  text: string,
  format: MarkdownFormat,
  limit: number,
  mode: ChunkMode,
  chat_id: string | number,
): PlannedChunk[] {
  const sources = chunk(text, limit, mode);
  // Independent translation loses context inside a spanning fence, link, or
  // emphasis region, and at a cut inside a line. Send affected chunks
  // plainly, preserving literal code and source markers instead of
  // interpreting fragments as prose Markdown.
  const plain =
    format === 'claude'
      ? new Set([
          ...spanningMarkdownChunks(sources),
          ...midLineCutChunks(sources),
        ])
      : undefined;
  const plan: PlannedChunk[] = [];
  sources.forEach((source, i) => {
    // Telegram rejects whitespace-only text. A cut can leave a trailing
    // newline on its own, even when the reply has content.
    if (!source.trim()) return;
    if (!plain || plain.has(i)) {
      plan.push({ source });
      return;
    }
    try {
      plan.push({ source, markdownV2: claudeToTelegramV2(source) });
    } catch (error) {
      diagLog?.('Telegram translation failed; sending plain text', {
        error: String(error),
        chat_id,
      });
      plan.push({ source });
    }
  });
  return plan;
}

/**
 * Send `text` as one or more Telegram messages. When `format:'claude'`, each
 * source chunk is translated to MarkdownV2 and falls back to that chunk's
 * source (no parse_mode) on a parse-entities error. 429s are retried up to
 * MAX_429_RETRIES times, respecting `retry_after`. `onChunkSent` reports the
 * index to pass as `startChunk` to resume after a failure.
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
  const chunkLimit = Math.min(
    opts.chunkLimit ?? TELEGRAM_TEXT_LIMIT,
    TELEGRAM_TEXT_LIMIT,
  );
  if (!Number.isInteger(chunkLimit) || chunkLimit < 1) {
    throw new Error('chunkLimit must be a positive integer');
  }

  const plan = planChunks(text, format, chunkLimit, chunkMode, chat_id);
  const start = opts.startChunk ?? 0;
  // start === plan.length is the final checkpoint: nothing left to send.
  // Beyond it, the index belongs to some other text or plan; succeeding
  // would let the caller discard what may be an undelivered message.
  if (!Number.isInteger(start) || start < 0 || start > plan.length) {
    throw new Error(
      `invalid startChunk ${start} for a text of ${plan.length} chunk(s)`,
    );
  }
  const threadId = opts.message_thread_id;

  const ids: number[] = [];
  for (let i = start; i < plan.length; i++) {
    const { source, markdownV2 } = plan[i]!;
    const shouldReplyTo =
      opts.reply_to != null &&
      replyToMode !== 'off' &&
      (replyToMode === 'all' || i === 0);
    const extra: Record<string, unknown> = {};
    if (shouldReplyTo) extra.reply_parameters = { message_id: opts.reply_to };
    if (threadId != null) extra.message_thread_id = threadId;

    let id: number;
    try {
      id = await sendOneChunk(
        api,
        chat_id,
        markdownV2 ?? source,
        source,
        markdownV2 === undefined ? undefined : 'MarkdownV2',
        extra,
      );
    } catch (error) {
      throw new PartialSendError([...ids], error);
    }
    ids.push(id);
    try {
      opts.onChunkSent?.(i + 1);
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
