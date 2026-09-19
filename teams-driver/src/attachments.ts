import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import type { APIRequestContext } from 'playwright';
import type { RawAttachment } from './extractor.ts';
import type { ChatState, FileRecord } from './state.ts';
import { slugify } from './markdown.ts';
import { unifiedDiff } from './diff.ts';
import { log } from './log.ts';

/** Extensions we will attempt a textual diff on. Everything else is compared by
 *  hash only — a binary "diff" is noise, not information. */
const TEXTUAL = new Set([
  '.txt', '.md', '.csv', '.tsv', '.json', '.yaml', '.yml', '.xml', '.html', '.htm',
  '.js', '.ts', '.py', '.rs', '.sh', '.sql', '.ini', '.cfg', '.log', '.ps1',
]);

export type StoredAttachment = {
  name: string;
  /** Vault-relative path of the copy this message should link to. */
  vaultPath: string;
  /** Human note for the message body: null, or "v2 — content changed". */
  note: string | null;
  /** Diff against the previous version, keyed for the file note. */
  diff: { hash: string; text: string } | null;
};

/**
 * SharePoint links in the DOM usually point at the web viewer, not the bytes.
 * `download=1` is the documented switch that makes the same URL serve the file.
 */
function toDownloadUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (/sharepoint\.com|1drv\.ms|officeapps\.live\.com/.test(u.hostname)) {
      u.searchParams.set('download', '1');
    }
    return u.toString();
  } catch {
    return raw;
  }
}

function keyFor(att: RawAttachment): string {
  // Prefer Teams' own item id: it distinguishes "the same document, updated"
  // from "a different document that happens to share a filename".
  return att.itemId ? `item:${att.itemId}` : `name:${att.name.toLowerCase()}`;
}

export async function fetchAndStore(
  request: APIRequestContext,
  chatDir: string,
  state: ChatState,
  att: RawAttachment,
  messageId: string,
  seenIso: string,
): Promise<StoredAttachment | null> {
  const url = toDownloadUrl(att.url);
  let body: Buffer;
  try {
    const res = await request.get(url, { timeout: 60_000 });
    if (!res.ok()) {
      log.warn(`attachment "${att.name}" returned HTTP ${res.status()} — skipped`);
      return null;
    }
    const type = res.headers()['content-type'] ?? '';
    body = Buffer.from(await res.body());
    // A sign-in page is a 200 with HTML. Storing it as "the file" would be a
    // silent corruption of the archive, so it is refused outright.
    if (type.includes('text/html') && !/\.html?$/i.test(att.name)) {
      log.warn(
        `attachment "${att.name}" came back as HTML — the session has probably ` +
          `expired, or the link is a viewer page. Skipped rather than stored.`,
      );
      return null;
    }
  } catch (err) {
    log.warn(`attachment "${att.name}" failed to download: ${(err as Error).message}`);
    return null;
  }

  const hash = createHash('sha256').update(body).digest('hex');
  const key = keyFor(att);
  const record: FileRecord = state.files[key] ?? { name: att.name, versions: [] };

  const existing = record.versions.find((v) => v.hash === hash);
  if (existing) {
    // Byte-identical re-share. Link to the copy already on disk; storing it
    // twice would make the vault grow without adding anything.
    state.files[key] = record;
    return { name: att.name, vaultPath: existing.savedAs, note: null, diff: null };
  }

  const version = record.versions.length + 1;
  const dir = join('files', slugify(att.name));
  const ext = extname(att.name);
  const base = att.name.slice(0, att.name.length - ext.length) || 'file';
  const vaultPath = `${dir}/v${version}--${slugify(base)}${ext}`;
  const abs = join(chatDir, vaultPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, body);

  let diff: StoredAttachment['diff'] = null;
  const previous = record.versions[record.versions.length - 1];
  if (previous && TEXTUAL.has(ext.toLowerCase())) {
    try {
      const before = await readFile(join(chatDir, previous.savedAs), 'utf8');
      diff = { hash, text: unifiedDiff(before, body.toString('utf8')) };
    } catch (err) {
      log.warn(`could not diff "${att.name}" against v${version - 1}: ${(err as Error).message}`);
    }
  }

  record.versions.push({ hash, size: body.length, savedAs: vaultPath, firstSeenIso: seenIso, messageId });
  state.files[key] = record;

  return {
    name: att.name,
    vaultPath,
    note: version > 1 ? `v${version} — content changed since v${version - 1}` : null,
    diff,
  };
}
