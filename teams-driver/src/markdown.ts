import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { htmlToMarkdown } from './html2md.ts';
import type { RawMessage } from './extractor.ts';
import type { ChatState, FileRecord } from './state.ts';

/** A message as it will appear in the vault. */
export type RenderedMessage = {
  id: string;
  /** ISO timestamp, or null when the DOM gave us nothing trustworthy. */
  iso: string | null;
  /** Day the note goes in: YYYY-MM-DD in local time, or 'undated'. */
  day: string;
  block: string;
};

export function slugify(s: string): string {
  return (
    s
      .normalize('NFKD')
      .replace(/[^\w\s.-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .slice(0, 80) || 'untitled'
  );
}

export function dayOf(iso: string | null): string {
  if (!iso) return 'undated';
  const d = new Date(iso);
  // Local time on purpose: a person looking for "what was said on Tuesday"
  // means their Tuesday, not UTC's.
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function clockOf(iso: string | null): string {
  if (!iso) return '??:??';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * One message becomes one block, ending in an Obsidian block id derived from
 * the Teams message id. That block id is what makes a re-run idempotent: it is
 * how the writer recognises a message it has already filed.
 */
export function renderMessage(
  msg: RawMessage,
  attachmentLinks: Array<{ name: string; vaultPath: string; note: string | null }>,
): RenderedMessage {
  const body = htmlToMarkdown(msg.html) || msg.text;
  const author = msg.author ?? '_system_';
  const lines: string[] = [];

  lines.push(`### ${clockOf(msg.timestamp)} — ${author}`);
  lines.push(`<!-- ts:${msg.timestamp ?? 'none'} src:${msg.timestampSource} -->`);
  if (msg.timestampSource === 'none') {
    lines.push('> [!warning] No machine-readable timestamp was present for this message.');
  }
  lines.push('');
  lines.push(body);

  if (attachmentLinks.length) {
    lines.push('');
    lines.push('**Attachments**');
    for (const a of attachmentLinks) {
      const suffix = a.note ? ` — ${a.note}` : '';
      lines.push(`- [[${a.vaultPath}|${a.name}]]${suffix}`);
    }
  }
  if (msg.edited) {
    lines.push('');
    lines.push('*(edited in Teams)*');
  }
  lines.push('');
  lines.push(`^m-${sanitizeAnchor(msg.id)}`);

  return {
    id: msg.id,
    iso: msg.timestamp,
    day: dayOf(msg.timestamp),
    block: lines.join('\n'),
  };
}

/** Obsidian block ids allow only letters, digits and dashes. */
export function sanitizeAnchor(id: string): string {
  return id.replace(/[^A-Za-z0-9-]/g, '-').replace(/-{2,}/g, '-');
}

type ParsedBlock = { id: string; ts: string; block: string };

/**
 * Split a previously written day note back into its message blocks, so a later
 * run can merge into it rather than append blindly. Backfill delivers *older*
 * messages after newer ones are already on disk, so append-only would leave the
 * note out of order.
 */
export function parseDayNote(text: string): { frontmatter: string; blocks: ParsedBlock[] } {
  let body = text;
  let frontmatter = '';
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (fm) {
    frontmatter = fm[1] ?? '';
    body = text.slice(fm[0].length);
  }
  const blocks: ParsedBlock[] = [];
  const chunks = body.split(/\n(?=### )/g);
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed.startsWith('###')) continue;
    const idMatch = /\^m-([A-Za-z0-9-]+)\s*$/m.exec(trimmed);
    const tsMatch = /<!--\s*ts:(\S+)/.exec(trimmed);
    if (!idMatch) continue;
    blocks.push({ id: idMatch[1]!, ts: tsMatch?.[1] ?? 'none', block: trimmed });
  }
  return { frontmatter, blocks };
}

function sortBlocks(blocks: ParsedBlock[]): ParsedBlock[] {
  return [...blocks].sort((x, y) => {
    // Undated messages sink to the bottom rather than scrambling the timeline.
    if (x.ts === 'none' && y.ts !== 'none') return 1;
    if (y.ts === 'none' && x.ts !== 'none') return -1;
    return x.ts === y.ts ? x.id.localeCompare(y.id) : x.ts.localeCompare(y.ts);
  });
}

export function composeDayNote(
  chatName: string,
  day: string,
  existing: string | null,
  incoming: RenderedMessage[],
): string {
  const prior = existing ? parseDayNote(existing) : { frontmatter: '', blocks: [] };
  const byId = new Map<string, ParsedBlock>();
  for (const b of prior.blocks) byId.set(b.id, b);
  for (const m of incoming) {
    const anchor = sanitizeAnchor(m.id);
    // A message already on disk is replaced, not duplicated: Teams messages can
    // be edited after the fact, and the newer render is the truer one.
    byId.set(anchor, { id: anchor, ts: m.iso ?? 'none', block: m.block.trim() });
  }
  const ordered = sortBlocks([...byId.values()]);
  const fm = [
    '---',
    `chat: "${chatName.replace(/"/g, '\\"')}"`,
    `date: ${day}`,
    `messages: ${ordered.length}`,
    'tags: [teams/chat]',
    '---',
  ].join('\n');
  return `${fm}\n\n# ${chatName} — ${day}\n\n${ordered.map((b) => b.block).join('\n\n')}\n`;
}

export async function writeDayNote(
  chatDir: string,
  chatName: string,
  day: string,
  incoming: RenderedMessage[],
): Promise<void> {
  const path = join(chatDir, `${day}.md`);
  let existing: string | null = null;
  try {
    existing = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, composeDayNote(chatName, day, existing, incoming), 'utf8');
}

export function composeIndex(state: ChatState, days: string[]): string {
  const fileLines = Object.values(state.files)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => {
      const versions = f.versions.length;
      const flag = versions > 1 ? ` — **${versions} versions**` : '';
      return `- [[files/${slugify(f.name)}|${f.name}]]${flag}`;
    });
  return [
    '---',
    `chat: "${state.chatName.replace(/"/g, '\\"')}"`,
    `source: ${state.url}`,
    `last_synced: ${state.lastSyncedAt ?? 'never'}`,
    `backfill_complete: ${state.backfillComplete}`,
    'tags: [teams/chat, teams/index]',
    '---',
    '',
    `# ${state.chatName}`,
    '',
    state.backfillComplete
      ? 'History captured back to the start of the conversation.'
      : '> [!warning] Backfill is incomplete — the oldest messages have not been captured yet. Run `sync --full` again.',
    '',
    `- Messages captured: ${state.messageIds.length}`,
    `- Range: ${state.oldestSeenIso ?? '—'} → ${state.newestSeenIso ?? '—'}`,
    '',
    '## Days',
    '',
    ...days.sort().reverse().map((d) => `- [[${d}]]`),
    '',
    '## Shared files',
    '',
    ...(fileLines.length ? fileLines : ['_none yet_']),
    '',
  ].join('\n');
}

export function composeFileNote(record: FileRecord, diffs: Record<string, string>): string {
  const lines: string[] = [
    '---',
    `file: "${record.name.replace(/"/g, '\\"')}"`,
    `versions: ${record.versions.length}`,
    'tags: [teams/file]',
    '---',
    '',
    `# ${record.name}`,
    '',
  ];
  if (record.versions.length > 1) {
    lines.push(
      `> [!info] This file was shared ${record.versions.length} times with differing content.`,
      '',
    );
  }
  record.versions.forEach((v, i) => {
    lines.push(`## v${i + 1} — ${v.firstSeenIso}`);
    lines.push('');
    lines.push(`- Copy: [[${v.savedAs}]]`);
    lines.push(`- SHA-256: \`${v.hash}\``);
    lines.push(`- Size: ${v.size} bytes`);
    lines.push(`- Shared in message: \`^m-${sanitizeAnchor(v.messageId)}\``);
    const diff = diffs[v.hash];
    if (diff) {
      lines.push('', `### Changes from v${i}`, '', '```diff', diff, '```');
    }
    lines.push('');
  });
  return lines.join('\n');
}
