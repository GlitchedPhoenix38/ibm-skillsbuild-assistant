import type { Frame, Locator, Page } from 'playwright-core';
import type { AppConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { captureScreenshot } from '../utils/screenshots.js';

export type FrameContext = Page | Frame;

/** Attribute used to tag discovered option elements so clicks are stable. */
export const OPTION_ATTR = 'data-sba-option';
export const OPTION_SELECTOR_PREFIX = `[${OPTION_ATTR}="`;

export interface SafeClickResult {
  readonly clicked: boolean;
  readonly reason: string;
}

export function isVisible(locator: Locator): Promise<boolean> {
  return locator.isVisible().catch(() => false);
}

export function isEnabled(locator: Locator): Promise<boolean> {
  return locator.isEnabled().catch(() => false);
}

/**
 * Click a locator only after verifying it is the intended control and that it is
 * visible + enabled. Uses Playwright's own actionability checks (no raw
 * coordinates, no page.mouse clicks).
 */
export async function safeClick(
  locator: Locator,
  description: string,
  options: { timeoutMs?: number; screenshotOnFailure?: boolean; frame?: FrameContext | null } = {},
): Promise<SafeClickResult> {
  const timeout = options.timeoutMs ?? 15_000;
  try {
    const count = await locator.count();
    if (count === 0) {
      return { clicked: false, reason: `"${description}" not found on the page` };
    }
    if (count > 1) {
      return {
        clicked: false,
        reason: `"${description}" matched ${count} elements; refusing to guess`,
      };
    }

    if (!(await isVisible(locator))) {
      return { clicked: false, reason: `"${description}" exists but is not visible` };
    }
    if (!(await isEnabled(locator))) {
      return { clicked: false, reason: `"${description}" exists but is disabled` };
    }

    await locator.scrollIntoViewIfNeeded({ timeout });
    // Re-verify after scrolling: layout shifts can change visibility.
    if (!(await isVisible(locator))) {
      return { clicked: false, reason: `"${description}" became invisible after scrolling` };
    }

    await locator.click({ timeout, force: false });
    logger.debug(`Clicked: ${description}`);
    return { clicked: true, reason: 'clicked' };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug(`Click failed for "${description}": ${message}`);
    if (options.screenshotOnFailure === true) {
      await captureScreenshot(options.frame ?? null, `click-failed-${description}`);
    }
    return { clicked: false, reason: message };
  }
}

/** Build a locator from a selector string produced by the extractor. */
export function locatorFromSelector(context: FrameContext, selector: string): Locator {
  return context.locator(selector);
}

export async function pageTitle(context: FrameContext): Promise<string> {
  try {
    const title = await context.title();
    return title.trim();
  } catch {
    return '';
  }
}

/** Remove temporary automation attributes so the page is left as we found it. */
export async function clearOptionTags(context: FrameContext): Promise<void> {
  await ensureEvalHelpers(context);
  try {
    await context.evaluate((attr: string) => {
      const nodes = document.querySelectorAll(`[${attr}]`);
      nodes.forEach((node) => node.removeAttribute(attr));
    }, OPTION_ATTR);
  } catch (error: unknown) {
    logger.debug(`Could not clear option tags: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Detect a stable, human-readable description of the visible page. */
export async function describePage(context: FrameContext): Promise<{ url: string; title: string; heading: string }> {
  let url = '';
  let title = '';
  let heading = '';
  await ensureEvalHelpers(context);
  try {
    url = context.url();
  } catch {
    url = '';
  }
  try {
    title = await pageTitle(context);
  } catch {
    title = '';
  }
  try {
    heading = await context.evaluate(() => {
      const candidate =
        document.querySelector('h1') ??
        document.querySelector('[role="heading"][aria-level="1"]') ??
        document.querySelector('main h1, main h2') ??
        document.querySelector('h2, h3');
      return candidate?.textContent?.trim() ?? '';
    });
  } catch {
    heading = '';
  }
  return { url, title, heading };
}

/** Wait until the document stops changing for a short while (SPA friendly). */
export async function waitForStableDom(context: FrameContext, quietMs = 600, timeoutMs = 15_000): Promise<void> {
  await ensureEvalHelpers(context);
  const started = Date.now();
  let stableSince = Date.now();
  let previousSignature = await domSignature(context);

  while (Date.now() - started < timeoutMs) {
    await context.waitForTimeout(250).catch(() => undefined);
    const signature = await domSignature(context);
    if (signature === previousSignature) {
      if (Date.now() - stableSince >= quietMs) return;
    } else {
      previousSignature = signature;
      stableSince = Date.now();
    }
  }
  logger.debug('DOM did not fully stabilise within the timeout; continuing anyway.');
}

async function domSignature(context: FrameContext): Promise<string> {
  try {
    return await context.evaluate(() => {
      const body = document.body;
      if (body === null) return 'empty';
      return `${document.title}|${body.innerText.length}|${document.querySelectorAll('a,button,input,[role]').length}`;
    });
  } catch {
    return 'unavailable';
  }
}

/**
 * `__name` is a helper esbuild injects when `keepNames` is enabled (the `tsx`
 * dev runner does this; the `tsc` build does not). Define it as an identity
 * function in the page so injected calls are a harmless no-op.
 *
 * This only adds a private no-op to our own automation namespace. It does not
 * change the site's behaviour, data, or progress.
 */
export async function ensureEvalHelpers(context: FrameContext): Promise<void> {
  // Passed as a source string on purpose: a transpiled function would itself
  // reference __name before it could be defined.
  await context
    .evaluate('globalThis.__name = globalThis.__name || function (fn) { return fn; };')
    .catch(() => undefined);
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function configTimeout(config: AppConfig): number {
  return config.timeouts.actionMs;
}
