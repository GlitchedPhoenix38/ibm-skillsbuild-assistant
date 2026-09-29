import { config } from 'dotenv';

config({ override: false });

function readString(key: string, fallback: string): string {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim();
}

function readInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppConfig {
  readonly dryRun: boolean;
  readonly brave: {
    readonly cdpPort: number;
    readonly cdpUrl: string | undefined;
    readonly executablePath: string | undefined;
    readonly headless: boolean;
    readonly tabUrlHint: string | undefined;
    readonly connectTimeoutMs: number;
  };
  readonly timeouts: {
    readonly navigationMs: number;
    readonly actionMs: number;
    readonly humanWaitMs: number;
  };
  readonly planUrl: string;
  readonly ai: {
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly model: string;
    readonly temperature: number;
    readonly maxTokens: number;
    readonly timeoutMs: number;
    readonly retries: number;
    readonly extraHeaders: Readonly<Record<string, string>> | undefined;
  };
  readonly limits: {
    readonly maxQuestionAttempts: number;
    readonly maxCourseSteps: number;
    readonly maxCoursesPerRun: number;
    readonly maxQuestionsPerRun: number;
  };
  readonly paths: {
    readonly progressFile: string;
    readonly screenshotDir: string;
  };
  readonly logLevel: LogLevel;
}

function parseExtraHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return undefined;
  }
}

export function loadConfig(): AppConfig {
  const logLevelRaw = readString('LOG_LEVEL', 'info');
  const logLevel: LogLevel = (
    ['debug', 'info', 'warn', 'error'] as const
  ).includes(logLevelRaw as LogLevel)
    ? (logLevelRaw as LogLevel)
    : 'info';

  const explicitCdpUrl = readString('BRAVE_CDP_URL', '');
  const cdpPort = readInt('BRAVE_CDP_PORT', 9222);

  return {
    dryRun: readBoolean('DRY_RUN', true),
    brave: {
      cdpPort,
      cdpUrl: explicitCdpUrl === '' ? undefined : explicitCdpUrl,
      executablePath: (() => {
        const value = readString('BRAVE_PATH', '');
        return value === '' ? undefined : value;
      })(),
      headless: readBoolean('HEADLESS', false),
      tabUrlHint: (() => {
        const value = readString('TAB_URL_HINT', '');
        return value === '' ? undefined : value;
      })(),
      connectTimeoutMs: readInt('BROWSER_CONNECT_TIMEOUT_MS', 30_000),
    },
    timeouts: {
      navigationMs: readInt('NAV_TIMEOUT_MS', 60_000),
      actionMs: readInt('ACTION_TIMEOUT_MS', 20_000),
      humanWaitMs: readInt('HUMAN_WAIT_TIMEOUT_MS', 0),
    },
    planUrl: readString(
      'PLAN_URL',
      'https://skills.yourlearning.ibm.com/activity/PLAN-8749C02A78EC',
    ),
    ai: {
      baseUrl: readString('AI_BASE_URL', 'https://api.openai.com/v1'),
      apiKey: readString('AI_API_KEY', ''),
      model: readString('AI_MODEL', 'gpt-4o-mini'),
      temperature: Number.parseFloat(readString('AI_TEMPERATURE', '0')) || 0,
      maxTokens: readInt('AI_MAX_TOKENS', 500),
      timeoutMs: readInt('AI_TIMEOUT_MS', 60_000),
      retries: readInt('AI_REQUEST_TIMEOUT_RETRIES', 2),
      extraHeaders: parseExtraHeaders(process.env['AI_EXTRA_HEADERS']),
    },
    limits: {
      maxQuestionAttempts: readInt('MAX_QUESTION_ATTEMPTS', 3),
      maxCourseSteps: readInt('MAX_COURSE_STEPS', 400),
      maxCoursesPerRun: readInt('MAX_COURSES_PER_RUN', 20),
      maxQuestionsPerRun: readInt('MAX_QUESTIONS_PER_RUN', 200),
    },
    paths: {
      progressFile: readString('PROGRESS_FILE', 'progress.json'),
      screenshotDir: readString('SCREENSHOT_DIR', 'debug/screenshots'),
    },
    logLevel,
  };
}

export const PROJECT_ROOT = process.cwd();
