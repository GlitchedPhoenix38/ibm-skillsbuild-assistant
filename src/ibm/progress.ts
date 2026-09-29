import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import type { LearningPlanSnapshot } from './learning-plan.js';

export interface CourseProgressEntry {
  lastKnownStatus: string;
  lastKnownProgress: number;
  lastSeenAt?: string;
  lastKnownCourseUrl?: string | null;
}

export interface ProgressFile {
  planUrl: string;
  lastSyncedAt?: string;
  courses: Record<string, CourseProgressEntry>;
}

/**
 * Local, non-sensitive progress cache.
 *
 * This file is only a convenience snapshot for the terminal UI and for change
 * detection. The IBM website is always the source of truth - if this file
 * disagrees with the page, the page wins. It intentionally never contains
 * cookies, tokens, credentials, or any other session material.
 */
export function saveProgress(config: AppConfig, snapshot: LearningPlanSnapshot): void {
  const filePath = path.resolve(config.paths.progressFile);
  const existing = loadProgress(config);

  const courses: Record<string, CourseProgressEntry> = { ...existing.courses };
  const now = new Date().toISOString();

  for (const course of snapshot.courses) {
    const previous = courses[course.name];
    courses[course.name] = {
      lastKnownStatus: course.status,
      lastKnownProgress: course.progressPercent ?? previous?.lastKnownProgress ?? 0,
      lastSeenAt: now,
      lastKnownCourseUrl: course.href ?? null,
      ...(previous?.lastSeenAt !== undefined ? {} : {}),
    };
  }

  const data: ProgressFile = {
    planUrl: snapshot.url !== '' ? snapshot.url : config.planUrl,
    lastSyncedAt: now,
    courses,
  };

  writeJson(filePath, data);
  logger.debug(`progress.json updated (${Object.keys(courses).length} courses).`);
}

export function updateCourseProgress(
  config: AppConfig,
  courseName: string,
  status: string,
  progress: number | null,
): void {
  const filePath = path.resolve(config.paths.progressFile);
  const existing = loadProgress(config);
  const courses = { ...existing.courses };
  courses[courseName] = {
    lastKnownStatus: status,
    lastKnownProgress: progress ?? 0,
    lastSeenAt: new Date().toISOString(),
  };
  writeJson(filePath, { ...existing, planUrl: existing.planUrl, lastSyncedAt: new Date().toISOString(), courses });
}

export function loadProgress(config: AppConfig): ProgressFile {
  const filePath = path.resolve(config.paths.progressFile);
  if (!existsSync(filePath)) {
    return { planUrl: config.planUrl, courses: {} };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return { planUrl: config.planUrl, courses: {} };
    const record = parsed as Partial<ProgressFile>;
    return {
      planUrl: typeof record.planUrl === 'string' ? record.planUrl : config.planUrl,
      lastSyncedAt: typeof record.lastSyncedAt === 'string' ? record.lastSyncedAt : undefined,
      courses:
        typeof record.courses === 'object' && record.courses !== null
          ? (record.courses as Record<string, CourseProgressEntry>)
          : {},
    };
  } catch (error: unknown) {
    logger.warn(`progress.json is unreadable (${error instanceof Error ? error.message : String(error)}); starting fresh.`);
    return { planUrl: config.planUrl, courses: {} };
  }
}

function writeJson(filePath: string, data: ProgressFile): void {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(tmp, filePath);
  } catch (error: unknown) {
    logger.warn(`Could not write progress.json: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function initProgressFile(config: AppConfig): void {
  const filePath = path.resolve(config.paths.progressFile);
  if (existsSync(filePath)) return;
  writeJson(filePath, { planUrl: config.planUrl, lastSyncedAt: new Date().toISOString(), courses: {} });
}
