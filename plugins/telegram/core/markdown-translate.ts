// SOURCE: harness@9b67e8012e531063cdfabebe57f62b661ba154aa src/telegram-core/markdown-translate.ts (synced 2026-04-24)
// Backslash handling is the fork's own (2026-11-16 audit, finding 2, and its
// reviews). It follows CommonMark where cortex's scripts/md-to-telegramv2.py
// does not: there, `\\` shows two backslashes and `\*x\*` becomes italics.
/**
 * Telegram MarkdownV2 reserves these characters: _ * [ ] ( ) ~ ` > # + - = | { } . !
 * Every literal occurrence must be backslash-escaped, and so must a literal
 * backslash: MarkdownV2 reads a bare `\` as an escape of whatever follows, so
 * `\d+` showed as `d+`.
 */
const V2_RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g;

/**
 * In prose, outside code, one of:
 *  1. a backslash escape: a backslash before any ASCII punctuation, as
 *     CommonMark has it (`snake\_case`, `v1\.2`, `\*not italic\*`, `\\`,
 *     `\$5`, `\<tag\>`; MarkdownV2 accepts an escape of any character 1-126,
 *     and a reserved-only set left `\$5` showing its backslash). Escaping it
 *     again gave `\\_`, an escaped backslash and a bare `_`, which Telegram
 *     rejected, so the chunk went out plain. It is already valid MarkdownV2
 *     for the literal character, so it is parked as-is before any syntax is
 *     recognised: it never becomes a delimiter, and `\\` shows one backslash,
 *     as CommonMark (and this translator before 2026-11-16) has it;
 *  2. a backslash before a newline, CommonMark's hard break: just the newline;
 *  3. an inline code span.
 * Any other backslash (`\d`, `C:\temp`, a trailing one) is a literal and is
 * escaped by the passes below.
 */
const PROSE_TOKEN_RE = /\\([!-\/:-@\[-`{-~])|\\\n|`([^`\n]+)`/g;

/** Matches only the `)` and `\` characters — the v2 rule for link URL escaping. */
const V2_URL_ESCAPE = /[\\)]/g;

/** Inside code and pre, every ` and \ is escaped, and nothing else. */
function escapeCode(body: string): string {
  return body.replace(/[\\`]/g, '\\$&');
}

type PlaceholderEntry = { key: string; content: string };

// Share the recognized regions with the chunk-boundary check. Raw underscores
// in identifiers and list bullets are not emphasis in this translator.
const FENCE_RE = /```[^\n]*\n[\s\S]*?\n```/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const LINK_RE = /\[([^\]\n]+)\]\(([^)\n]+)\)/g;
const HEADING_RE = /^(#{1,6})\s+(.+)$/gm;
const DOUBLE_STRIKE_RE = /~~([^~\n]+?)~~/g;
const SINGLE_STRIKE_RE = /(?<!\w)~(?=\S)([^~\n]+?)(?<=\S)~(?!\w)/g;
const BOLD_RE = /\*\*([^\n]+?)\*\*/g;
const ITALIC_STAR_RE = /(?<!\w)\*(?=\S)([^*\n]+?)(?<=\S)\*(?!\w)/g;
const ITALIC_UNDER_RE = /(?<!\w)_([^_\n]+?)_(?!\w)/g;

/** Chunks intersecting a recognized Markdown region split by a boundary. */
export function spanningMarkdownChunks(chunks: string[]): Set<number> {
  const affected = new Set<number>();
  if (chunks.length < 2) return affected;
  let offset = 0;
  const ends = chunks.map(part => (offset += part.length));
  let residue = chunks.join('');
  for (const pattern of [FENCE_RE, INLINE_CODE_RE, LINK_RE, HEADING_RE,
    DOUBLE_STRIKE_RE, SINGLE_STRIKE_RE, BOLD_RE, ITALIC_STAR_RE, ITALIC_UNDER_RE]) {
    residue = residue.replace(pattern, (...args: unknown[]) => {
      const matched = args[0] as string;
      const start = args[args.length - 2] as number;
      const first = ends.findIndex(end => end > start);
      const last = ends.findIndex(end => end >= start + matched.length);
      if (first < last) {
        for (let i = first; i <= last; i++) affected.add(i);
      }
      // Shield contents using non-space, non-word placeholders, just like the
      // translator, so emphasis around inline code still matches. Retain
      // offsets and line boundaries for the original source chunks.
      return matched.replace(/[^\n]/g, '\u0000');
    });
  }
  return affected;
}

/**
 * Convert Claude-native Markdown (standard CommonMark-ish syntax) to Telegram
 * MarkdownV2 with correct escaping.
 *
 * Four ordered passes:
 *   1. Extract preserve-verbatim regions (fenced code, inline code, links,
 *      blockquote markers) into placeholder tokens. This shields them from the
 *      transform/escape passes.
 *   2. Transform Markdown constructs (headings, strikethrough, bold, italic)
 *      into their v2 equivalents and park them as placeholders too.
 *   3. Escape remaining reserved chars in the plain-text residue.
 *   4. Restore placeholders in reverse order so tokens produced by later
 *      passes (which may mention tokens from earlier passes) resolve fully.
 *
 * Placeholder keys use U+0000 delimiters — outside normal text and outside the
 * V2 reserved set, so the escape regex leaves them untouched.
 */
export function claudeToTelegramV2(text: string): string {
  // Defensive: strip any pre-existing null bytes before using \u0000 as our
  // placeholder delimiter. Telegram rejects C0 control chars anyway, so this
  // is lossless in practice but guards against a future caller that doesn't.
  // eslint-disable-next-line no-control-regex
  text = text.replace(/\u0000/g, '');

  const placeholders: PlaceholderEntry[] = [];
  const makePh = (content: string): string => {
    const key = `\u0000MD${placeholders.length}\u0000`;
    placeholders.push({ key, content });
    return key;
  };

  // ---- Pass 1: extract preserve-verbatim regions --------------------------

  // 1a. Fenced code blocks (must precede inline-code extraction so the
  //     fence's own backticks aren't picked up as inline code).
  //     The fence lines are structure; the body between them is code.
  text = text.replace(FENCE_RE, (m) => {
    const open = m.indexOf('\n') + 1;
    const close = m.lastIndexOf('\n```');
    return makePh(m.slice(0, open) + escapeCode(m.slice(open, close)) + m.slice(close));
  });

  // 1b. Inline code, backslash escapes and hard breaks, in one left-to-right
  //     pass so CommonMark's precedence holds: an escaped backtick never opens
  //     a code span (`\`x\`` is literal backticks), and inside a span a
  //     backslash is just text (`C:\temp\` closes on its backtick).
  text = text.replace(PROSE_TOKEN_RE, (m, escaped: string | undefined, code: string | undefined) => {
    if (escaped !== undefined) return makePh(m);      // already the V2 escape
    if (code === undefined) return '\n';              // `\` + newline: a hard break
    return makePh('`' + escapeCode(code) + '`');
  });

  // 1c. Links [text](url). Per v2 spec: link text escapes the full reserved
  //     set; URL escapes only `)` and `\`.
  text = text.replace(LINK_RE, (_m, linkText, url) => {
    const escText = linkText.replace(V2_RESERVED, '\\$&');
    const escUrl = url.replace(V2_URL_ESCAPE, '\\$&');
    return makePh(`[${escText}](${escUrl})`);
  });

  // 1d. Blockquote markers at line start — placeholder covers the `>` (and its
  //     optional trailing space), leaving the content to flow through normal
  //     escaping. V2 blockquote syntax has no space after `>`.
  text = text.replace(/^>\s?/gm, () => makePh('>'));

  // ---- Pass 2: transform Markdown constructs ------------------------------

  // 2a. Headings — line-anchored, multiline. Inner text still needs escaping.
  text = text.replace(HEADING_RE, (_m, _hashes, inner) => {
    const escInner = inner.replace(V2_RESERVED, '\\$&');
    return makePh(`*${escInner}*`);
  });

  // 2b. Strikethrough (double tilde) — before single-tilde strike (~~ contains ~).
  text = text.replace(DOUBLE_STRIKE_RE, (_m, inner) => {
    const escInner = inner.replace(V2_RESERVED, '\\$&');
    return makePh(`~${escInner}~`);
  });

  // 2c. Single-tilde strikethrough. Word-boundary lookarounds avoid matching
  //     `~tilde_in~word`, and the (?=\S)/(?<=\S) guards avoid `~ spaced ~`.
  text = text.replace(
    SINGLE_STRIKE_RE,
    (_m, inner) => {
      const escInner = inner.replace(V2_RESERVED, '\\$&');
      return makePh(`~${escInner}~`);
    },
  );

  // 2d. Bold (double asterisk) — accepts single `*` chars inside so a bold
  //     phrase containing `*italic*` still matches the outer bold. Inner italics
  //     are transformed recursively before reserved-char escaping.
  text = text.replace(BOLD_RE, (_m, inner: string) => {
    // Transform nested italics first so they survive the outer escape.
    let transformed = inner
      .replace(ITALIC_STAR_RE, (_m2: string, it: string) => {
        const esc = it.replace(V2_RESERVED, '\\$&');
        return makePh(`_${esc}_`);
      })
      .replace(ITALIC_UNDER_RE, (_m2: string, it: string) => {
        const esc = it.replace(V2_RESERVED, '\\$&');
        return makePh(`_${esc}_`);
      });
    const escOuter = transformed.replace(V2_RESERVED, '\\$&');
    return makePh(`*${escOuter}*`);
  });

  // 2e. Italic via single asterisk (outside bold) — CommonMark's emphasis.
  //     Guards: non-word preceding/following to avoid `snake_case*foo*`;
  //     (?=\S)/(?<=\S) to avoid `* item` bullets or `5 * 3 * 2`.
  text = text.replace(ITALIC_STAR_RE, (_m, inner) => {
    const escInner = inner.replace(V2_RESERVED, '\\$&');
    return makePh(`_${escInner}_`);
  });

  // 2f. Italic via underscore — _text_ with word-boundary lookarounds so
  //     snake_case_identifiers don't get matched accidentally.
  text = text.replace(ITALIC_UNDER_RE, (_m, inner) => {
    const escInner = inner.replace(V2_RESERVED, '\\$&');
    return makePh(`_${escInner}_`);
  });

  // ---- Pass 3: escape remaining reserved chars ----------------------------
  text = text.replace(V2_RESERVED, '\\$&');

  // ---- Pass 4: restore placeholders --------------------------------------
  // Iterate in reverse so the outer transform's content (which may still
  // reference placeholders produced by pass 1) gets its own restoration step.
  // Use the function form of replace — the string form would interpret
  // `$&`/`$1` etc. in placeholder content as regex-match references, which
  // would corrupt user text containing those sequences.
  for (let i = placeholders.length - 1; i >= 0; i--) {
    const { key, content } = placeholders[i];
    text = text.replace(key, () => content);
  }
  return text;
}
