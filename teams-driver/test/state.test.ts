import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffLines, unifiedDiff } from '../src/diff.ts';
import { emptyState, loadState, saveState, rememberMessages, noteTimestamps, statePath } from '../src/state.ts';

const tmp = () => mkdtemp(join(tmpdir(), 'td-'));

test('diff reports an inserted line and nothing else', () => {
  const ops = diffLines('a\nb\nc', 'a\nX\nb\nc');
  assert.deepEqual(ops.filter((o) => o.op === '+').map((o) => o.line), ['X']);
  assert.deepEqual(ops.filter((o) => o.op === '-'), []);
});

test('identical text produces no changed lines', () => {
  assert.ok(diffLines('a\nb', 'a\nb').every((o) => o.op === ' '));
});

test('unified diff elides unchanged regions', () => {
  const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const after = before.replace('line 20', 'line 20 CHANGED');
  const out = unifiedDiff(before, after);
  assert.ok(out.includes('+line 20 CHANGED'), out);
  assert.ok(out.includes('@@ ...'), out);
  assert.ok(!out.includes('line 0'), out);
});

test('a fresh vault starts with an incomplete backfill', async () => {
  const dir = await tmp();
  const s = await loadState(dir, () => emptyState('id', 'Chat', 'https://x'));
  assert.equal(s.backfillComplete, false);
  assert.equal(s.messageIds.length, 0);
});

test('state survives a save/load round trip', async () => {
  const dir = await tmp();
  const s = emptyState('id', 'Chat', 'https://x');
  rememberMessages(s, ['b', 'a']);
  s.backfillComplete = true;
  await saveState(dir, s);
  const back = await loadState(dir, () => { throw new Error('should have loaded'); });
  assert.deepEqual(back.messageIds, ['a', 'b']);
  assert.equal(back.backfillComplete, true);
});

test('rememberMessages returns only the ids not already known', () => {
  const s = emptyState('id', 'Chat', 'https://x');
  rememberMessages(s, ['a', 'b']);
  assert.deepEqual(rememberMessages(s, ['b', 'c']), ['c']);
  assert.deepEqual(s.messageIds, ['a', 'b', 'c']);
});

test('the timestamp window widens in both directions', () => {
  const s = emptyState('id', 'Chat', 'https://x');
  noteTimestamps(s, ['2026-09-10T00:00:00.000Z', null, '2026-09-20T00:00:00.000Z']);
  noteTimestamps(s, ['2026-09-01T00:00:00.000Z']);
  assert.equal(s.oldestSeenIso, '2026-09-01T00:00:00.000Z');
  assert.equal(s.newestSeenIso, '2026-09-20T00:00:00.000Z');
});

test('a state file from a future version is refused rather than misread', async () => {
  const dir = await tmp();
  await mkdir(join(dir, '.teams-driver'), { recursive: true });
  await writeFile(statePath(dir), JSON.stringify({ version: 99 }), 'utf8');
  await assert.rejects(loadState(dir, () => emptyState('id', 'C', 'u')), /version 99/);
});

test('saving leaves no partial file behind under the real name', async () => {
  const dir = await tmp();
  const s = emptyState('id', 'Chat', 'https://x');
  await saveState(dir, s);
  await saveState(dir, s);
  // Whatever is at the canonical path must always be parseable JSON.
  assert.doesNotThrow(() => JSON.parse(readFileSync(statePath(dir), 'utf8')));
});
