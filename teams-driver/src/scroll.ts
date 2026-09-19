import type { Page } from 'playwright';
import { SELECTORS } from './selectors.ts';
import { pageExtract, type RawMessage } from './extractor.ts';
import { log } from './log.ts';

export type HarvestMode =
  /** Walk back to the very beginning of the conversation. */
  | { kind: 'full' }
  /** Stop once messages older than this watermark appear. */
  | { kind: 'since'; iso: string };

export type HarvestOptions = {
  mode: HarvestMode;
  /** Message ids already in the vault; used only to report what is new. */
  known: Set<string>;
  /** Give up after this many scroll steps that surface nothing new. */
  patience: number;
  /** Hard ceiling, so a pathological chat cannot loop forever. */
  maxSteps: number;
  settleMs: number;
};

export type HarvestResult = {
  messages: RawMessage[];
  reachedHistoryStart: boolean;
  steps: number;
  stoppedBecause: string;
};

/** Runs in the page. Scrolls the message pane up by nearly a screen. */
function pageScrollUp(sel: typeof SELECTORS): number {
  const first = (roles: string[]): HTMLElement | null => {
    for (const s of roles) {
      const el = document.querySelector(s) as HTMLElement | null;
      if (el) return el;
    }
    return null;
  };
  let node: HTMLElement | null = first(sel.messageList) ?? first(sel.message);
  while (node) {
    if (node.scrollHeight > node.clientHeight + 1) {
      const overflow = getComputedStyle(node).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') break;
    }
    node = node.parentElement;
  }
  if (!node) return -1;
  // Not a full screen: overlapping the previous view guarantees no message can
  // slip between two steps of a virtualised list.
  node.scrollTop = Math.max(0, node.scrollTop - Math.floor(node.clientHeight * 0.8));
  return node.scrollTop;
}

/**
 * Scroll backwards through the chat, extracting on every step.
 *
 * Extraction happens per step rather than once at the end because the list is
 * virtualised: messages that scrolled off the top are removed from the DOM, so
 * anything not read at the moment it was on screen is simply gone. Results are
 * deduplicated by Teams' message id, which is stable across re-renders.
 */
export async function harvest(page: Page, opts: HarvestOptions): Promise<HarvestResult> {
  const collected = new Map<string, RawMessage>();
  let barrenSteps = 0;
  let steps = 0;
  let reachedHistoryStart = false;
  let stoppedBecause = 'exhausted patience';

  for (; steps < opts.maxSteps; steps++) {
    const snapshot = await page.evaluate(pageExtract, SELECTORS);
    const before = collected.size;
    for (const m of snapshot.messages) collected.set(m.id, m);
    const gained = collected.size - before;

    if (snapshot.atHistoryStart) {
      reachedHistoryStart = true;
      stoppedBecause = 'reached the beginning of the conversation';
      break;
    }

    if (opts.mode.kind === 'since') {
      // Stop as soon as the screen holds something older than the watermark:
      // everything above it is already in the vault. The oldest *timestamped*
      // message is the test — undated ones cannot bound anything.
      const oldest = snapshot.messages
        .map((m) => m.timestamp)
        .filter((t): t is string => !!t)
        .sort()[0];
      if (oldest && oldest < opts.mode.iso) {
        stoppedBecause = `reached the previous sync watermark (${opts.mode.iso})`;
        break;
      }
    }

    barrenSteps = gained > 0 ? 0 : barrenSteps + 1;
    if (barrenSteps >= opts.patience) {
      stoppedBecause =
        `no new messages in ${opts.patience} scroll steps — ` +
        `either the top is loaded without a start-of-conversation marker, or a selector is stale`;
      break;
    }

    const top = await page.evaluate(pageScrollUp, SELECTORS);
    if (top < 0) throw new Error('could not find the scrollable message pane — see src/selectors.ts');

    // Teams fetches older pages lazily; the wait is for that request to land
    // and render, not for an animation.
    await page.waitForTimeout(opts.settleMs);
    if (steps % 10 === 9) log.info(`  …${steps + 1} steps, ${collected.size} messages so far`);
  }

  if (steps >= opts.maxSteps) stoppedBecause = `hit the ${opts.maxSteps}-step ceiling`;

  const messages = [...collected.values()].sort((a, b) =>
    (a.timestamp ?? '').localeCompare(b.timestamp ?? '') || a.id.localeCompare(b.id),
  );
  const fresh = messages.filter((m) => !opts.known.has(m.id)).length;
  log.info(`harvested ${messages.length} messages (${fresh} new) in ${steps} steps — ${stoppedBecause}`);

  return { messages, reachedHistoryStart, steps, stoppedBecause };
}
