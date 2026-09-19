import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { anyOf } from './selectors.ts';
import { log } from './log.ts';

/**
 * A persistent browser profile is the whole authentication story. There is no
 * app registration and no token: the driver signs in the way you do, once, by
 * hand, and every later run reuses the cookies in this profile directory.
 *
 * Treat the profile directory as a credential. It is gitignored, and it should
 * not be copied off the machine.
 */
export async function openSession(profileDir: string, headless: boolean): Promise<BrowserContext> {
  await mkdir(profileDir, { recursive: true });
  // Edge by preference: it is present on every Windows install and its user
  // agent is the one Teams is actually tested against. Falls back to the
  // Chromium that `playwright install` fetched.
  for (const channel of ['msedge', 'chrome', undefined]) {
    try {
      return await chromium.launchPersistentContext(profileDir, {
        channel,
        headless,
        acceptDownloads: true,
        viewport: { width: 1440, height: 1000 },
        args: ['--disable-blink-features=AutomationControlled'],
      });
    } catch (err) {
      log.warn(`could not launch ${channel ?? 'bundled chromium'}: ${(err as Error).message}`);
    }
  }
  throw new Error(
    'No usable browser. Run `npm run postinstall`, or install Microsoft Edge.',
  );
}

/**
 * Navigate to the chat and wait until messages are on screen. If the tenant
 * wants a sign-in or an MFA prompt, that happens in this visible window and the
 * driver simply waits — which is why the first run must not be headless.
 */
export async function openChat(
  context: BrowserContext,
  url: string,
  loginTimeoutMs: number,
): Promise<Page> {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  log.info('waiting for the message list (sign in in the browser window if asked)…');
  await page.waitForSelector(anyOf('message'), { timeout: loginTimeoutMs });
  log.info('message list is up');
  return page;
}
