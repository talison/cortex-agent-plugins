import { expect, test } from 'bun:test'
import { claudeToTelegramV2 } from '../core/markdown-translate.ts'

// What Telegram shows for a MarkdownV2 payload's text, ignoring entities:
// outside code, `\x` is the character x and a bare reserved character is a
// parse error; inside code and pre, every ` and \ must be escaped (codeBody).
// Throws where Telegram answers 400 "can't parse entities". Enough of the Bot
// API's rules to catch a lost or doubled backslash, which a lenient unescape
// (send.test.ts's unescapeV2) would hide.
function telegramText(v2: string): string {
  const reserved = new Set('_*[]()~`>#+-=|{}.!')
  let out = ''
  let i = 0
  const closers: string[] = []
  while (i < v2.length) {
    const c = v2[i]!
    if (v2.startsWith('```', i)) {
      const end = v2.indexOf('\n```', i + 3)
      if (end < 0) throw new Error("can't parse entities: unclosed pre")
      const body = v2.slice(v2.indexOf('\n', i) + 1, end)
      out += codeBody(body)
      i = end + 4
      continue
    }
    if (c === '`') {
      const end = findCodeEnd(v2, i + 1)
      out += codeBody(v2.slice(i + 1, end))
      i = end + 1
      continue
    }
    if (c === '\\') {
      if (i + 1 >= v2.length) throw new Error("can't parse entities: trailing backslash")
      out += v2[i + 1]
      i += 2
      continue
    }
    if (c === '*' || c === '_' || c === '~') {
      if (closers.at(-1) === c) closers.pop()
      else closers.push(c)
      i++
      continue
    }
    if (c === '[' || c === ']' || c === '(' || c === ')') {
      i++ // link syntax; the tests below use none, so this only skips it
      continue
    }
    if (reserved.has(c)) throw new Error(`can't parse entities: Character '${c}' is reserved`)
    out += c
    i++
  }
  if (closers.length) throw new Error("can't parse entities: unclosed entity")
  return out
}

function findCodeEnd(s: string, from: number): number {
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue }
    if (s[j] === '`') return j
  }
  throw new Error("can't parse entities: unclosed code")
}

// Inside code and pre the Bot API wants every ` and \ escaped and nothing
// else (the rule scripts/test_md_to_telegramv2.py's validator enforces).
function codeBody(body: string): string {
  let out = ''
  for (let j = 0; j < body.length; j++) {
    const ch = body[j]!
    if (ch === '`') throw new Error("can't parse entities: bare backtick in code")
    if (ch === '\\') {
      const next = body[j + 1]
      if (next !== '\\' && next !== '`') throw new Error("can't parse entities: bare backslash in code")
      out += next
      j++
      continue
    }
    out += ch
  }
  return out
}

// [source, what Tom should read]. In prose a backslash before a reserved
// character is an LLM pre-escape and reads as the character (the next test);
// everywhere else a backslash is text.
const literalBackslashes: Array<[string, string]> = [
  ['a regex like \\d+ and C:\\temp', 'a regex like \\d+ and C:\\temp'],
  ['trailing backslash \\', 'trailing backslash \\'],
  ['inline `grep "foo\\.bar"` here', 'inline grep "foo\\.bar" here'],
  ['inline `C:\\temp\\` ends in one', 'inline C:\\temp\\ ends in one'],
  ['```\nls \\\n  -la\n```', 'ls \\\n  -la'],
  ['```sh\nprintf "a\\tb\\n"\n```', 'printf "a\\tb\\n"'],
  ['a backtick in a fence:\n```\necho `date`\n```', 'a backtick in a fence:\necho `date`'],
]

for (const [source, shown] of literalBackslashes) {
  test(`a literal backslash reaches Telegram: ${JSON.stringify(source)}`, () => {
    // Telegram drops a bare backslash as an escape of what follows, so a
    // translation that leaves it bare shows `d+` for `\d+` (2026-11-16 audit,
    // finding 2). Inline code and fences lose it the same way.
    expect(telegramText(claudeToTelegramV2(source))).toBe(shown)
  })
}

test('an LLM pre-escape in prose is normalised, not doubled into a parse error', () => {
  // `snake\_case` became `snake\\_case`: an escaped backslash, then a bare
  // underscore opening italics that never close, so the whole chunk went out
  // plain. Same rule as scripts/md-to-telegramv2.py (step 1.5).
  for (const [source, shown] of [
    ['snake\\_case and v1\\.2', 'snake_case and v1.2'],
    ['**bold\\!**', 'bold!'],
    ['# Heading \\(draft\\)', 'Heading (draft)'],
  ] as const) {
    expect(telegramText(claudeToTelegramV2(source))).toBe(shown)
  }
})

test('an escaped delimiter stays a literal character, never markup', () => {
  // Normalising `\*` to `*` before syntax recognition turned `\*literal\*`
  // into italics and `\> text` into a blockquote (codex review). They are
  // parked as the MarkdownV2 escapes they already are.
  expect(claudeToTelegramV2('\\*literal\\*')).toBe('\\*literal\\*')
  expect(claudeToTelegramV2('\\> not a quote')).toBe('\\> not a quote')
  expect(claudeToTelegramV2('\\[not\\](a link)')).toBe('\\[not\\]\\(a link\\)')
  expect(claudeToTelegramV2('\\_\\_init\\_\\_')).toBe('\\_\\_init\\_\\_')
  expect(claudeToTelegramV2('[docs](https://x.example/a\\)b)')).toBe('[docs](https://x.example/a\\)b)')
  for (const source of ['\\*literal\\*', '\\> not a quote', '**a \\* b**']) {
    expect(() => telegramText(claudeToTelegramV2(source))).not.toThrow()
  }
})

test('backslash edge cases follow CommonMark (Fable review)', () => {
  const shown = (s: string) => telegramText(claudeToTelegramV2(s))
  // Escaped backticks are literal backticks, never a code span.
  expect(claudeToTelegramV2('\\`x\\`')).toBe('\\`x\\`')
  expect(shown('\\`x\\`')).toBe('`x`')
  // ...while a span may still end in a backslash.
  expect(shown('see `C:\\temp\\` here')).toBe('see C:\\temp\\ here')
  // `\\` is an escaped backslash: one shows, as it did before this branch.
  expect(claudeToTelegramV2('a\\\\b')).toBe('a\\\\b')
  expect(shown('a\\\\b')).toBe('a\\b')
  expect(shown('\\\\.')).toBe('\\.')
  // A backslash before a newline is a hard break: just the newline.
  expect(claudeToTelegramV2('line one\\\nline two')).toBe('line one\nline two')
  expect(shown('two\\\\\nlines')).toBe('two\\\nlines')
  // A pre-escape inside a link URL stays a valid URL escape.
  expect(claudeToTelegramV2('[docs](https://x.example/a\\_b)')).toBe('[docs](https://x.example/a\\_b)')
  expect(claudeToTelegramV2('[docs](https://x.example/a\\.b)')).toBe('[docs](https://x.example/a\\.b)')
})

test('formatting around backslashes still translates', () => {
  expect(claudeToTelegramV2('**C:\\temp**')).toBe('*C:\\\\temp*')
  expect(claudeToTelegramV2('`a\\b`')).toBe('`a\\\\b`')
  expect(claudeToTelegramV2('plain.text')).toBe('plain\\.text')
})
