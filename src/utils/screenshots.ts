import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Frame, Page } from 'playwright-core';
import { logger } from './logger.js';

export type CaptureTarget = Page | Frame;

let counter = 0;
let configuredDir: string | null = null;

export function configureScreenshotDir(dir: string): void {
  configuredDir = dir;
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error: unknown) {
    logger.warn(`Could not create screenshot directory ${dir}: ${String(error)}`);
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** A Frame has no screenshot(); fall back to the owning page. */
function toPage(target: CaptureTarget): Page | null {
  const candidate = target as unknown as { screenshot?: unknown; page?: () => Page };
  if (typeof candidate.screenshot === 'function') return target as Page;
  if (typeof candidate.page === 'function') {
    const owner = candidate.page();
    return owner ?? null;
  }
  return null;
}

/**
 * Capture a PNG of the current viewport (and a full-page capture when possible).
 * Never throws: screenshots are diagnostics, not a hard requirement.
 */
export async function captureScreenshot(
  target: CaptureTarget | null,
  label: string,
  options: { fullPage?: boolean } = {},
): Promise<string | null> {
  const dir = configuredDir ?? path.join(process.cwd(), 'debug', 'screenshots');
  counter += 1;
  const safeLabel = label.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60);
  const file = path.join(dir, `${String(counter).padStart(3, '0')}-${timestamp()}-${safeLabel}.png`);

  try {
    if (target === null) {
      logger.warn(`Screenshot "${label}" skipped: no page available.`);
      return null;
    }
    const page = toPage(target);
    if (page === null) {
      logger.warn(`Screenshot "${label}" skipped: page is closed.`);
      return null;
    }
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: file, fullPage: options.fullPage ?? false, timeout: 15_000 });
    logger.debug(`Screenshot saved: ${file}`);
    return file;
  } catch (error: unknown) {
    logger.warn(`Screenshot "${label}" failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Screenshot plus the current URL, used whenever a step throws. */
export async function captureError(
  target: CaptureTarget | null,
  label: string,
  error: unknown,
): Promise<string | null> {
  logger.error(`Error while ${label}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  if (target !== null) {
    try {
      logger.error(`Page URL at failure: ${target.url()}`);
    } catch {
      // page may already be closed
    }
  }
  return captureScreenshot(target, `error-${label}`, { fullPage: true });
}
