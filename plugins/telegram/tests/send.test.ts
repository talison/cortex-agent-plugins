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
