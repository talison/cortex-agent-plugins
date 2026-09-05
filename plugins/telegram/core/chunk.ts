// SOURCE: harness@9b67e8012e531063cdfabebe57f62b661ba154aa src/telegram-core/chunk.ts (synced 2026-04-24)
export type ChunkMode = 'length' | 'newline';

/**
 * Split `text` into chunks of ≤ `limit` chars. In `'length'` mode, hard-cut
 * at the limit. In `'newline'` mode, prefer (in order): paragraph boundary,
 * line boundary, word boundary, then hard-cut.
 */
export function chunk(text: string, limit: number, mode: ChunkMode): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = limit;
    if (mode === 'newline') {
      const para = rest.lastIndexOf('\n\n', limit);
      const line = rest.lastIndexOf('\n', limit);
      const space = rest.lastIndexOf(' ', limit);
      cut =
        para > limit / 2
          ? para
          : line > limit / 2
            ? line
            : space > limit / 2
              ? space
              : limit;
    }
    out.push(rest.slice(0, cut));
    // Keep source whitespace: it may be indentation inside a code block.
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}
