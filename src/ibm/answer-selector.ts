import type { Frame, Page } from 'playwright-core';
import type { AiAnswer, ExtractedQuestion, QuestionOption } from '../ai/provider.js';
import { logger } from '../utils/logger.js';
import { captureScreenshot } from '../utils/screenshots.js';
import { sleep } from '../utils/retry.js';
import { clearOptionTags, ensureEvalHelpers, isEnabled, isVisible, safeClick, type FrameContext } from './dom-utils.js';

export interface SelectOutcome {
  readonly selected: readonly number[];
  readonly failed: readonly number[];
  readonly alreadySelected: readonly number[];
}

const SUBMIT_LABELS: readonly string[] = [
  'submit',
  'check answer',
  'check my answer',
  'check',
  'next',
  'continue',
  'save and continue',
  'confirm',
  'done',
  'ok',
  'yes, submit',
  'submit answer',
  'finish',
];

const REJECT_PATTERNS: readonly RegExp[] = [
  /incorrect answer/i,
  /that'?s not correct/i,
  /not correct/i,
  /wrong answer/i,
  /try again/i,
  /incorrect\./i,
  /answer is wrong/i,
  /you have \d+ attempt/i,
  /did not get it right/i,
  /not quite/i,
  /incorrect\s*answer\s*[:.]/i,
];

const ACCEPT_PATTERNS: readonly RegExp[] = [
  /correct answer/i,
  /that'?s correct/i,
  /correct!/i,
  /well done/i,
  /nice work/i,
  /congratulations/i,
  /you got it right/i,
  /answer is correct/i,
  /correct\s*[:.]/i,
];

/**
 * Map a validated AI answer onto the real page elements.
 *
 * Hard rules enforced here:
 *  - never click when DRY_RUN is enabled
 *  - never click an index that does not correspond to a real visible option
 *  - never use fixed coordinates
 */
export async function selectAnswers(
  page: Page | Frame,
  question: ExtractedQuestion,
  answer: AiAnswer,
  options: { dryRun: boolean },
): Promise<SelectOutcome> {
  const frame: FrameContext = page;
  const valid = answer.answers.filter(
    (index) => index >= 1 && index <= question.options.length,
  );

  if (valid.length !== answer.answers.length) {
    logger.warn(
      `AI returned ${answer.answers.length} option number(s); ${valid.length} are actually on the page. Ignoring the rest.`,
    );
  }
  if (valid.length === 0) {
    return { selected: [], failed: [], alreadySelected: [] };
  }

  if (options.dryRun) {
    logger.raw('  (DRY_RUN: nothing was clicked)');
    return { selected: [], failed: [], alreadySelected: [] };
  }

  const selected: number[] = [];
  const failed: number[] = [];
  const already: number[] = [];

  for (const index of valid) {
    const option = question.options[index - 1];
    if (option === undefined) {
      failed.push(index);
      continue;
    }
    const outcome = await selectOneOption(frame, option, index);
    if (outcome === 'selected') selected.push(index);
    else if (outcome === 'already') already.push(index);
    else failed.push(index);
    await sleep(180);
  }

  return { selected, failed, alreadySelected: already };
}

async function selectOneOption(
  frame: FrameContext,
  option: QuestionOption,
  index: number,
): Promise<'selected' | 'already' | 'failed'> {
  const shortText = option.text.slice(0, 60);

  // 1. Tag-based locator (set by extractQuestion) - most reliable.
  const tagged = frame.locator(option.selector);
  if ((await tagged.count()) === 1) {
    const state = await controlState(tagged);
    if (state === 'checked') {
      logger.raw(`  ${index}. ${shortText}  (already selected)`);
      return 'already';
    }
    const result = await safeClick(tagged, `option ${index} (${shortText})`, {
      frame,
      screenshotOnFailure: true,
    });
    if (result.clicked) {
      await sleep(200);
      if (await isNowChecked(tagged, option.nativeInput)) {
        logger.raw(`  ${index}. ${shortText}  ✓ selected`);
        return 'selected';
      }
      // Some UIs need the label/parent clicked instead.
      const fallback = await clickAssociatedLabel(frame, tagged, `option ${index} label`);
      if (fallback) {
        logger.raw(`  ${index}. ${shortText}  ✓ selected (via label)`);
        return 'selected';
      }
      logger.warn(`  ${index}. ${shortText}  click registered but control is not checked`);
      return 'failed';
    }
    logger.fail(`  ${index}. ${shortText}  could not select (${result.reason})`);
    return 'failed';
  }

  // 2. Re-discover by accessible name / text.
  const reDiscovered = await reLocateOption(frame, option);
  if (reDiscovered !== null) {
    const result = await safeClick(reDiscovered, `option ${index} re-located (${shortText})`, { frame });
    if (result.clicked) {
      logger.raw(`  ${index}. ${shortText}  ✓ selected (re-located)`);
      return 'selected';
    }
  }

  // 3. Text-based fallback, scoped to the options container.
  const byText = await locateByText(frame, option.text, index);
  if (byText !== null) {
    const result = await safeClick(byText, `option ${index} by text (${shortText})`, { frame });
    if (result.clicked) {
      logger.raw(`  ${index}. ${shortText}  ✓ selected (by text)`);
      return 'selected';
    }
  }

  await captureScreenshot(frame, `option-${index}-not-found`, { fullPage: false });
  logger.fail(`  ${index}. ${shortText}  could not locate this option at all`);
  return 'failed';
}

async function controlState(locator: ReturnType<FrameContext['locator']>): Promise<'checked' | 'unchecked' | 'na'> {
  return locator.evaluate((node: Element) => {
    if (node instanceof HTMLInputElement) return node.checked ? 'checked' : 'unchecked';
    const checked = node.getAttribute('aria-checked') ?? node.getAttribute('aria-selected');
    if (checked === 'true') return 'checked';
    if (checked === 'false') return 'unchecked';
    return 'na';
  });
}

async function isNowChecked(
  locator: ReturnType<FrameContext['locator']>,
  nativeInput: boolean,
): Promise<boolean> {
  if (!nativeInput) {
    const className = await locator.evaluate((node: Element) => node.className).catch(() => '');
    return typeof className === 'string' && /checked|selected|active/i.test(className);
  }
  return (await controlState(locator)) === 'checked';
}

async function clickAssociatedLabel(
  frame: FrameContext,
  control: ReturnType<FrameContext['locator']>,
  description: string,
): Promise<boolean> {
  const label = control.locator('xpath=ancestor::label[1]');
  if ((await label.count()) === 1) {
    const result = await safeClick(label, description, { frame });
    if (result.clicked) return true;
  }
  const id = await control.getAttribute('id').catch(() => null);
  if (id !== null && id !== '') {
    const forLabel = frame.locator(`label[for="${id.replace(/"/g, '\\"')}"]`);
    if ((await forLabel.count()) === 1) {
      const result = await safeClick(forLabel, `${description} [for]`, { frame });
      if (result.clicked) return true;
    }
  }
  return false;
}

async function reLocateOption(
  frame: FrameContext,
  option: QuestionOption,
): Promise<ReturnType<FrameContext['locator']> | null> {
  const name = option.name ?? option.text;
  const strategies: Array<ReturnType<FrameContext['locator']>> = [];

  if (option.role !== undefined && option.role !== '') {
    strategies.push(frame.getByRole(option.role as Parameters<FrameContext['getByRole']>[0], { name, exact: false }));
  }
  strategies.push(frame.getByRole('radio', { name, exact: false }));
  strategies.push(frame.getByRole('checkbox', { name, exact: false }));
  strategies.push(frame.getByRole('button', { name, exact: false }));
  strategies.push(frame.getByLabel(name, { exact: false }));

  for (const strategy of strategies) {
    try {
      if ((await strategy.count()) === 1 && (await isVisible(strategy)) && (await isEnabled(strategy))) {
        return strategy;
      }
    } catch {
      // role may not exist on this Playwright version's union; try the next one
    }
  }
  return null;
}

async function locateByText(
  frame: FrameContext,
  text: string,
  index: number,
): Promise<ReturnType<FrameContext['locator']> | null> {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.length > 300) return null;

  const candidates = [
    frame.getByText(trimmed, { exact: true }),
    frame.getByText(trimmed, { exact: false }),
  ];

  for (const candidate of candidates) {
    const count = await candidate.count().catch(() => 0);
    if (count === 1) {
      const target = candidate.first();
      if (await isVisible(target)) return target;
    }
  }

  // Many options share short text ("True", "1", "A"), so use the Nth match of
  // the exact text as a last resort.
  const exact = frame.getByText(trimmed, { exact: true });
  const count = await exact.count().catch(() => 0);
  if (count >= index) {
    const target = exact.nth(index - 1);
    if (await isVisible(target)) return target;
  }
  return null;
}

export interface SubmitOutcome {
  readonly submitted: boolean;
  readonly accepted: boolean;
  readonly rejected: boolean;
  readonly feedback: string;
  readonly reason: string;
  readonly buttonLabel: string;
}

/** Find and click a Submit / Check / Next style control by accessible name. */
export async function findSubmitControl(
  frame: FrameContext,
): Promise<{ locator: ReturnType<FrameContext['locator']>; label: string } | null> {
  for (const label of SUBMIT_LABELS) {
    const candidates = [
      frame.getByRole('button', { name: label, exact: false }),
      frame.getByRole('link', { name: label, exact: false }),
    ];
    for (const candidate of candidates) {
      const count = await candidate.count().catch(() => 0);
      if (count === 0) continue;
      for (let i = 0; i < count; i += 1) {
        const locator = candidate.nth(i);
        if ((await isVisible(locator)) && (await isEnabled(locator))) {
          return { locator, label };
        }
      }
    }
  }
  return null;
}

export async function submitAnswer(frame: FrameContext, options: { dryRun: boolean }): Promise<SubmitOutcome> {
  const none: SubmitOutcome = {
    submitted: false,
    accepted: false,
    rejected: false,
    feedback: '',
    reason: 'no submit/check/next control found',
    buttonLabel: '',
  };

  const control = await findSubmitControl(frame);
  if (control === null) return none;

  if (options.dryRun) {
    return { ...none, buttonLabel: control.label, reason: 'DRY_RUN: submit not clicked' };
  }

  const result = await safeClick(control.locator, `"${control.label}" button`, { frame, screenshotOnFailure: true });
  if (!result.clicked) {
    return { ...none, buttonLabel: control.label, reason: result.reason };
  }
  logger.raw(`  ✓ Clicked "${control.label}"`);
  return {
    submitted: true,
    accepted: false,
    rejected: false,
    feedback: '',
    reason: 'clicked',
    buttonLabel: control.label,
  };
}

/** Read the site's own verdict from the page. */
export async function detectResult(
  frame: FrameContext,
  beforeSnapshot: string,
): Promise<{ accepted: boolean; rejected: boolean; feedback: string }> {
  await sleep(400);
  const snapshot = await readRelevantText(frame);
  const delta = snapshot.replace(beforeSnapshot, '').trim();

  const acceptMatch = firstMatch(delta, ACCEPT_PATTERNS);
  const rejectMatch = firstMatch(delta, REJECT_PATTERNS);

  if (rejectMatch !== null) return { accepted: false, rejected: true, feedback: extractFeedback(delta) };
  if (acceptMatch !== null) return { accepted: true, rejected: false, feedback: extractFeedback(delta) };
  return { accepted: false, rejected: false, feedback: extractFeedback(delta) };
}

export async function readRelevantText(frame: FrameContext): Promise<string> {
  await ensureEvalHelpers(frame);
  return frame
    .evaluate(() => {
      const selectors = [
        '[class*="feedback" i]',
        '[class*="alert" i]',
        '[class*="result" i]',
        '[class*="message" i]',
        '[class*="notification" i]',
        '[role="alert"]',
        '[aria-live="assertive"]',
        '[aria-live="polite"]',
      ];
      const parts: string[] = [];
      const seen = new Set<Element>();
      for (const selector of selectors) {
        for (const node of document.querySelectorAll(selector)) {
          if (seen.has(node)) continue;
          seen.add(node);
          const value = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (value !== '' && value.length < 1500) parts.push(value);
        }
      }
      return parts.join(' \n');
    })
    .catch(() => '');
}

function firstMatch(text: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match !== null) return match[0];
  }
  return null;
}

function extractFeedback(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > 400 ? `${cleaned.slice(0, 400)}...` : cleaned;
}

export async function finishQuestionCycle(page: Page | Frame): Promise<void> {
  await clearOptionTags(page);
}
