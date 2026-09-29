import type { Page } from 'playwright-core';
import type { Frame } from 'playwright-core';
import { logger } from '../utils/logger.js';
import { captureScreenshot } from '../utils/screenshots.js';
import { retry, sleep } from '../utils/retry.js';
import { ensureEvalHelpers, isEnabled, isVisible, safeClick, type FrameContext } from './dom-utils.js';

export type CourseStatus = 'complete' | 'in-progress' | 'not-started' | 'unknown';

export interface PlanCourse {
  readonly name: string;
  readonly status: CourseStatus;
  readonly progressPercent: number | null;
  readonly linkText: string;
  readonly index: number;
  readonly href: string | null;
}

export interface LearningPlanSnapshot {
  readonly url: string;
  readonly planName: string;
  readonly courses: readonly PlanCourse[];
  readonly rawText: string;
}

/** The seven courses in the Web Development Fundamentals plan. */
export const KNOWN_COURSE_NAMES: readonly string[] = [
  'Web Development Basics',
  'Developing Sites for the Web',
  'Introduction to HTML and CSS',
  'Bringing Websites to Life with JavaScript',
  'Website Testing and Deployment',
  'Develop an Interactive Task List Web Page',
  'Your Future in Web Development',
];

const STATUS_TEXT: ReadonlyArray<{ pattern: RegExp; status: CourseStatus }> = [
  { pattern: /\bcompleted\b|\bfinished\b|\bpassed\b|\b100\s*%/i, status: 'complete' },
  { pattern: /\bin progress\b|\bin[- ]progress\b|\bstarted\b|\bnot started\b/i, status: 'in-progress' },
  { pattern: /\bnot started\b|\bavailable\b|\bup next\b|\bnot yet\b/i, status: 'not-started' },
];

/**
 * Extract the plan title and each required course with its live status.
 *
 * This is intentionally structure-agnostic: rather than hard-coding IBM's class
 * names, it looks for the seven known course titles anywhere on the page, then
 * reads the percentage / status text from the same "card" region.
 */
export async function readLearningPlan(
  page: Page | Frame,
  planUrl: string,
): Promise<LearningPlanSnapshot> {
  const context: FrameContext = page;
  await ensureEvalHelpers(context);

  await ensurePlanLoaded(context, planUrl);

  const data = await context.evaluate(
    ({ knownNames }): {
      planName: string;
      rawText: string;
      found: Array<{
        name: string;
        blockText: string;
        anchorText: string;
        href: string | null;
        percent: number | null;
      }>;
    } => {
      const norm = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const text = (node: Element | null | undefined): string =>
        (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
      const isVisible = (node: Element): boolean => {
        const rect = node.getBoundingClientRect();
        if (rect.width <= 1 || rect.height <= 1) return false;
        const style = window.getComputedStyle(node);
        return style.visibility !== 'hidden' && style.display !== 'none';
      };

      const planHeading =
        document.querySelector('h1, [role="heading"][aria-level="1"]')?.textContent?.trim() ?? '';
      const rawText = (document.body?.innerText ?? '').slice(0, 40_000);

      // Search every leaf-ish element for each known course name, then walk up
      // to the enclosing "card" so we can read the status that lives nearby.
      const allTextNodes = Array.from(
        document.querySelectorAll('a, button, h1, h2, h3, h4, h5, span, p, li, div'),
      ).filter((node) => node.children.length <= 2 && isVisible(node));

      const found: Array<{
        name: string;
        blockText: string;
        anchorText: string;
        href: string | null;
        percent: number | null;
      }> = [];
      const matchedText = new Set<string>();

      for (const target of knownNames) {
        const targetNorm = norm(target);
        const match = allTextNodes.find((node) => {
          const value = norm(text(node));
          if (value === '' || matchedText.has(value)) return false;
          const isPrefix = value === targetNorm || value.startsWith(`${targetNorm} `) || value.includes(targetNorm);
          return isPrefix;
        });

        if (match === undefined) continue;
        matchedText.add(norm(text(match)));

        // Walk up to a bounded ancestor that looks like a card/row.
        let block: Element = match;
        let depth = 0;
        while (depth < 5) {
          const candidate = block.parentElement;
          if (candidate === null || candidate === document.body) break;
          const candidateText = text(candidate);
          // A good card holds the course name plus a status and is not huge.
          const hasOtherCourse = knownNames.some(
            (other) => other !== target && norm(candidateText).includes(norm(other)),
          );
          if (hasOtherCourse) break;
          block = candidate;
          if (candidateText.length > 600) break;
          depth += 1;
        }

        const blockText = text(block);
        const percentMatch = blockText.match(/(\d{1,3})\s*%/);
        const anchor = match.closest('a') ?? (match instanceof HTMLAnchorElement ? match : null);
        const href = anchor?.getAttribute('href') ?? null;

        found.push({
          name: text(match) || target,
          blockText: blockText.slice(0, 500),
          anchorText: text(match).slice(0, 200),
          href,
          percent: percentMatch !== null && percentMatch[1] !== undefined ? Number(percentMatch[1]) : null,
        });
      }

      // Fallback: if text matching fails, rely on any course-like anchors.
      if (found.length === 0) {
        const anchors = Array.from(document.querySelectorAll('a'))
          .filter(isVisible)
          .filter((a) => (a.getAttribute('href') ?? '').includes('/course/') || (a.getAttribute('href') ?? '').includes('/activity/'));
        for (const anchor of anchors) {
          const block = anchor.closest('li, article, section, div') ?? anchor;
          const blockText = text(block);
          const percentMatch = blockText.match(/(\d{1,3})\s*%/);
          found.push({
            name: text(anchor) || 'Unknown course',
            blockText: blockText.slice(0, 500),
            anchorText: text(anchor).slice(0, 200),
            href: anchor.getAttribute('href'),
            percent: percentMatch !== null && percentMatch[1] !== undefined ? Number(percentMatch[1]) : null,
          });
        }
      }

      return { planName: planHeading, rawText, found };
    },
    { knownNames: KNOWN_COURSE_NAMES },
  );

  const courses: PlanCourse[] = data.found.map((entry, index) => ({
    name: entry.name,
    status: deriveStatus(entry.blockText, entry.percent),
    progressPercent: entry.percent,
    linkText: entry.anchorText,
    index,
    href: entry.href,
  }));

  return {
    url: context.url(),
    planName: data.planName !== '' ? data.planName : 'Web Development Fundamentals',
    courses,
    rawText: data.rawText,
  };
}

function deriveStatus(blockText: string, percent: number | null): CourseStatus {
  if (percent !== null && percent >= 100) return 'complete';
  for (const entry of STATUS_TEXT) {
    if (entry.pattern.test(blockText)) {
      // "not started" also matches /started/; disambiguate explicitly.
      if (/not started/i.test(blockText) && entry.status === 'in-progress') continue;
      return entry.status;
    }
  }
  if (percent !== null && percent > 0) return 'in-progress';
  return 'unknown';
}

async function ensurePlanLoaded(context: FrameContext, planUrl: string): Promise<void> {
  const current = context.url();
  if (!current.includes('skills.yourlearning.ibm.com') && current !== 'about:blank') {
    logger.debug(`Not on SkillsBuild yet (${current}); navigating to plan.`);
  }

  await retry(
    async () => {
      await context.goto(planUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {
        logger.warn('goto reported an error but the page may still have loaded; continuing.');
      });
      await sleep(1500);
    },
    { attempts: 2, baseDelayMs: 1500, label: 'load learning plan' },
  );

  // Wait for something plan-like to render.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const count = await context
      .getByText(/web development basics|developing sites for the web|introduction to html/i)
      .count()
      .catch(() => 0);
    if (count > 0) return;
    await sleep(1000);
  }
  logger.warn('Course titles did not appear within ~20s. The page may still be loading, or the UI may have changed.');
  await captureScreenshot(context, 'plan-not-loaded', { fullPage: true });
}

/** Click a course by name from the plan page. */
export async function openCourse(
  page: Page | Frame,
  courseName: string,
): Promise<{ opened: boolean; reason: string }> {
  const context: FrameContext = page;
  const matchers = [
    context.getByRole('link', { name: courseName, exact: false }),
    context.getByRole('button', { name: courseName, exact: false }),
    context.getByText(courseName, { exact: false }),
  ];

  for (const matcher of matchers) {
    const count = await matcher.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const target = matcher.nth(i);
      if (!(await isVisible(target)) || !(await isEnabled(target))) continue;
      const result = await safeClick(target, `course "${courseName}"`, { frame: context });
      if (result.clicked) {
        await sleep(2000);
        return { opened: true, reason: 'clicked' };
      }
    }
  }

  // Anchor fallback.
  const byRole = context.locator(`a:has-text("${courseName.replace(/"/g, '\\"')}")`).first();
  if ((await byRole.count()) > 0) {
    const result = await safeClick(byRole, `course anchor "${courseName}"`, { frame: context });
    if (result.clicked) {
      await sleep(2000);
      return { opened: true, reason: 'clicked anchor' };
    }
  }

  return { opened: false, reason: `could not find/click "${courseName}"` };
}
