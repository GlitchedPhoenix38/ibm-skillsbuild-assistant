import type { Frame, Page } from 'playwright-core';
import type { ExtractedQuestion, QuestionOption, QuestionType } from '../ai/provider.js';
import { logger } from '../utils/logger.js';
import {
  ensureEvalHelpers,
  OPTION_ATTR,
  OPTION_SELECTOR_PREFIX,
  type FrameContext,
} from './dom-utils.js';

export type { ExtractedQuestion, QuestionOption, QuestionType };

/** Serializable view of the page used by the in-browser scan. */
interface RawScan {
  readonly found: boolean;
  readonly question: string;
  readonly context: string;
  readonly questionSelector: string;
  readonly options: ReadonlyArray<RawOption>;
  readonly type: QuestionType;
  readonly submitHint: string;
  readonly notes: readonly string[];
}

interface RawOption {
  readonly text: string;
  readonly tag: string;
  readonly role: string;
  readonly inputType: string;
  readonly value: string;
  readonly name: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly hasClickableAncestor: boolean;
  readonly cssPath: string;
  readonly accessibleName: string;
}

/** Ordered strategies for locating answer controls inside the page. */
const OPTION_SELECTOR_STRATEGIES: readonly string[] = [
  // 1. Native form controls
  'form input[type="radio"], form input[type="checkbox"]',
  'input[type="radio"], input[type="checkbox"]',
  // 2. ARIA widgets
  '[role="radio"]',
  '[role="checkbox"]',
  '[role="option"]',
  '[role="menuitemradio"]',
  // 3. Buttons that look like answer cards
  'button[class*="option" i], button[class*="answer" i], button[class*="choice" i]',
  '[class*="answer-option" i], [class*="answerOption" i], [class*="option-card" i]',
  '[data-testid*="option" i], [data-test*="option" i], [data-qa*="option" i]',
  // 4. Generic labels wrapping controls
  'label',
];

const QUESTION_TEXT_PATTERNS: readonly RegExp[] = [
  /question\s*\d+\s*[:.\-–]?\s*/i,
  /^\s*(select|choose|which|what|when|where|who|why|how|true|false)\b/i,
];

/** Anchors that suggest a specific kind of activity. */
const ACTIVITY_TYPE_HINTS: ReadonlyArray<{ type: ActivityTypeHint; patterns: readonly RegExp[] }> = [
  { type: 'quiz', patterns: [/quiz/i, /assessment/i, /graded/i, /final test/i, /exam/i] },
  { type: 'knowledge-check', patterns: [/knowledge check/i, /check your knowledge/i, /knowledge check/i] },
  { type: 'video', patterns: [/video/i, /watch/i] },
  { type: 'reading', patterns: [/reading/i, /article/i, /content/i, /topic/i, /overview/i, /introduction/i] },
  {
    type: 'simulation',
    patterns: [/simulation/i, /lab\b/i, /exercise/i, /interactive/i, /scenario/i, /sandbox/i, /practice/i],
  },
  { type: 'content', patterns: [/lesson/i, /module/i, /page/i, /section/i] },
];

export type ActivityTypeHint =
  | 'quiz'
  | 'knowledge-check'
  | 'video'
  | 'reading'
  | 'simulation'
  | 'content'
  | 'unknown';

/**
 * Scan the page for a question and its answer options.
 *
 * The scan runs inside the page and tags every discovered option with a
 * temporary `data-sba-option` attribute, which gives the caller a stable,
 * unambiguous selector. Tags are cleared after each question by the caller
 * (see clearOptionTags) so the page is left as it was found.
 */
export async function extractQuestion(page: Page | Frame): Promise<ExtractedQuestion | null> {
  const scan = await runScan(page);
  if (!scan.found) {
    logger.debug('extractQuestion: no question found on the current view.');
    return null;
  }

  const options: QuestionOption[] = scan.options.map((option, index) => ({
    text: option.text.trim(),
    selector: `${OPTION_SELECTOR_PREFIX}${index + 1}"]`,
    role: option.role !== '' ? option.role : undefined,
    name: option.accessibleName !== '' ? option.accessibleName : undefined,
    nativeInput: option.inputType === 'radio' || option.inputType === 'checkbox',
    value: option.value !== '' ? option.value : undefined,
  }));

  const type = scan.type;
  const fingerprint = fingerprintOf(scan.question, options.map((option) => option.text));

  logger.debug(
    `extractQuestion: type=${type} options=${options.length} question="${scan.question.slice(0, 80)}"`,
  );

  return {
    question: scan.question,
    options,
    type,
    context: scan.context !== '' ? scan.context : undefined,
    fingerprint,
  };
}

function fingerprintOf(question: string, options: readonly string[]): string {
  const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `${normalize(question)}::${options.map(normalize).join('|')}`.slice(0, 400);
}

async function runScan(page: Page | Frame): Promise<RawScan> {
  await ensureEvalHelpers(page);
  return page.evaluate(
    ({ strategies, attr, questionPatterns, multiHints }) => {
      const text = (node: Element | null | undefined): string =>
        (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

      const isVisible = (node: Element): boolean => {
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(node);
        return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
      };

      const accessibleName = (node: Element): string => {
        const aria = node.getAttribute('aria-label');
        if (aria !== null && aria.trim() !== '') return aria.trim();
        const labelledBy = node.getAttribute('aria-labelledby');
        if (labelledBy !== null) {
          const parts = labelledBy
            .split(/\s+/)
            .map((id) => text(document.getElementById(id)))
            .filter((part) => part !== '');
          if (parts.length > 0) return parts.join(' ');
        }
        return text(node);
      };

      const cssPath = (node: Element): string => {
        if (node.id !== '') return `#${CSS.escape(node.id)}`;
        const parts: string[] = [];
        let current: Element | null = node;
        let depth = 0;
        while (current !== null && current !== document.body && depth < 6) {
          let part = current.tagName.toLowerCase();
          const testId =
            current.getAttribute('data-testid') ??
            current.getAttribute('data-test') ??
            current.getAttribute('data-qa');
          if (testId !== null && testId !== '') {
            parts.unshift(`${part}[data-testid="${testId}"]`);
            break;
          }
          if (current.id !== '') {
            parts.unshift(`#${CSS.escape(current.id)}`);
            break;
          }
          const parent: Element | null = current.parentElement;
          if (parent !== null) {
            const siblings = Array.from(parent.children).filter(
              (child) => child.tagName === current?.tagName,
            );
            if (siblings.length > 1) {
              part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
            }
          }
          parts.unshift(part);
          current = current.parentElement;
          depth += 1;
        }
        return parts.join(' > ');
      };

      const clearTags = (): void => {
        document.querySelectorAll(`[${attr}]`).forEach((node) => node.removeAttribute(attr));
      };
      clearTags();

      // ---------------------------------------------------------------- locate options
      interface Candidate {
        node: Element;
        labelNode: Element;
        inputType: string;
        value: string;
        name: string;
        checked: boolean;
        disabled: boolean;
        role: string;
      }

      const candidates: Candidate[] = [];
      const seen = new Set<Element>();
      const push = (
        node: Element,
        labelNode: Element,
        inputType: string,
        value: string,
        name: string,
        checked: boolean,
        disabled: boolean,
        role: string,
      ): void => {
        if (seen.has(node)) return;
        seen.add(node);
        candidates.push({ node, labelNode, inputType, value, name, checked, disabled, role });
      };

      let usedStrategy = 'none';
      for (const strategy of strategies) {
        candidates.length = 0;
        seen.clear();
        const matches = Array.from(document.querySelectorAll(strategy));
        const visibleMatches = matches.filter(isVisible);

        for (const control of visibleMatches) {
          const tag = control.tagName.toLowerCase();
          if (tag === 'input') {
            const inputType = (control.getAttribute('type') ?? 'text').toLowerCase();
            const id = control.getAttribute('id');
            const explicitLabel =
              id !== null ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
            const wrappingLabel = control.closest('label');
            const labelNode = explicitLabel ?? wrappingLabel ?? control.parentElement ?? control;
            push(
              control,
              labelNode,
              inputType,
              control.getAttribute('value') ?? '',
              control.getAttribute('name') ?? '',
              (control as HTMLInputElement).checked === true,
              (control as HTMLInputElement).disabled === true,
              '',
            );
          } else if (tag === 'button' || control.getAttribute('role') !== null) {
            const role = control.getAttribute('role') ?? '';
            const inputType = role === 'checkbox' ? 'checkbox' : role === 'radio' ? 'radio' : '';
            push(
              control,
              control,
              inputType,
              control.getAttribute('value') ?? '',
              control.getAttribute('name') ?? '',
              control.getAttribute('aria-checked') === 'true' || control.getAttribute('aria-selected') === 'true',
              (control as HTMLButtonElement).disabled === true || control.getAttribute('aria-disabled') === 'true',
              role,
            );
          } else {
            // label elements
            const nested = control.querySelector('input[type="radio"], input[type="checkbox"]');
            const inputType = nested === null ? 'label' : ((nested.getAttribute('type') ?? '').toLowerCase());
            const disabled = nested === null ? control.getAttribute('aria-disabled') === 'true' : (nested as HTMLInputElement).disabled;
            const checked = nested === null ? control.getAttribute('aria-checked') === 'true' : (nested as HTMLInputElement).checked;
            push(
              nested ?? control,
              control,
              inputType,
              nested?.getAttribute('value') ?? '',
              nested?.getAttribute('name') ?? '',
              checked,
              disabled,
              control.getAttribute('role') ?? '',
            );
          }
        }

        if (candidates.length >= 2) {
          usedStrategy = strategy;
          break;
        }
      }

      if (candidates.length < 2) {
        return {
          found: false,
          question: '',
          context: '',
          questionSelector: '',
          options: [],
          type: 'unknown',
          submitHint: '',
          notes: ['No set of 2+ answer controls matched any known strategy.'],
        };
      }

      // ------------------------------------------------- drop disabled/empty ones
      const usable = candidates.filter(
        (candidate) => !candidate.disabled && text(candidate.labelNode) !== '',
      );
      const finalCandidates = usable.length >= 2 ? usable : candidates;

      // ------------------------------------------------------------- tag & describe
      finalCandidates.forEach((candidate, index) => {
        candidate.node.setAttribute(attr, String(index + 1));
      });

      const options: Array<{
        text: string;
        tag: string;
        role: string;
        inputType: string;
        value: string;
        name: string;
        checked: boolean;
        disabled: boolean;
        hasClickableAncestor: boolean;
        cssPath: string;
        accessibleName: string;
      }> = finalCandidates.map((candidate) => {
        const clickableAncestor =
          candidate.node.tagName.toLowerCase() === 'input' ? candidate.labelNode : candidate.node;
        return {
          text: text(candidate.labelNode).slice(0, 400),
          tag: candidate.node.tagName.toLowerCase(),
          role: candidate.role,
          inputType: candidate.inputType,
          value: candidate.value,
          name: candidate.name,
          checked: candidate.checked,
          disabled: candidate.disabled,
          hasClickableAncestor: clickableAncestor !== candidate.node,
          cssPath: cssPath(candidate.node),
          accessibleName: accessibleName(candidate.labelNode).slice(0, 400),
        };
      });

      // ------------------------------------------------------------ locate question
      const container =
        finalCandidates[0]?.node.closest('form, fieldset, section, article, [role="group"], main, body') ??
        document.body;

      const questionSelector = locateQuestionText(container, questionPatterns, multiHints);
      const contextText = buildContext(questionSelector, finalCandidates[0]?.node ?? null, multiHints);

      // ------------------------------------------------------------------- typing
      const allCheckboxes = options.every((option) => option.inputType === 'checkbox');
      const allRadios = options.every((option) => option.inputType === 'radio');
      const questionAndContext = `${questionSelector} ${contextText}`;
      const saysMulti = multiHints.some((hint) => new RegExp(hint, 'i').test(questionAndContext));
      const twoOptions =
        options.length === 2 &&
        /^(true|false|yes|no|correct|incorrect)$/i.test(options[0]?.text ?? '') &&
        /^(true|false|yes|no|correct|incorrect)$/i.test(options[1]?.text ?? '');

      let type: 'single' | 'multiple' | 'true-false' | 'unknown' = 'unknown';
      if (twoOptions) type = 'true-false';
      else if (allCheckboxes || saysMulti) type = 'multiple';
      else if (allRadios) type = 'single';
      else if (options.length >= 2) type = 'single';

      // --------------------------------------------------------- submit control
      const submitHint = findSubmitLabel();

      return {
        found: true,
        question: questionSelector,
        context: contextText,
        questionSelector: '',
        options,
        type,
        submitHint,
        notes: [`strategy=${usedStrategy}`, `container=${container?.tagName.toLowerCase() ?? 'none'}`],
      };

      function locateQuestionText(
        scope: Element,
        patterns: readonly string[],
        hints: readonly string[],
      ): string {
        const headingLike = Array.from(
          scope.querySelectorAll(
            'legend, [role="heading"], h1, h2, h3, h4, [class*="question" i], [class*="prompt" i], [id*="question" i]',
          ),
        ).filter(isVisible);

        const scored = headingLike
          .map((node) => ({ node, value: text(node) }))
          .filter((entry) => entry.value.length > 8 && entry.value.length < 1200)
          .map((entry) => {
            let score = entry.value.length;
            if (patterns.some((pattern) => new RegExp(pattern).test(entry.value))) score += 400;
            if (hints.some((hint) => new RegExp(hint, 'i').test(entry.value))) score += 250;
            const tag = entry.node.tagName.toLowerCase();
            if (tag === 'legend') score += 200;
            if (entry.node.getAttribute('role') === 'heading') score += 150;
            if (tag === 'h1') score += 120;
            if (tag === 'h2') score += 60;
            if (/[?]$/.test(entry.value)) score += 200;
            return { ...entry, score };
          })
          .sort((a, b) => b.score - a.score);

        const best = scored[0];
        if (best !== undefined && best.score >= 100) return best.value;

        // Fallback: the largest visible text block above the first option.
        const firstOption = finalCandidates[0]?.node;
        if (firstOption !== undefined) {
          const blocks = Array.from(
            document.querySelectorAll('p, div, span, strong, b, li'),
          ).filter((node) => {
            if (!isVisible(node)) return false;
            const value = text(node);
            if (value.length < 10 || value.length > 1000) return false;
            if (node.querySelector('p, div, span, li') !== null) return false;
            const rect = node.getBoundingClientRect();
            const firstRect = firstOption.getBoundingClientRect();
            return rect.bottom <= firstRect.top + 4;
          });
          const largest = blocks.sort((a, b) => text(b).length - text(a).length)[0];
          if (largest !== undefined) return text(largest);
        }
        return best?.value ?? '';
      }

      function buildContext(questionNode: string, firstOption: Element | null, hints: readonly string[]): string {
        const parts: string[] = [];
        const heading = document.querySelector('h1, [role="heading"][aria-level="1"]');
        const headingText = text(heading);
        if (headingText !== '' && headingText !== questionNode) parts.push(`Activity: ${headingText}`);

        if (firstOption !== null) {
          const container = firstOption.closest('form, fieldset, section, article, [role="group"]');
          if (container !== null) {
            const instructions = Array.from(container.querySelectorAll('p, [class*="instruction" i], [class*="hint" i]'))
              .filter(isVisible)
              .map(text)
              .filter((value) => value.length > 4 && value.length < 400)
              .filter((value) => value !== questionNode);
            parts.push(...instructions.slice(0, 4));
          }
        }

        const bodyText = text(document.body).slice(0, 4000);
        for (const hint of hints) {
          const match = bodyText.match(new RegExp(hint, 'i'));
          if (match !== null) parts.push(match[0]);
        }
        return [...new Set(parts)].join(' ').slice(0, 600);
      }

      function findSubmitLabel(): string {
        const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]'))
          .filter(isVisible)
          .filter((node) => !(node as HTMLButtonElement).disabled)
          .map((node) => text(node) || (node as HTMLInputElement).value || '')
          .map((value) => value.trim())
          .filter((value) => value.length > 0 && value.length < 60);
        return buttons[0] ?? '';
      }
    },
    {
      strategies: OPTION_SELECTOR_STRATEGIES,
      attr: OPTION_ATTR,
      questionPatterns: QUESTION_TEXT_PATTERNS.map((pattern) => pattern.source),
      multiHints: ['select all that apply', 'select all', 'choose all', 'check all that apply', 'multiple answers'],
    },
  );
}

/**
 * Coarse activity classification for the current view. Used to decide whether
 * question extraction even makes sense, and to print an honest message when an
 * activity is not something we can complete automatically.
 */
export async function detectActivityType(page: Page | Frame): Promise<ActivityTypeHint> {
  const context: FrameContext = page;
  const hints: string = await context
    .evaluate(() => {
      const parts: string[] = [];
      const add = (value: string | null | undefined): void => {
        if (typeof value === 'string' && value.trim() !== '') parts.push(value.trim());
      };
      add(document.title);
      const heading = document.querySelector('h1, [role="heading"][aria-level="1"], h2');
      add(heading?.textContent ?? '');
      const breadcrumb = document.querySelector('[class*="breadcrumb" i], nav[aria-label*="breadcrumb" i]');
      add(breadcrumb?.textContent ?? '');
      const url = window.location.href;
      add(url);
      const body = document.body?.innerText ?? '';
      add(body.slice(0, 2500));
      return parts.join('\n').slice(0, 6000);
    })
    .catch(() => '');

  const haystack = `${hints}`;
  let best: { type: ActivityTypeHint; score: number } = { type: 'unknown', score: 0 };
  for (const hint of ACTIVITY_TYPE_HINTS) {
    let score = 0;
    for (const pattern of hint.patterns) {
      if (pattern.test(haystack)) score += 1;
    }
    if (score > best.score) best = { type: hint.type, score };
  }
  return best.type;
}
