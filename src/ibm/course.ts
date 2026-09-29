import type { Page } from 'playwright-core';
import type { AiProvider } from '../ai/provider.js';
import type { AppConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { captureScreenshot } from '../utils/screenshots.js';
import { sleep } from '../utils/retry.js';
import { describePage, type FrameContext } from './dom-utils.js';
import { detectHumanGate, waitForHuman } from './human-gate.js';
import { detectActivity, goToNextActivity, waitForVideoCompletion } from './activity-detector.js';
import { extractQuestion } from './question-extractor.js';
import {
  detectResult,
  finishQuestionCycle,
  readRelevantText,
  selectAnswers,
  submitAnswer,
} from './answer-selector.js';
import { openCourse, readLearningPlan, type PlanCourse } from './learning-plan.js';
import { saveProgress, updateCourseProgress } from './progress.js';

export type RunOutcome = 'completed' | 'paused-manual' | 'stopped-limit' | 'error';

export interface RunSummary {
  readonly outcome: RunOutcome;
  readonly questionsAnswered: number;
  readonly note: string;
}

/**
 * Pick the course that most needs attention: first incomplete course, in plan
 * order. Progress always comes from the live page, never from a cached guess.
 */
export function chooseNextCourse(courses: readonly PlanCourse[]): PlanCourse | null {
  const incomplete = courses.filter(
    (course) => course.status !== 'complete' && !(course.progressPercent !== null && course.progressPercent >= 100),
  );
  return incomplete[0] ?? null;
}

/** Locate the frame that actually contains the lesson content. */
async function findContentFrame(page: Page): Promise<FrameContext> {
  const frames = page.frames();
  if (frames.length <= 1) return page;

  for (const frame of frames) {
    if (frame === page.mainFrame()) continue;
    try {
      const hasControls = await frame
        .locator('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], [role="option"]')
        .count();
      const hasVideo = await frame.locator('video').count();
      if (hasControls > 0 || hasVideo > 0) {
        logger.debug(`Content detected in subframe: ${frame.url()}`);
        return frame;
      }
    } catch {
      // frame may be detached
    }
  }
  return page;
}

export class CourseRunner {
  private questionsAnswered = 0;

  constructor(
    private readonly page: Page,
    private readonly config: AppConfig,
    private readonly provider: AiProvider,
  ) {}

  async run(): Promise<RunSummary> {
    const url = this.page.url();
    if (/skillsbuild|yourlearning|ibm\.com/i.test(url)) {
      const gate = await detectHumanGate(this.page);
      if (gate !== null && gate.blocking) {
        const result = await waitForHuman(this.page, gate, this.config.timeouts.humanWaitMs);
        if (!result.resolved) {
          return {
            outcome: 'paused-manual',
            questionsAnswered: 0,
            note: `Stopped: ${gate.reason} requires a manual sign-in in Brave.`,
          };
        }
      }
    }

    let steps = 0;
    const maxSteps = this.config.limits.maxCourseSteps;
    const attemptCounts = new Map<string, number>();
    const maxAttempts = this.config.limits.maxQuestionAttempts;

    while (steps < maxSteps) {
      steps += 1;
      if (this.questionsAnswered >= this.config.limits.maxQuestionsPerRun) {
        return {
          outcome: 'stopped-limit',
          questionsAnswered: this.questionsAnswered,
          note: 'Reached MAX_QUESTIONS_PER_RUN for this session.',
        };
      }

      const context = await findContentFrame(this.page);
      const pageState = await describePage(context);
      logger.step(`Step ${steps}: ${pageState.heading || pageState.title || pageState.url}`);

      const gate = await detectHumanGate(this.page);
      if (gate !== null && gate.blocking) {
        const result = await waitForHuman(this.page, gate, this.config.timeouts.humanWaitMs);
        if (!result.resolved) {
          return {
            outcome: 'paused-manual',
            questionsAnswered: this.questionsAnswered,
            note: `Stopped: ${gate.reason} requires manual handling.`,
          };
        }
        continue;
      }

      const activity = await detectActivity(context);
      logger.debug(`Activity: ${activity.kind}${activity.progressPercent !== null ? ` (${activity.progressPercent}%)` : ''}`);

      // --- 1. Question / quiz flow -------------------------------------------
      const question = await extractQuestion(context);
      if (question !== null) {
        const key = question.fingerprint ?? question.question;
        const seen = (attemptCounts.get(key) ?? 0) + 1;
        attemptCounts.set(key, seen);

        if (seen > maxAttempts) {
          await captureScreenshot(context, 'repeated-question');
          logger.block([
            '',
            '  PAUSED - the same question has failed repeatedly.',
            `  Question: ${question.question.slice(0, 140)}`,
            `  Attempts on this question: ${seen}`,
            '  Please complete it manually in the Brave window, then re-run.',
            '',
          ]);
          await finishQuestionCycle(context);
          return {
            outcome: 'paused-manual',
            questionsAnswered: this.questionsAnswered,
            note: 'Same question encountered too many times; needs a human.',
          };
        }

        const handled = await this.handleQuestion(context, question);
        if (handled === 'blocked') {
          await finishQuestionCycle(context);
          return {
            outcome: 'paused-manual',
            questionsAnswered: this.questionsAnswered,
            note: 'Could not proceed on the current question.',
          };
        }
        if (handled === 'advanced') {
          continue;
        }
      }

      // --- 2. Video ----------------------------------------------------------
      if (activity.isVideo) {
        logger.info(`Video activity detected: ${activity.title}`);
        const result = await waitForVideoCompletion(context, activity, {
          maxWaitMs: 20 * 60 * 1000,
          onTick: (info) => logger.raw(`  ${info}`),
        });
        if (result.completed) {
          logger.success('Video reached the end.');
        } else {
          logger.warnLine(`Video not finished: ${result.reason}`);
          const next = await goToNextActivity(context);
          if (!next.advanced) {
            await captureScreenshot(context, 'video-not-finished');
            return {
              outcome: 'paused-manual',
              questionsAnswered: this.questionsAnswered,
              note: 'Video is not complete and no Next control is available.',
            };
          }
        }
      }

      // --- 3. Simulation / interactive ---------------------------------------
      if (activity.kind === 'simulation' || activity.kind === 'interactive') {
        if (activity.hasQuestionControls) {
          // Already handled by the question branch above.
        } else {
          logger.block([
            '',
            '  PAUSED - interactive activity needs a human.',
            `  Activity: ${activity.title}`,
            activity.instructions !== '' ? `  Instructions: ${activity.instructions.slice(0, 300)}` : '',
            '  The assistant will not guess at simulation state changes.',
            '',
          ]);
          await captureScreenshot(context, 'interactive-pause');
          return {
            outcome: 'paused-manual',
            questionsAnswered: this.questionsAnswered,
            note: 'Interactive/simulation activity requires manual completion.',
          };
        }
      }

      // --- 4. Reading / content ---------------------------------------------
      if (activity.kind === 'reading' || activity.kind === 'unknown') {
        const next = await goToNextActivity(context);
        if (!next.advanced) {
          logger.debug(`No Next control (${next.reason}). Assuming this activity is the end of the course.`);
          return {
            outcome: 'completed',
            questionsAnswered: this.questionsAnswered,
            note: 'No further activities could be reached from here.',
          };
        }
      }

      // --- 5. Quiz / knowledge check with no detected options -----------------
      if (
        question === null &&
        (activity.kind === 'quiz' || activity.kind === 'knowledge-check' || activity.kind === 'final-assessment')
      ) {
        await captureScreenshot(context, 'quiz-without-options', { fullPage: true });
        logger.block([
          '',
          '  PAUSED - an assessment is showing but no answer options were detected.',
          `  Activity: ${activity.title}`,
          '  A screenshot was saved to debug/screenshots/.',
          '  Complete it manually, then re-run.',
          '',
        ]);
        await finishQuestionCycle(context);
        return {
          outcome: 'paused-manual',
          questionsAnswered: this.questionsAnswered,
          note: 'Assessment detected but no extractable answer options.',
        };
      }
    }

    return {
      outcome: 'stopped-limit',
      questionsAnswered: this.questionsAnswered,
      note: `Reached MAX_COURSE_STEPS (${maxSteps}) without finishing.`,
    };
  }

  /** Returns 'advanced' when the activity moved on, 'blocked' on failure. */
  private async handleQuestion(
    context: FrameContext,
    question: import('../ai/provider.js').ExtractedQuestion,
  ): Promise<'advanced' | 'blocked'> {
    const { options, type, question: text } = question;
    this.questionsAnswered += 1;

    logger.section('Question');
    logger.raw(`  ${text}`);
    logger.raw('');
    logger.raw('  Type: ' + type);
    options.forEach((option, index) => {
      logger.raw(`  ${index + 1}. ${option.text}`);
    });

    let answer;
    try {
      answer = await this.provider.answerQuestion(question);
    } catch (error: unknown) {
      logger.fail(`AI request failed: ${error instanceof Error ? error.message : String(error)}`);
      await captureScreenshot(context, 'ai-error');
      return 'blocked';
    }

    logger.raw('');
    logger.raw('AI answer:');
    answer.answers.forEach((index) => {
      const option = options[index - 1];
      logger.raw(`  ${index}. ${option?.text ?? '???'}`);
    });
    logger.raw(`Confidence: ${answer.confidence.toFixed(2)}`);
    logger.raw(`Reason: ${answer.reason}`);

    if (this.config.dryRun) {
      logger.raw('');
      logger.warnLine('DRY_RUN=true - selecting, clicking and submitting are disabled.');
      return 'advanced';
    }

    logger.section('Action');
    const snapshotBefore = await readRelevantText(context);
    const outcome = await selectAnswers(context, question, answer, { dryRun: this.config.dryRun });
    if (outcome.selected.length === 0 && outcome.alreadySelected.length === 0) {
      logger.fail('No answer could be selected.');
      await captureScreenshot(context, 'select-failed');
      return 'blocked';
    }
    logger.success('Answer selected');

    const submit = await submitAnswer(context, { dryRun: this.config.dryRun });
    if (!submit.submitted) {
      logger.warnLine(`Nothing to submit: ${submit.reason}`);
      await finishQuestionCycle(context);
      return 'advanced';
    }
    logger.success('Submitted');

    const result = await detectResult(context, snapshotBefore);
    if (result.accepted) {
      logger.success('Result detected: accepted ✓');
      if (result.feedback !== '') logger.raw(`  Site feedback: ${result.feedback}`);
    } else if (result.rejected) {
      logger.fail('Result detected: rejected ✗');
      logger.raw('Reason/feedback:');
      logger.raw(`  ${result.feedback !== '' ? result.feedback : '(no explicit feedback text found)'}`);
      await captureScreenshot(context, 'answer-rejected');
    } else {
      logger.warnLine('Result: no explicit accept/reject text found (this may be normal).');
    }

    await finishQuestionCycle(context);
    await sleep(800);
    return 'advanced';
  }
}

/** Top-level orchestration across all seven required courses. */
export async function runAssistant(
  page: Page,
  config: AppConfig,
  provider: AiProvider,
): Promise<void> {
  logger.section('Learning plan');
  const snapshot = await readLearningPlan(page, config.planUrl);
  saveProgress(config, snapshot);

  for (let run = 0; run < config.limits.maxCoursesPerRun; run += 1) {
    const plan = await readLearningPlan(page, config.planUrl);
    const target = chooseNextCourse(plan.courses);
    if (target === null) {
      logger.success('All detected courses in the plan are complete. Done!');
      return;
    }

    logger.section(`Current: ${target.name}`);
    logger.kv('Status', `${target.status}${target.progressPercent !== null ? ` (${target.progressPercent}%)` : ''}`);

    const opened = await openCourse(page, target.name);
    if (!opened.opened) {
      logger.warnLine(`Could not open "${target.name}": ${opened.reason}`);
      await captureScreenshot(page, 'course-not-openable');
      return;
    }

    const runner = new CourseRunner(page, config, provider);
    const summary = await runner.run();
    updateCourseProgress(config, target.name, target.status, target.progressPercent);

    if (summary.outcome === 'paused-manual') {
      logger.block(['', `  Stopped: ${summary.note}`, '']);
      return;
    }
    if (summary.outcome === 'stopped-limit') {
      logger.warnLine(summary.note);
      return;
    }

    // Loop back to the plan and re-read progress (site is the source of truth).
    await page.goto(config.planUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => undefined);
    await sleep(1500);
  }

  logger.warnLine('Reached MAX_COURSES_PER_RUN.');
}
