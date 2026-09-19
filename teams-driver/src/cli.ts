#!/usr/bin/env node --experimental-strip-types
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openSession, openChat } from './session.ts';
import { harvest, type HarvestMode } from './scroll.ts';
import { fetchAndStore, type StoredAttachment } from './attachments.ts';
import {
  renderMessage, writeDayNote, composeIndex, composeFileNote, slugify,
  type RenderedMessage,
} from './markdown.ts';
import { loadState, saveState, emptyState, rememberMessages, noteTimestamps } from './state.ts';
import { log } from './log.ts';

type Args = {
  url: string;
  vault: string;
  name: string;
  profile: string;
  full: boolean;
  headless: boolean;
  settleMs: number;
  patience: number;
  maxSteps: number;
  noFiles: boolean;
};

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string) => argv.includes(flag);
  const url = get('--url');
  const vault = get('--vault');
  if (!url || !vault) {
    console.error(`teams-driver — archive a Teams chat into an Obsidian folder

  --url <url>        the chat's URL in the Teams web client (required)
  --vault <dir>      folder to write into (required); one folder per chat
  --name <text>      display name for the chat (default: the folder name)
  --profile <dir>    browser profile holding your Teams session (default: ./profile)
  --full             walk back to the beginning of the history
  --headless         run without a visible window (never on the first run)
  --settle <ms>      pause after each scroll step (default 700)
  --patience <n>     barren scroll steps before stopping (default 8)
  --max-steps <n>    hard ceiling on scroll steps (default 4000)
  --no-files         skip downloading attachments`);
    process.exit(2);
  }
  const vaultDir = resolve(vault);
  return {
    url,
    vault: vaultDir,
    name: get('--name') ?? vaultDir.split(/[\\/]/).pop() ?? 'Teams chat',
    profile: resolve(get('--profile') ?? './profile'),
    full: has('--full'),
    headless: has('--headless'),
    settleMs: Number(get('--settle') ?? 700),
    patience: Number(get('--patience') ?? 8),
    maxSteps: Number(get('--max-steps') ?? 4000),
    noFiles: has('--no-files'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.vault, { recursive: true });

  const state = await loadState(args.vault, () => emptyState(args.url, args.name, args.url));
  state.chatName = args.name;
  state.url = args.url;

  // An interrupted first run leaves backfillComplete false. Until it is true,
  // every run backfills: treating a partial history as complete would leave a
  // permanent hole that no later run ever goes back for.
  const wantFull = args.full || !state.backfillComplete;
  const mode: HarvestMode =
    wantFull || !state.newestSeenIso ? { kind: 'full' } : { kind: 'since', iso: state.newestSeenIso };
  log.step(
    mode.kind === 'full'
      ? 'full backfill — scrolling to the beginning of the history'
      : `incremental — anything after ${mode.iso}`,
  );

  const context = await openSession(args.profile, args.headless && !!state.lastSyncedAt);
  try {
    const page = await openChat(context, args.url, 5 * 60_000);
    const result = await harvest(page, {
      mode,
      known: new Set(state.messageIds),
      patience: args.patience,
      maxSteps: args.maxSteps,
      settleMs: args.settleMs,
    });

    const known = new Set(state.messageIds);
    const incoming = result.messages.filter((m) => !known.has(m.id));
    log.step(`writing ${incoming.length} new messages`);

    const byDay = new Map<string, RenderedMessage[]>();
    const fileDiffs: Record<string, Record<string, string>> = {};

    for (const msg of incoming) {
      const links: StoredAttachment[] = [];
      if (!args.noFiles) {
        for (const att of msg.attachments) {
          const stored = await fetchAndStore(
            context.request, args.vault, state, att, msg.id,
            msg.timestamp ?? new Date().toISOString(),
          );
          if (!stored) continue;
          links.push(stored);
          if (stored.diff) {
            const key = slugify(stored.name);
            (fileDiffs[key] ??= {})[stored.diff.hash] = stored.diff.text;
          }
        }
      }
      const rendered = renderMessage(msg, links);
      const bucket = byDay.get(rendered.day) ?? [];
      bucket.push(rendered);
      byDay.set(rendered.day, bucket);
    }

    for (const [day, msgs] of byDay) {
      await writeDayNote(args.vault, args.name, day, msgs);
      log.info(`  ${day}.md — ${msgs.length} message(s)`);
    }

    for (const record of Object.values(state.files)) {
      const key = slugify(record.name);
      await mkdir(join(args.vault, 'files'), { recursive: true });
      await writeFile(
        join(args.vault, 'files', `${key}.md`),
        composeFileNote(record, fileDiffs[key] ?? {}),
        'utf8',
      );
    }

    rememberMessages(state, result.messages.map((m) => m.id));
    noteTimestamps(state, result.messages.map((m) => m.timestamp));
    if (result.reachedHistoryStart) state.backfillComplete = true;
    state.lastSyncedAt = new Date().toISOString();
    await saveState(args.vault, state);

    const days = (await readdir(args.vault))
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f) || f === 'undated.md')
      .map((f) => f.replace(/\.md$/, ''));
    await writeFile(join(args.vault, 'index.md'), composeIndex(state, days), 'utf8');

    if (!state.backfillComplete) {
      log.warn(
        'the start of the conversation was never reached, so the history is ' +
          'incomplete. The next run will keep backfilling.',
      );
    }
    log.step(`done — ${state.messageIds.length} messages in the vault`);
  } finally {
    await context.close();
  }
}

main().catch((err: unknown) => {
  log.error((err as Error).stack ?? String(err));
  process.exit(1);
});
