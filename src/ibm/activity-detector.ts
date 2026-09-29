import type { Frame, Page } from 'playwright-core';
import { logger } from '../utils/logger.js';
import { captureScreenshot } from '../utils/screenshots.js';
import { sleep } from '../utils/retry.js';
import { ensureEvalHelpers, isEnabled, isVisible, safeClick, type FrameContext } from './dom-utils.js';

export type ActivityKind =
  | 'quiz'
  | 'knowledge-check'
  | 'video'
  | 'reading'
  | 'simulation'
  | 'interactive'
  | 'final-assessment'
  | 'unknown';

export interface ActivityState {
  readonly kind: ActivityKind;
  readonly title: string;
  readonly isVideo: boolean;
  readonly video: {
    readonly present: boolean;
    readonly durationSeconds: number | null;
    readonly currentTime: number | null;
    readonly paused: boolean | null;
    readonly ended: boolean | null;
  };
  readonly progressPercent: number | null;
  readonly hasQuestionControls: boolean;
  readonly submitLabels: readonly string[];
  readonly notes: readonly string[];
  readonly instructions: string;
}

const KIND_PATTERNS: ReadonlyArray<{ kind: ActivityKind; pattern: RegExp }> = [
  { kind: 'final-assessment', pattern: /final (assessment|exam|test)|proctored|end[- ]of[- ]course (assessment|test)/i },
  { kind: 'quiz', pattern: /\bquiz\b|\bgraded\b|pass (score|mark)|\bat least \d+%/i },
  { kind: 'knowledge-check', pattern: /knowledge check|check your (understanding|knowledge)|self[- ]check/i },
  { kind: 'simulation', pattern: /simulation|\blab\b|sandbox|scenario|drag and drop|drag & drop/i },
  { kind: 'interactive', pattern: /interactive|exercise|try it|lab\b|practice/i },
  { kind: 'video', pattern: /\bvideo\b|\bwatch\b|transcript/i },
  { kind: 'reading', pattern: /reading|article|overview|introduction|topic|content|learn about/i },
];

/**
 * Inspect what kind of activity is on screen and, for videos, read the real
 * playback state instead of assuming a page view means completion.
 */
export async function detectActivity(page: Page | Frame): Promise<ActivityState> {
  const context: FrameContext = page;
  await ensureEvalHelpers(context);

  const raw = await context
    .evaluate(() => {
      const text = (node: Element | string | null | undefined): string => {
        if (node === null || node === undefined) return '';
        const value = typeof node === 'string' ? node : (node.textContent ?? '');
        return value.replace(/\s+/g, ' ').trim();
      };
      const isVisible = (node: Element): boolean => {
        const rect = node.getBoundingClientRect();
        if (rect.width <= 1 || rect.height <= 1) return false;
        const style = window.getComputedStyle(node);
        return style.visibility !== 'hidden' && style.display !== 'none';
      };

      const title =
        text(
          document.querySelector('h1, [role="heading"][aria-level="1"]') ??
            document.querySelector('main h1, main h2, h2'),
        ) || text(document.title);

      const videos = Array.from(document.querySelectorAll('video')).filter(isVisible);
      const videoEls = videos.length > 0 ? videos : Array.from(document.querySelectorAll('video'));

      const first: HTMLVideoElement | undefined = videoEls[0];
      const submitLabels = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]'))
        .filter(isVisible)
        .map((node) => text(node) || (node as HTMLInputElement).value || '')
        .map((value) => value.trim())
        .filter((value) => /submit|check|next|continue|save|confirm|done|finish/i.test(value))
        .slice(0, 12);

      const hasQuestionControls =
        document.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], [role="option"]').length >= 2;

      const bodyText = (document.body?.innerText ?? '').slice(0, 8000);
      const percentMatch = bodyText.match(/(\d{1,3})\s*%/);

      const instructions = Array.from(
        document.querySelectorAll('[class*="instruction" i], [class*="prompt" i], [class*="description" i], main p, main li'),
      )
        .filter(isVisible)
        .map((node) => text(node))
        .filter((value) => value.length > 12 && value.length < 500)
        .slice(0, 8)
        .join(' | ');

      return {
        title,
        bodyText,
        submitLabels,
        hasQuestionControls,
        percent: percentMatch !== null && percentMatch[1] !== undefined ? Number(percentMatch[1]) : null,
        instructions: instructions.slice(0, 2000),
        video: {
          present: first !== undefined,
          duration: first !== undefined && Number.isFinite(first.duration) ? first.duration : null,
          currentTime: first !== undefined && Number.isFinite(first.currentTime) ? first.currentTime : null,
          paused: first !== undefined ? first.paused : null,
          ended: first !== undefined ? first.ended : null,
          readyState: first !== undefined ? first.readyState : null,
        },
      };
    })
    .catch(() => ({
      title: '',
      bodyText: '',
      submitLabels: [] as string[],
      hasQuestionControls: false,
      percent: null as number | null,
      instructions: '',
      video: { present: false, duration: null, currentTime: null, paused: null, ended: null, readyState: null },
    }));

  const haystack = `${raw.title}\n${raw.bodyText.slice(0, 3000)}`;
  let kind: ActivityKind = 'unknown';
  for (const entry of KIND_PATTERNS) {
    if (entry.pattern.test(haystack)) {
      kind = entry.kind;
      break;
    }
  }
  if (raw.hasQuestionControls && (kind === 'unknown' || kind === 'reading')) {
    kind = 'quiz';
  }

  const notes: string[] = [];
  if (kind === 'unknown') notes.push('Activity type could not be classified with confidence.');

  return {
    kind,
    title: raw.title,
    isVideo: raw.video.present,
    video: {
      present: raw.video.present,
      durationSeconds: raw.video.duration,
      currentTime: raw.video.currentTime,
      paused: raw.video.paused,
      ended: raw.video.ended,
    },
    progressPercent: raw.percent,
    hasQuestionControls: raw.hasQuestionControls,
    submitLabels: raw.submitLabels,
    notes,
    instructions: raw.instructions,
  };
}

export interface VideoCompletionResult {
  readonly completed: boolean;
  readonly reason: string;
  readonly watchedSeconds: number | null;
  readonly durationSeconds: number | null;
}

/**
 * Wait for a video to actually finish playing. We only observe the media
 * element state (currentTime / ended); we never fast-forward or fake progress.
 */
export async function waitForVideoCompletion(
  page: Page | Frame,
  state: ActivityState,
  options: { maxWaitMs: number; pollMs?: number; onTick?: (info: string) => void },
): Promise<VideoCompletionResult> {
  const context: FrameContext = page;
  if (!state.video.present) {
    return { completed: false, reason: 'No video element found on this activity.', watchedSeconds: null, durationSeconds: null };
  }

  await ensureEvalHelpers(context);
  const pollMs = options.pollMs ?? 5_000;
  const deadline = Date.now() + options.maxWaitMs;

  // If the video is paused, ask the user to press play - we do not autoplay.
  if (state.video.paused === true) {
    logger.block([
      '',
      '  PAUSED - video is not playing.',
      `  Activity: ${state.title}`,
      '  Press Play in the browser, then the assistant will keep watching for completion.',
      '',
    ]);
  }

  let lastLogged = -1;
  while (Date.now() < deadline) {
    const snapshot = await context
      .evaluate(() => {
        const video = document.querySelector('video');
        if (video === null) return null;
        return {
          currentTime: video.currentTime,
          duration: Number.isFinite(video.duration) ? video.duration : null,
          paused: video.paused,
          ended: video.ended,
        };
      })
      .catch(() => null);

    if (snapshot === null) {
      return { completed: false, reason: 'Video element disappeared from the page.', watchedSeconds: null, durationSeconds: null };
    }

    const percent =
      snapshot.duration !== null && snapshot.duration > 0
        ? Math.min(100, Math.round((snapshot.currentTime / snapshot.duration) * 100))
        : null;
    if (percent !== null && percent !== lastLogged && percent % 10 === 0) {
      lastLogged = percent;
      options.onTick?.(`Video ${percent}% (${formatTime(snapshot.currentTime)} / ${formatTime(snapshot.duration)})`);
    }

    if (snapshot.ended === true) {
      return {
        completed: true,
        reason: 'Video reached the end.',
        watchedSeconds: snapshot.currentTime,
        durationSeconds: snapshot.duration,
      };
    }

    await sleep(pollMs);
  }

  return {
    completed: false,
    reason: 'Timed out waiting for the video to finish.',
    watchedSeconds: null,
    durationSeconds: state.video.durationSeconds,
  };
}

function formatTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '--:--';
  const total = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins)}:${String(secs).padStart(2, '0')}`;
}

/** Advance to the next activity in the course player, if a Next control exists. */
export async function goToNextActivity(page: Page | Frame): Promise<{ advanced: boolean; reason: string }> {
  const context: FrameContext = page;
  const labels = ['next', 'next activity', 'continue', 'mark complete', 'complete activity', 'done', 'save and continue'];
  for (const label of labels) {
    const matcher = context.getByRole('button', { name: label, exact: false });
    const count = await matcher.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const target = matcher.nth(i);
      if (await isVisible(target) && await isEnabled(target)) {
        const result = await safeClick(target, `"${label}" button`, { frame: context });
        if (result.clicked) {
          await sleep(2000);
          return { advanced: true, reason: `clicked "${label}"` };
        }
      }
    }
  }
  return { advanced: false, reason: 'No enabled Next/Continue control found.' };
}

export async function captureActivity(page: Page | Frame, label: string): Promise<void> {
  await captureScreenshot(page, label, { fullPage: false });
}
