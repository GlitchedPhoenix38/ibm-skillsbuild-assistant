import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { AppConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/retry.js';
import { findBraveBinary, logLaunchInstructions } from './brave.js';

export interface BraveSession {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly cdpEndpoint: string;
  close(): Promise<void>;
}

export interface ConnectOptions {
  readonly config: AppConfig;
  /** URLs to open in a fresh tab when nothing suitable is found. */
  readonly openUrls?: readonly string[];
}

interface CdpVersionInfo {
  readonly Browser?: string;
  readonly webSocketDebuggerUrl?: string;
}

async function probeCdp(port: number, timeoutMs: number): Promise<CdpVersionInfo | null> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4_000);
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (response.ok) {
        const parsed: unknown = await response.json();
        if (typeof parsed === 'object' && parsed !== null) {
          return parsed as CdpVersionInfo;
        }
      }
      lastError = `HTTP ${response.status}`;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(700);
  }
  logger.debug(`CDP probe on port ${port} failed: ${lastError}`);
  return null;
}

function looksLikeSkillsBuild(url: string): boolean {
  return /skillsbuild|yourlearning|ibm\.com\/learning/i.test(url);
}

async function waitForPageStability(page: Page, timeoutMs: number): Promise<void> {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: Math.min(timeoutMs, 20_000) });
  } catch {
    // SPA pages may never fire a full load; continue and rely on locators.
  }
  try {
    await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 12_000) });
  } catch {
    // Long-polling is common; networkidle is best-effort only.
  }
}

/**
 * Attach to a Brave (or Chromium) instance that was launched with
 * --remote-debugging-port. Uses CDP only: no profile data is copied, read or
 * written by this program, and no cookies or tokens are ever persisted.
 */
export async function connectToBrave(options: ConnectOptions): Promise<BraveSession> {
  const { config } = options;
  const port = config.brave.cdpPort;
  const cdpEndpoint = config.brave.cdpUrl ?? `http://127.0.0.1:${port}`;

  logger.step(`Connecting to Brave over CDP at ${cdpEndpoint} ...`);
  const version = await probeCdp(port, config.brave.connectTimeoutMs);

  if (version === null) {
    const binary = findBraveBinary(config.brave.executablePath);
    logLaunchInstructions(
      { port, fresh: true, urls: options.openUrls ?? [config.planUrl] },
      { cdpPort: port, executablePath: binary },
    );
    throw new Error(
      `No CDP endpoint on port ${port}. Start Brave with --remote-debugging-port=${port} and try again.`,
    );
  }

  logger.success(`Connected to Brave ✓ (${version.Browser ?? 'Chromium'})`);

  const browser = await chromium.connectOverCDP(cdpEndpoint, {
    timeout: config.brave.connectTimeoutMs,
  });

  const context = browser.contexts()[0];
  if (context === undefined) {
    await browser.close().catch(() => undefined);
    throw new Error('Brave connected but exposed no browser context.');
  }

  const page = await pickPage(context, config);
  page.setDefaultTimeout(config.timeouts.actionMs);
  page.setDefaultNavigationTimeout(config.timeouts.navigationMs);

  return {
    browser,
    context,
    page,
    cdpEndpoint,
    close: async (): Promise<void> => {
      // Disconnect only - the user's Brave window stays open and logged in.
      await browser.close().catch(() => undefined);
    },
  };
}

async function pickPage(context: BrowserContext, config: AppConfig): Promise<Page> {
  const existing = context.pages();
  const hinted =
    config.brave.tabUrlHint === undefined
      ? undefined
      : existing.find((candidate) => candidate.url().startsWith(config.brave.tabUrlHint as string));

  const page = hinted ?? existing.find((candidate) => looksLikeSkillsBuild(candidate.url())) ?? existing[0];

  if (page !== undefined) {
    logger.kv('Using tab', page.url() === '' ? 'about:blank' : page.url());
    return page;
  }

  const created = await context.newPage();
  created.setDefaultTimeout(config.timeouts.actionMs);
  created.setDefaultNavigationTimeout(config.timeouts.navigationMs);
  logger.kv('Using tab', 'new tab');
  return created;
}

export { waitForPageStability };
