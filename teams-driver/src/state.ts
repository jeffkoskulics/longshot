import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const STATE_VERSION = 1;

export type FileVersion = {
  hash: string;
  size: number;
  /** Vault-relative path of the stored copy. */
  savedAs: string;
  firstSeenIso: string;
  messageId: string;
};

export type FileRecord = {
  name: string;
  /** Newest last. A second entry means the same file was shared again with
   *  different content — which is the change the user wants surfaced. */
  versions: FileVersion[];
};

export type ChatState = {
  version: number;
  chatId: string;
  chatName: string;
  url: string;
  lastSyncedAt: string | null;
  /** True once a run has walked all the way to the start of the conversation.
   *  Until then, every run keeps backfilling rather than only taking new
   *  messages — an interrupted first run must not be mistaken for a complete
   *  history. */
  backfillComplete: boolean;
  oldestSeenIso: string | null;
  newestSeenIso: string | null;
  messageIds: string[];
  files: Record<string, FileRecord>;
};

export function emptyState(chatId: string, chatName: string, url: string): ChatState {
  return {
    version: STATE_VERSION,
    chatId,
    chatName,
    url,
    lastSyncedAt: null,
    backfillComplete: false,
    oldestSeenIso: null,
    newestSeenIso: null,
    messageIds: [],
    files: {},
  };
}

export function statePath(vaultDir: string): string {
  return join(vaultDir, '.teams-driver', 'state.json');
}

export async function loadState(
  vaultDir: string,
  fallback: () => ChatState,
): Promise<ChatState> {
  try {
    const raw = await readFile(statePath(vaultDir), 'utf8');
    const parsed = JSON.parse(raw) as ChatState;
    if (parsed.version !== STATE_VERSION) {
      throw new Error(
        `state.json is version ${parsed.version}, this build writes ${STATE_VERSION}. ` +
          `Refusing to guess at a migration — move it aside to re-sync from scratch.`,
      );
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback();
    throw err;
  }
}

/**
 * Write via a temp file and rename. A half-written state.json is worse than no
 * state.json: it makes the next run believe it has already captured messages it
 * has not, and those messages are then never fetched again.
 */
export async function saveState(vaultDir: string, state: ChatState): Promise<void> {
  const target = statePath(vaultDir);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await rename(tmp, target);
}

/** Merge newly seen ids, keeping the set stable and sorted for readable diffs. */
export function rememberMessages(state: ChatState, ids: string[]): string[] {
  const known = new Set(state.messageIds);
  const fresh = ids.filter((id) => !known.has(id));
  if (fresh.length) {
    state.messageIds = [...known, ...fresh].sort();
  }
  return fresh;
}

export function noteTimestamps(state: ChatState, isoTimes: Array<string | null>): void {
  for (const iso of isoTimes) {
    if (!iso) continue;
    if (!state.oldestSeenIso || iso < state.oldestSeenIso) state.oldestSeenIso = iso;
    if (!state.newestSeenIso || iso > state.newestSeenIso) state.newestSeenIso = iso;
  }
}
