import type { SELECTORS } from './selectors.ts';

export type RawAttachment = {
  name: string;
  url: string;
  /** Teams' own item id when the chip exposes one; used to tell "same file
   *  re-shared" from "different file, same name". */
  itemId: string | null;
  sizeLabel: string | null;
};

export type RawMessage = {
  id: string;
  author: string | null;
  /** ISO 8601, UTC. Null when the DOM offered no machine-readable time; such a
   *  message is kept but flagged, never silently given "now". */
  timestamp: string | null;
  timestampSource: 'datetime' | 'title' | 'none';
  html: string;
  text: string;
  edited: boolean;
  attachments: RawAttachment[];
  /** True for system notices ("X added Y to the chat"), which carry no author. */
  system: boolean;
};

export type ExtractResult = {
  messages: RawMessage[];
  atHistoryStart: boolean;
  scrollTop: number;
  scrollHeight: number;
};

/**
 * Runs INSIDE the page. Must not close over anything: Playwright serialises the
 * function source and evaluates it in the browser, so the selector table is
 * passed as an argument rather than imported.
 */
export function pageExtract(sel: typeof SELECTORS): ExtractResult {
  const first = (root: ParentNode, roles: string[]): Element | null => {
    for (const s of roles) {
      const el = root.querySelector(s);
      if (el) return el;
    }
    return null;
  };

  const findScroller = (): HTMLElement | null => {
    const seed = first(document, sel.messageList) as HTMLElement | null;
    // The advertised list element is not always the one that overflows. Walk up
    // until we find an ancestor that actually scrolls, which survives the
    // wrapper-div churn between Teams releases.
    let node: HTMLElement | null =
      seed ?? (first(document, sel.message) as HTMLElement | null);
    while (node) {
      if (node.scrollHeight > node.clientHeight + 1) {
        const overflow = getComputedStyle(node).overflowY;
        if (overflow === 'auto' || overflow === 'scroll') return node;
      }
      node = node.parentElement;
    }
    return seed;
  };

  const parseTime = (
    el: Element | null,
  ): { iso: string | null; source: RawMessage['timestampSource'] } => {
    if (!el) return { iso: null, source: 'none' };
    const dt = el.getAttribute('datetime');
    if (dt) {
      const d = new Date(dt);
      if (!Number.isNaN(d.getTime())) return { iso: d.toISOString(), source: 'datetime' };
    }
    // Fallback: the human-readable title. Locale-formatted, so it is accepted
    // only when Date can parse it unambiguously. A wrong timestamp is worse
    // than a missing one — it silently corrupts the chronology of the vault.
    const title = el.getAttribute('title') ?? el.textContent ?? '';
    const d = new Date(title.trim());
    if (title.trim() && !Number.isNaN(d.getTime())) {
      return { iso: d.toISOString(), source: 'title' };
    }
    return { iso: null, source: 'none' };
  };

  const attachmentsOf = (root: Element): RawAttachment[] => {
    const out: RawAttachment[] = [];
    const seen = new Set<string>();
    for (const s of sel.attachment) {
      for (const card of Array.from(root.querySelectorAll(s))) {
        const link =
          card.matches('a[href]') ? card : card.querySelector('a[href]');
        const url = link?.getAttribute('href') ?? '';
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const name =
          card.getAttribute('data-file-name') ??
          card.querySelector('[data-tid*="name" i]')?.textContent?.trim() ??
          link?.getAttribute('title')?.trim() ??
          link?.textContent?.trim() ??
          'attachment';
        let itemId: string | null = null;
        try {
          const u = new URL(url, location.href);
          itemId =
            u.searchParams.get('sourcedoc') ??
            u.searchParams.get('objectUrl') ??
            u.searchParams.get('id');
        } catch {
          itemId = null;
        }
        out.push({
          name,
          url,
          itemId,
          sizeLabel:
            card.querySelector('[data-tid*="size" i]')?.textContent?.trim() ?? null,
        });
      }
    }
    return out;
  };

  const scroller = findScroller();
  const messages: RawMessage[] = [];
  const seenIds = new Set<string>();

  for (const s of sel.message) {
    for (const node of Array.from(document.querySelectorAll(s))) {
      const id =
        node.getAttribute('data-mid') ??
        node.getAttribute('id') ??
        node.querySelector('[data-mid]')?.getAttribute('data-mid') ??
        '';
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);

      const body = first(node, sel.body) ?? node;
      const author = first(node, sel.author)?.textContent?.trim() || null;
      const { iso, source } = parseTime(first(node, sel.timestamp));

      messages.push({
        id,
        author,
        timestamp: iso,
        timestampSource: source,
        html: body.innerHTML,
        text: (body.textContent ?? '').trim(),
        edited: !!first(node, sel.editedMarker),
        attachments: attachmentsOf(node),
        system: !author,
      });
    }
  }

  return {
    messages,
    atHistoryStart: !!first(document, sel.historyStart),
    scrollTop: scroller?.scrollTop ?? 0,
    scrollHeight: scroller?.scrollHeight ?? 0,
  };
}
