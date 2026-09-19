/**
 * Every assumption about the shape of the Teams web DOM lives here.
 *
 * This is the part of the driver that breaks. Microsoft reskins the Teams web
 * client without notice and without a stable contract, so the rest of the code
 * is written to survive that: it asks for a *role* ("the message list", "the
 * author of this message") and this file decides how that role is spelled today.
 *
 * Each role is a list of candidate selectors, tried in order. Prefer
 * `data-tid` attributes: they are Microsoft's own test ids and outlive class
 * names, which are generated and change per deploy. Never select on a class
 * that looks like `fui-Foo__bar_1a2b3c` — the hash rotates.
 *
 * To re-derive a selector after a break: open the chat in Edge, F12, pick the
 * element, and read its `data-tid`. Add the new spelling to the FRONT of the
 * list and leave the old one in place; older tenants lag behind current ones by
 * months, and a stale candidate costs nothing but a failed `querySelector`.
 */
export type SelectorRole =
  | 'messageList'
  | 'message'
  | 'messageId'
  | 'author'
  | 'timestamp'
  | 'body'
  | 'editedMarker'
  | 'attachment'
  | 'historyStart';

export const SELECTORS: Record<SelectorRole, string[]> = {
  // The scrollable region holding the messages. Note this is NOT the element
  // with the scrollbar in every build; `findScroller` walks up from a message
  // to whatever actually overflows, and uses these only as a starting point.
  messageList: [
    '[data-tid="message-pane-list-viewport"]',
    '[data-tid="messagePaneList"]',
    '[data-tid="pane-list-viewport"]',
    'div[role="log"]',
    'div[role="list"][aria-label]',
  ],
  // One rendered message. The list is virtualised: these come and go as you
  // scroll, which is why extraction runs on every scroll step rather than once
  // at the end.
  message: [
    '[data-tid="chat-pane-message"]',
    '[data-tid="message-pane-message"]',
    'div[role="listitem"][data-mid]',
    'div[data-mid]',
  ],
  // Teams' own message id: a client-generated timestamp-like string, stable for
  // the lifetime of the message and unique within a chat. This is the dedupe
  // key across scroll steps and across runs.
  messageId: ['[data-mid]', '[id^="m"][data-tid]'],
  author: [
    '[data-tid="message-author-name"]',
    '[data-tid="messageAuthorName"]',
    'span[data-tid*="author" i]',
  ],
  // Must expose a machine-readable time. An element with `datetime` is
  // authoritative; a title attribute is the fallback and is locale-formatted,
  // so it is parsed defensively and discarded if ambiguous.
  timestamp: ['time[datetime]', '[data-tid="messageTimestamp"]', 'time'],
  body: [
    '[data-tid="messageBodyContent"]',
    '[data-tid="message-body-content"]',
    'div[id^="content-"]',
  ],
  editedMarker: ['[data-tid="edited-marker"]', '[data-tid="messageEditedLabel"]'],
  // File chips / cards attached to a message.
  attachment: [
    '[data-tid="file-card"]',
    '[data-tid="attachment-card"]',
    'a[href*="sharepoint.com"][download]',
    'a[data-tid*="file" i][href]',
  ],
  // Rendered once, at the very top, when the whole history is loaded. Its
  // presence is the clean termination condition for a full backfill; the
  // scroller falls back to "no new messages after N attempts" when it is absent.
  historyStart: [
    '[data-tid="beginning-of-conversation"]',
    '[data-tid="startOfConversation"]',
    '[data-tid="conversation-start-banner"]',
  ],
};

/** All candidates for a role, as one comma-joined selector. */
export function anyOf(role: SelectorRole): string {
  return SELECTORS[role].join(', ');
}
