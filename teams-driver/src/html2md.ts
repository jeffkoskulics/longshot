/**
 * Teams message HTML -> Obsidian-flavoured Markdown.
 *
 * Deliberately a hand-rolled tokeniser rather than a DOM library: the input is
 * not arbitrary web HTML but the narrow subset the Teams composer can emit
 * (inline marks, links, lists, blockquotes, code, emoji images), and the host
 * runs under plain Node with no DOM available.
 *
 * The rule throughout: when a construct is not understood, drop the tags and
 * keep the text. Losing formatting is a blemish; losing what someone said is a
 * defect.
 */

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#160': ' ',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name: string) => {
    const direct = ENTITIES[name];
    if (direct !== undefined) return direct;
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = Number.parseInt(name.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (name.startsWith('#')) {
      const code = Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

/** Escape the characters that would otherwise become Markdown syntax. */
export function escapeMd(s: string): string {
  return s.replace(/([\\`*_[\]#])/g, '\\$1');
}

type Token =
  | { kind: 'text'; value: string }
  | { kind: 'open'; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { kind: 'close'; name: string };

export function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m.index > last) tokens.push({ kind: 'text', value: html.slice(last, m.index) });
    last = re.lastIndex;
    const name = (m[1] ?? '').toLowerCase();
    if (m[0].startsWith('</')) {
      tokens.push({ kind: 'close', name });
      continue;
    }
    const attrs: Record<string, string> = {};
    const attrRe = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let a: RegExpExecArray | null;
    while ((a = attrRe.exec(m[2] ?? '')) !== null) {
      attrs[(a[1] ?? '').toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    }
    tokens.push({ kind: 'open', name, attrs, selfClosing: m[3] === '/' });
  }
  if (last < html.length) tokens.push({ kind: 'text', value: html.slice(last) });
  return tokens;
}

const INLINE_MARK: Record<string, string> = {
  b: '**', strong: '**', i: '*', em: '*', s: '~~', strike: '~~', del: '~~', code: '`',
};
const BLOCK = new Set(['p', 'div', 'br', 'blockquote', 'ul', 'ol', 'li', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

export function htmlToMarkdown(html: string): string {
  const tokens = tokenize(html);
  let out = '';
  /** Open list types, innermost last. Length is the nesting depth. */
  const lists: Array<{ type: 'ul' | 'ol'; index: number }> = [];
  const linkStack: string[] = [];
  let inPre = false;
  let inQuote = false;
  let pendingHref: string | null = null;

  const emit = (s: string) => { out += s; };
  const newBlock = () => {
    if (!out.endsWith('\n\n') && out !== '') emit(out.endsWith('\n') ? '\n' : '\n\n');
  };

  for (const t of tokens) {
    if (t.kind === 'text') {
      let text = decodeEntities(t.value);
      if (!inPre) {
        text = text.replace(/\s+/g, ' ');
        if (text.trim() === '' && (out === '' || /\s$/.test(out))) continue;
        text = escapeMd(text);
      }
      emit(text);
      continue;
    }

    const name = t.kind === 'open' ? t.name : t.name;

    if (t.kind === 'open') {
      const mark = INLINE_MARK[name];
      if (mark && !inPre) { emit(mark); continue; }
      switch (name) {
        case 'br': emit('\n'); break;
        case 'a':
          pendingHref = t.attrs['href'] ?? null;
          linkStack.push(pendingHref ?? '');
          emit('[');
          break;
        case 'img': {
          // Teams renders custom emoji as <img alt=":smile:">. The alt text is
          // the only thing worth keeping; the src is a transient CDN URL.
          const alt = t.attrs['alt'] ?? t.attrs['title'] ?? '';
          if (alt) emit(alt);
          break;
        }
        case 'pre': newBlock(); emit('```\n'); inPre = true; break;
        case 'blockquote': newBlock(); inQuote = true; emit('> '); break;
        case 'ul': lists.push({ type: 'ul', index: 0 }); newBlock(); break;
        case 'ol': lists.push({ type: 'ol', index: 0 }); newBlock(); break;
        case 'li': {
          const cur = lists[lists.length - 1];
          if (!out.endsWith('\n') && out !== '') emit('\n');
          const indent = '  '.repeat(Math.max(0, lists.length - 1));
          if (cur?.type === 'ol') { cur.index += 1; emit(`${indent}${cur.index}. `); }
          else emit(`${indent}- `);
          break;
        }
        case 'p': case 'div': newBlock(); if (inQuote) emit('> '); break;
        case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
          newBlock(); emit('#'.repeat(Number(name[1])) + ' '); break;
        default: break;
      }
      continue;
    }

    // close
    const mark = INLINE_MARK[name];
    if (mark && !inPre) { emit(mark); continue; }
    switch (name) {
      case 'a': {
        const href = linkStack.pop() ?? '';
        emit(href ? `](${href})` : ']');
        pendingHref = null;
        break;
      }
      case 'pre': inPre = false; emit('\n```'); newBlock(); break;
      case 'blockquote': inQuote = false; newBlock(); break;
      case 'ul': case 'ol': lists.pop(); newBlock(); break;
      case 'li': break;
      case 'p': case 'div': newBlock(); break;
      default: if (BLOCK.has(name)) newBlock(); break;
    }
  }

  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
