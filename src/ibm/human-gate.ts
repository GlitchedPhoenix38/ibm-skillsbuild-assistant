import type { Page } from 'playwright-core';
import { logger } from '../utils/logger.js';
import { captureScreenshot } from '../utils/screenshots.js';
import { ensureEvalHelpers } from './dom-utils.js';
import { sleep } from '../utils/retry.js';

export type HumanGateReason = 'login' | 'mfa' | 'captcha' | 'unknown-challenge';

export interface HumanGate {
  readonly reason: HumanGateReason;
  readonly evidence: string;
  readonly blocking: boolean;
}

/**
 * Signals that a human must act. Detected purely from what the page renders -
 * no attempt is ever made to solve, bypass or work around any of these.
 */
const SIGNALS: ReadonlyArray<{
  reason: HumanGateReason;
  blocking: boolean;
  patterns: readonly RegExp[];
}> = [
  {
    reason: 'captcha',
    blocking: true,
    patterns: [
      /recaptcha/i,
      /hcaptcha/i,
      /g-recaptcha/i,
      /are you a (human|robot)/i,
      /verify you are (a )?human/i,
      /press and hold/i,
      /cf-challenge/i,
      /captcha/i,
    ],
  },
  {
    reason: 'mfa',
    blocking: true,
    patterns: [
      /two[- ]factor/i,
      /multi[- ]factor/i,
      /one[- ]time (code|password|passcode)/i,
      /verification code/i,
      /enter the code (we|sent|you)/i,
      /authenticator app/i,
      /id\.ibm\.com\/mfa/i,
    ],
  },
  {
    reason: 'login',
    blocking: true,
    patterns: [
      /sign in to continue/i,
      /log ?in to continue/i,
      /please sign in/i,
      /your session (has )?expired/i,
      /ibm\.com\/account\/login/i,
      /id\.ibm\.com\/login/i,
      /account\.ibm\.com\/login/i,
      /^sign in$/i,
      /^log in$/i,
    ],
  },
  {
    reason: 'unknown-challenge',
    blocking: false,
    patterns: [/verify (that )?you are/i, /complete the (security )?check/i],
  },
];

export async function detectHumanGate(page: Page): Promise<HumanGate | null> {
  await ensureEvalHelpers(page);
  const url = safe(() => page.url(), '');
  const haystack = `${url}\n${await visibleText(page)}`.slice(0, 20_000);

  for (const signal of SIGNALS) {
    for (const pattern of signal.patterns) {
      const match = haystack.match(pattern);
      if (match !== null) {
        return {
          reason: signal.reason,
          evidence: `matched /${pattern.source}/ as "${match[0]}"`,
          blocking: signal.blocking,
        };
      }
    }
  }
  return null;
}

async function visibleText(page: Page): Promise<string> {
  return safeAsync(
    async () =>
      (await page.evaluate(() => {
        const body = document.body;
        return body === null ? '' : (body.innerText ?? '');
      })) ?? '',
    '',
  );
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

async function safeAsync<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export interface HumanGateResult {
  readonly resolved: boolean;
  readonly timedOut: boolean;
  readonly gate: HumanGate | null;
}

/**
 * Pause and wait for the user to complete a human-only step in the visible
 * Brave window. Nothing is typed, submitted or automated here.
 */
export async function waitForHuman(
  page: Page,
  gate: HumanGate,
  timeoutMs: number,
): Promise<HumanGateResult> {
  await captureScreenshot(page, `human-gate-${gate.reason}`);

  const headline = describeGate(gate);
  logger.block([
    '',
    '  ┌────────────────────────────────────────────────────────────────┐',
    '  │  MANUAL ACTION REQUIRED - automation is paused                   │',
    '  └────────────────────────────────────────────────────────────────┘',
    `  ${headline}`,
    `  Evidence: ${gate.evidence}`,
    '',
    '  Please handle it yourself in the Brave window, then wait here.',
    '  This assistant will NOT bypass authentication, MFA or CAPTCHA.',
    '',
  ]);

  if (timeoutMs <= 0) {
    logger.block([
      '  HUMAN_WAIT_TIMEOUT_MS is 0, so the assistant will not keep waiting.',
      '  Fix the page in Brave, then start the assistant again.',
      '',
    ]);
    return { resolved: false, timedOut: true, gate };
  }

  const deadline = Date.now() + timeoutMs;
  let lastReported = 0;
  while (Date.now() < deadline) {
    await sleep(2_000);
    const current = await safeAsync(async () => detectHumanGate(page), null as HumanGate | null);
    if (current === null) {
      logger.success('Gate cleared - continuing.');
      return { resolved: true, timedOut: false, gate: null };
    }
    const remainingSeconds = Math.round((deadline - Date.now()) / 1000);
    if (remainingSeconds - lastReported >= 15 || remainingSeconds <= 5) {
      lastReported = remainingSeconds;
      process.stdout.write(`\r  Still waiting (${remainingSeconds}s left)...   `);
    }
  }
  process.stdout.write('\n');
  logger.block(['  Timed out waiting for manual action.', '']);
  return { resolved: false, timedOut: true, gate };
}

function describeGate(gate: HumanGate): string {
  switch (gate.reason) {
    case 'login':
      return 'IBM sign-in is required (or the session expired).';
    case 'mfa':
      return 'Multi-factor / one-time-code verification is required.';
    case 'captcha':
      return 'A CAPTCHA or bot check is being shown.';
    case 'unknown-challenge':
      return 'An unfamiliar verification step is being shown.';
    default:
      return 'A human-only step is required.';
  }
}

export function formatManualPause(reason: string, details: string): string[] {
  return [
    '',
    '  ┌────────────────────────────────────────────────────────────────┐',
    '  │  PAUSED - needs a human                                        │',
    '  └────────────────────────────────────────────────────────────────┘',
    `  ${reason}`,
    `  ${details}`,
    '  Nothing was clicked or submitted.',
    '',
  ];
}
