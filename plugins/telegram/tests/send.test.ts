import { expect, test } from 'bun:test'
import { PartialSendError, sendText } from '../core/send.ts'
import { chunk } from '../core/chunk.ts'
import { sendReply } from '../lib/reply.ts'

function fakeAPI(sendMessage: (...args: any[]) => Promise<any>) {
  return { sendMessage, sendPhoto: async () => ({ message_id: 10 }), sendDocument: async () => ({ message_id: 11 }) } as any
}

test('long bold regions preserve every source span across chunks', async () => {
  const source = '.'.repeat(2048) + '**' + 'B'.repeat(5000) + '**TAIL'
  const delivered: string[] = []
  const api = fakeAPI(async (_chat, text, opts) => {
    const unbalanced = (text.match(/(?<!\\)\*/g)?.length ?? 0) % 2 !== 0
    if (opts.parse_mode && unbalanced) throw new Error("can't parse entities")
    expect(text.length).toBeLessThanOrEqual(4096)
    delivered.push(opts.parse_mode ? text.replace(/\\(.)/g, '$1') : text)
    return { message_id: delivered.length }
  })
  await sendText(api, '1', source, { format: 'claude', chunkMode: 'length' })
  expect(delivered.join('')).toBe(source)
})

test('translated text and its plain retry represent the same chunk', async () => {
  const attempts: Array<{ text: string; opts: any }> = []
  await sendText(fakeAPI(async (_chat, text, opts) => {
    attempts.push({ text, opts })
    if (opts.parse_mode) throw new Error("can't parse entities")
    return { message_id: 1 }
  }), '1', '**hello**', { format: 'claude' })
  expect(attempts.map(a => a.text)).toEqual(['*hello*', '**hello**'])
  expect(attempts[1].opts.parse_mode).toBeUndefined()
})

test('plain fallback still retries rate limits', async () => {
  let calls = 0
  const ids = await sendText(fakeAPI(async () => {
    calls++
    if (calls === 1) throw new Error("can't parse entities")
    if (calls === 2) throw Object.assign(new Error('rate limited'), { parameters: { retry_after: 0 } })
    return { message_id: 42 }
  }), '1', '**hello**', { format: 'claude' })
  expect(ids).toEqual([42])
  expect(calls).toBe(3)
})

test('chunk boundaries preserve code indentation and paragraph whitespace', () => {
  const source = 'abcd\n    indented\n\nnext'
  for (const mode of ['length', 'newline'] as const) {
    expect(chunk(source, 5, mode).join('')).toBe(source)
  }
})

test('threading follows the source chunks in first/all/off modes', async () => {
  for (const replyToMode of ['first', 'all', 'off'] as const) {
    const threaded: Array<number | undefined> = []
    await sendText(fakeAPI(async (_chat, _text, opts) => {
      threaded.push(opts.reply_parameters?.message_id)
      expect(opts.message_thread_id).toBe(7)
      return { message_id: threaded.length }
    }), '1', 'a'.repeat(5000), { reply_to: 99, replyToMode, message_thread_id: 7 })
    expect(threaded).toEqual(replyToMode === 'all' ? [99, 99] : replyToMode === 'first' ? [99, undefined] : [undefined, undefined])
  }
})

test('partial text failure preserves the IDs of confirmed sends', async () => {
  let sent = 0
  try {
    await sendText(fakeAPI(async () => {
      if (sent++) throw new Error('connection reset')
      return { message_id: 42 }
    }), '1', 'a'.repeat(5000))
    throw new Error('expected send failure')
  } catch (error) {
    expect(error).toBeInstanceOf(PartialSendError)
    expect((error as PartialSendError).sentIds).toEqual([42])
  }
})

test('reply reports partial text delivery instead of zero', async () => {
  let calls = 0
  await expect(sendReply(fakeAPI(async () => {
    if (calls++) throw new Error('connection reset')
    return { message_id: 42 }
  }), '1', 'a'.repeat(5000), [], {})).rejects.toThrow('1 part(s) sent (ids: 42); do not resend these parts')
})

test('attachment failure reports preceding text and files', async () => {
  const api = fakeAPI(async () => ({ message_id: 42 }))
  let calls = 0
  api.sendDocument = async () => {
    if (calls++) throw new Error('upload failed')
    return { message_id: 43 }
  }
  await expect(sendReply(api, '1', 'hello', ['/tmp/a.txt', '/tmp/b.txt'], {}))
    .rejects.toThrow('2 part(s) sent (ids: 42, 43)')
})

test('attachment-only reply skips an empty sendMessage', async () => {
  const ids = await sendReply(fakeAPI(async () => { throw new Error('must not send empty text') }), '1', '', ['/tmp/a.txt'], {})
  expect(ids).toEqual([11])
})

test('a trailing newline across the limit does not become an empty send', async () => {
  const texts: string[] = []
  await sendText(fakeAPI(async (_chat, text) => {
    expect(text.trim()).not.toBe('')
    texts.push(text)
    return { message_id: texts.length }
  }), '1', 'a'.repeat(4096) + '\n')
  expect(texts).toHaveLength(1)
})

test('custom source limits retain Markdown when escaping fits Telegram', async () => {
  const calls: any[] = []
  await sendText(fakeAPI(async (_chat, text, opts) => {
    calls.push({ text, opts })
    return { message_id: calls.length }
  }), '1', 'a'.repeat(90) + '.'.repeat(10), { format: 'claude', chunkLimit: 100 })
  expect(calls[0].text.length).toBe(110)
  expect(calls[0].opts.parse_mode).toBe('MarkdownV2')
})

test('code spanning chunks retains literal Markdown characters', async () => {
  const source = '```\n' + 'a'.repeat(4092) + '*literal*\n```'
  const texts: string[] = []
  await sendText(fakeAPI(async (_chat, text, opts) => {
    expect(opts.parse_mode).toBeUndefined()
    texts.push(text)
    return { message_id: texts.length }
  }), '1', source, { format: 'claude', chunkMode: 'length' })
  expect(texts.join('')).toBe(source)
})

test('paragraph boundaries preserve heading translation', async () => {
  const calls: any[] = []
  await sendText(fakeAPI(async (_chat, text, opts) => {
    calls.push({ text, opts })
    return { message_id: calls.length }
  }), '1', 'a'.repeat(95) + '\n\n## Title\n- x', { format: 'claude', chunkLimit: 100, chunkMode: 'newline' })
  expect(calls).toHaveLength(2)
  expect(calls[1].opts.parse_mode).toBe('MarkdownV2')
  expect(calls[1].text).toContain('*Title*')
})

test('identifiers and list bullets do not disable formatting in long replies', async () => {
  const calls: any[] = []
  await sendText(fakeAPI(async (_chat, text, opts) => {
    calls.push({ text, opts })
    return { message_id: calls.length }
  }), '1', 'a'.repeat(5000) + ' file_id **bold**\n* list item', { format: 'claude', chunkMode: 'length' })
  expect(calls).toHaveLength(2)
  expect(calls[1].opts.parse_mode).toBe('MarkdownV2')
  expect(calls[1].text).toContain('*bold*')
  expect(calls[1].text).toContain('file\\_id')
})

test('nested emphasis around inline code is recognized across a boundary', async () => {
  const source = 'a'.repeat(8) + ' *`code`*'
  const texts: string[] = []
  await sendText(fakeAPI(async (_chat, text, opts) => {
    expect(opts.parse_mode).toBeUndefined()
    texts.push(text)
    return { message_id: texts.length }
  }), '1', source, { format: 'claude', chunkLimit: 10, chunkMode: 'length' })
  expect(texts.join('')).toBe(source)
})

test('a formatted chunk can fall back while its neighbour stays formatted', async () => {
  const source = 'A.'.repeat(45) + '\n\nSecond paragraph.'
  const delivered: string[] = []
  const formats: boolean[] = []
  await sendText(fakeAPI(async (_chat, text, opts) => {
    formats.push(!!opts.parse_mode)
    if (opts.parse_mode && text.startsWith('A')) throw new Error("can't parse entities")
    delivered.push(opts.parse_mode ? text.replace(/\\(.)/g, '$1') : text)
    return { message_id: delivered.length }
  }), '1', source, { format: 'claude', chunkLimit: 100, chunkMode: 'newline' })
  expect(formats).toEqual([true, false, true])
  expect(delivered.join('')).toBe(source)
})

test('4096 source characters retain formatting even when escapes expand the payload', async () => {
  const calls: any[] = []
  await sendText(fakeAPI(async (_chat, text, opts) => {
    calls.push({ text, opts })
    return { message_id: calls.length }
  }), '1', 'a'.repeat(4095) + '.', { format: 'claude' })
  expect(calls[0].text.length).toBe(4097)
  expect(calls[0].opts.parse_mode).toBe('MarkdownV2')
})

test('only chunks intersecting a spanning code block become plain', async () => {
  const calls: any[] = []
  const source = 'a'.repeat(100) + '```\n' + 'x'.repeat(190) + '\n```\n\n**bold**'
  await sendText(fakeAPI(async (_chat, text, opts) => {
    calls.push({ text, opts })
    return { message_id: calls.length }
  }), '1', source, { format: 'claude', chunkLimit: 100, chunkMode: 'length' })
  expect(calls.map(c => !!c.opts.parse_mode)).toEqual([true, false, false, true])
  expect(calls[3].text).toBe('*bold*')
})

// --- Source/translation pairing (audit M19) ---------------------------------
// Harness's copy chunked the escaped text and the raw text separately, so a
// parse-error fallback could send a mismatched piece. These pin the pairing
// in both copies: every payload has an exact source counterpart.

type Call = { text: string; opts: { parse_mode?: string } }

const PARSE_ERROR = "Bad Request: can't parse entities: unexpected end"

/** Undo the translator's escaping. Exact for text with no Markdown constructs. */
const unescapeV2 = (text: string) => text.replace(/\\([\s\S])/g, '$1')

/** What the reader sees: the escaped payload's text, or the plain payload. */
const visible = (call: Call) => (call.opts.parse_mode ? unescapeV2(call.text) : call.text)

/** Fake Bot API recording every attempt; `fail` may throw for any attempt. */
function recordingApi(fail?: (call: Call) => Error | undefined) {
  const attempts: Call[] = []
  const delivered: Call[] = []
  const api = fakeAPI(async (_chat, text: string, opts: Call['opts']) => {
    const call = { text, opts }
    attempts.push(call)
    const error = fail?.(call)
    if (error) throw error
    delivered.push(call)
    return { message_id: 1000 + delivered.length }
  })
  return { api, attempts, delivered }
}

/** Fail only the first MarkdownV2 attempt with a parse error. */
function failFirstFormatted() {
  let failed = false
  return (call: Call) => {
    if (!call.opts.parse_mode || failed) return undefined
    failed = true
    return new Error(PARSE_ERROR)
  }
}

/**
 * ~7k characters dense with MarkdownV2-reserved characters but no Markdown
 * constructs. Escaped-then-chunked it splits [4076, 3988, 131] against
 * [4093, 2988] for the source: the shape audit M19 found.
 */
function longReply(): string {
  const paras: string[] = []
  for (let i = 1; paras.join('\n\n').length < 7000; i++) {
    paras.push(`Step ${i}. Check the (cached) value = ${i}.5 - see item #${i}!\n`
      + `Keep a|b, {x} and +1 in mind (v${i}.0.1); it costs $${i}.00.`)
  }
  return paras.join('\n\n')
}

/** 3,489 source characters (one chunk) that escape to 4,889. */
const escapeHeavyBlock = () => Array.from({ length: 200 }, (_, i) => `${i}. a.b.c-d!e(f)`).join('\n')

test('a parse error on the first chunk falls back to exactly that chunk', async () => {
  const text = longReply()
  const { api, attempts, delivered } = recordingApi(failFirstFormatted())
  await sendText(api, '1', text, { format: 'claude', chunkMode: 'newline' })
  expect(attempts[0].opts.parse_mode).toBe('MarkdownV2')
  expect(attempts[1].opts.parse_mode).toBeUndefined()
  expect(attempts[1].text).toBe(unescapeV2(attempts[0].text))
  expect(delivered.length).toBeGreaterThan(1)
  expect(delivered.map(visible).join('')).toBe(text)
  // Telegram's limit applies to the parsed text, not the escaped payload.
  for (const call of attempts) expect(visible(call).length).toBeLessThanOrEqual(4096)
})

test('a parse error on the last chunk falls back to exactly that chunk', async () => {
  const text = longReply()
  const tail = text.slice(-40)
  const isLast = (call: Call) => !!call.opts.parse_mode && unescapeV2(call.text).endsWith(tail)
  const { api, attempts, delivered } = recordingApi(call => (isLast(call) ? new Error(PARSE_ERROR) : undefined))
  await sendText(api, '1', text, { format: 'claude', chunkMode: 'newline' })
  const failedAt = attempts.findIndex(isLast)
  expect(failedAt).toBe(attempts.length - 2)
  const fallback = attempts[failedAt + 1]
  expect(fallback.opts.parse_mode).toBeUndefined()
  expect(fallback.text).toBe(unescapeV2(attempts[failedAt].text))
  expect(fallback.text).not.toContain('\\')
  expect(delivered.map(visible).join('')).toBe(text)
})

test('a chunk whose escapes pass 4096 goes out whole, paired with its source', async () => {
  const text = escapeHeavyBlock()
  const { api, attempts, delivered } = recordingApi(failFirstFormatted())
  await sendText(api, '1', text, { format: 'claude', chunkMode: 'newline' })
  expect(attempts).toHaveLength(2)
  expect(attempts[0].text.length).toBeGreaterThan(4096)
  expect(attempts[0].opts.parse_mode).toBe('MarkdownV2')
  expect(unescapeV2(attempts[0].text)).toBe(text)
  expect(delivered).toHaveLength(1)
  expect(delivered[0].opts.parse_mode).toBeUndefined()
  expect(delivered[0].text).toBe(text)
})

test('resuming from startChunk continues on the same chunk boundaries', async () => {
  const text = `${longReply()}\n\n${escapeHeavyBlock()}\n\nDone.`
  const opts = { format: 'claude', chunkMode: 'newline' } as const
  const full = recordingApi()
  await sendText(full.api, '1', text, opts)
  const boundaries = full.delivered.map(visible)
  expect(boundaries.join('')).toBe(text)
  expect(boundaries.length).toBeGreaterThanOrEqual(3)

  // First attempt: the connection drops on the third chunk.
  let nextChunk = 0
  const first = recordingApi(() => (first.attempts.length === 3 ? new Error('socket hang up') : undefined))
  const failure = await sendText(first.api, '1', text, { ...opts, onChunkSent: next => { nextChunk = next } })
    .catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(PartialSendError)
  expect((failure as PartialSendError).sentIds).toEqual([1001, 1002])
  expect(nextChunk).toBe(2)

  // The retry resumes at chunk 2, and that chunk hits a parse error.
  const retry = recordingApi(failFirstFormatted())
  await sendText(retry.api, '1', text, { ...opts, startChunk: nextChunk })
  expect(retry.attempts[1].text).toBe(unescapeV2(retry.attempts[0].text))
  expect([...first.delivered, ...retry.delivered].map(visible)).toEqual(boundaries)
})
