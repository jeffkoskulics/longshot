import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeDayNote, parseDayNote, renderMessage, sanitizeAnchor, dayOf, slugify } from '../src/markdown.ts';
import type { RawMessage } from '../src/extractor.ts';

function msg(over: Partial<RawMessage> & { id: string }): RawMessage {
  return {
    author: 'Alice',
    timestamp: '2026-09-19T14:03:00.000Z',
    timestampSource: 'datetime',
    html: '<p>hello</p>',
    text: 'hello',
    edited: false,
    attachments: [],
    system: false,
    ...over,
  };
}

test('a message id becomes a legal Obsidian block anchor', () => {
  assert.equal(sanitizeAnchor('1726754580123'), '1726754580123');
  assert.equal(sanitizeAnchor('m:1726_754/580'), 'm-1726-754-580');
});

test('undated messages go to their own note rather than to a guessed day', () => {
  assert.equal(dayOf(null), 'undated');
});

test('a rendered block round-trips through the parser', () => {
  const r = renderMessage(msg({ id: '111' }), []);
  const note = composeDayNote('Team', '2026-09-19', null, [r]);
  const parsed = parseDayNote(note);
  assert.equal(parsed.blocks.length, 1);
  assert.equal(parsed.blocks[0]!.id, '111');
});

test('re-running over an existing note does not duplicate messages', () => {
  const a = renderMessage(msg({ id: '111' }), []);
  const first = composeDayNote('Team', '2026-09-19', null, [a]);
  const second = composeDayNote('Team', '2026-09-19', first, [a]);
  assert.equal(parseDayNote(second).blocks.length, 1);
  assert.equal(second.match(/\^m-111/g)?.length, 1);
});

test('backfilled older messages are inserted in order, not appended', () => {
  const newer = renderMessage(msg({ id: '222', timestamp: '2026-09-19T15:00:00.000Z' }), []);
  const older = renderMessage(msg({ id: '111', timestamp: '2026-09-19T09:00:00.000Z' }), []);
  const note = composeDayNote('Team', '2026-09-19', composeDayNote('Team', '2026-09-19', null, [newer]), [older]);
  const ids = parseDayNote(note).blocks.map((b) => b.id);
  assert.deepEqual(ids, ['111', '222']);
});

test('an edited message replaces the copy already on disk', () => {
  const before = renderMessage(msg({ id: '111', html: '<p>typo</p>' }), []);
  const after = renderMessage(msg({ id: '111', html: '<p>fixed</p>', edited: true }), []);
  const note = composeDayNote('Team', '2026-09-19', composeDayNote('Team', '2026-09-19', null, [before]), [after]);
  assert.ok(note.includes('fixed'), note);
  assert.ok(!note.includes('typo'), note);
  assert.equal(parseDayNote(note).blocks.length, 1);
});

test('undated messages sink below timestamped ones', () => {
  const dated = renderMessage(msg({ id: '222' }), []);
  const undated = renderMessage(msg({ id: '111', timestamp: null, timestampSource: 'none' }), []);
  const note = composeDayNote('Team', '2026-09-19', null, [undated, dated]);
  assert.deepEqual(parseDayNote(note).blocks.map((b) => b.id), ['222', '111']);
});

test('a missing timestamp is flagged in the note instead of being invented', () => {
  const r = renderMessage(msg({ id: '111', timestamp: null, timestampSource: 'none' }), []);
  assert.ok(r.block.includes('No machine-readable timestamp'), r.block);
});

test('attachments render as wikilinks carrying the version note', () => {
  const r = renderMessage(msg({ id: '111' }), [
    { name: 'plan.md', vaultPath: 'files/plan.md/v2--plan.md', note: 'v2 — content changed since v1' },
  ]);
  assert.ok(r.block.includes('[[files/plan.md/v2--plan.md|plan.md]] — v2 — content changed since v1'), r.block);
});

test('quotes in a chat name do not break the YAML frontmatter', () => {
  const note = composeDayNote('The "Big" Room', '2026-09-19', null, [renderMessage(msg({ id: '1' }), [])]);
  assert.ok(note.includes('chat: "The \\"Big\\" Room"'), note);
});

test('slugify keeps extensions usable and bounds the length', () => {
  assert.equal(slugify('Q3 Plan (final).docx'), 'Q3-Plan-final.docx');
  assert.ok(slugify('x'.repeat(200)).length <= 80);
});
