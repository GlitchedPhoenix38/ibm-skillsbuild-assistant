#!/usr/bin/env node
import { parseArgs } from 'node:util';
import type { Page } from 'playwright-core';
import { loadConfig, type AppConfig } from './config.js';
import { createAiProvider } from './ai/index.js';
import type { AiProvider } from './ai/provider.js';
import { connectToBrave, waitForPageStability, type BraveSession } from './browser/connection.js';
import { findBraveBinary } from './browser/brave.js';
import { readLearningPlan } from './ibm/learning-plan.js';
import { chooseNextCourse, runAssistant } from './ibm/course.js';
import { initProgressFile, loadProgress } from './ibm/progress.js';
import { detectHumanGate, waitForHuman } from './ibm/human-gate.js';
import { logger } from './utils/logger.js';
import { captureScreenshot, configureScreenshotDir } from './utils/screenshots.js';
import { sleep } from './utils/retry.js';
import { renderPlan } from './ui/render.js';

type Mode = 'run' | 'plan' | 'extract' | 'doctor' | 'help';

interface CliOptions {
  mode: Mode;
  dryRun: boolean | undefined;
  course: string | undefined;
  mock: boolean;
}

function parseCli(): CliOptions {
  const { values } = parseArgs({
    options: {
      doctor: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean' },
      'real-run': { type: 'boolean' },
      course: { type: 'string' },
      mock: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  const hasModeFlag = values['doctor'] === true || values.help === true;
  let mode: Mode = 'run';
  if (values.help === true) mode = 'help';
  else if (values.doctor === true) mode = 'doctor';
  else if (process.argv.includes('--mode')) {
    const index = process.argv.indexOf('--mode');
    const value = process.argv[index + 1];
    mode = value === 'plan' || value === 'extract' ? value : 'run';
  }

  let dryRun: boolean | undefined;
  if (values['dry-run'] === true) dryRun = true;
  if (values['real-run'] === true) dryRun = false;

  return {
    mode,
    dryRun,
    course: typeof values['course'] === 'string' ? values['course'] : undefined,
    mock: values['mock'] === true,
    ...(hasModeFlag ? {} : {}),
  };
}

let activeSession: BraveSession | null = null;
let shuttingDown = false;

async function gracefulShutdown(reason: string, code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.block(['', `  Shutting down (${reason})...`, '']);
  if (activeSession !== null) {
    // Detach only. The user's Brave window is left open and logged in.
    await activeSession.close().catch(() => undefined);
    activeSession = null;
  }
  logger.block(['  Brave was left running. Safe to close.', '']);
  process.exit(code);
}

function installSignalHandlers(): void {
  process.on('SIGINT', () => {
    void gracefulShutdown('Ctrl+C', 130);
  });
  process.on('SIGTERM', () => {
    void gracefulShutdown('SIGTERM', 143);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('Unhandled rejection:', reason);
  });
  process.on('uncaughtException', (error: Error) => {
    logger.error('Uncaught exception:', error.stack ?? error.message);
    void gracefulShutdown('fatal error', 1);
  });
}

function printHelp(): void {
  logger.block([
    '',
    '  IBM SkillsBuild Assistant',
    '',
    '  Usage:',
    '    npm run dev -- [options]        run with tsx (no build step)',
    '    npm start -- [options]          run the compiled build',
    '',
    '  Options:',
    '    --doctor            Check Brave CDP, the AI provider and the plan page. No clicking.',
    '    --dry-run           Force DRY_RUN=true for this invocation (read + ask + print only).',
    '    --real-run          Force DRY_RUN=false for this invocation (allows clicking).',
    '    --mock              Use the offline mock AI provider (no API key needed).',
    '    --course "<name>"   Open a specific course instead of the first incomplete one.',
    '    --mode plan         Only print the learning plan and exit.',
    '    --mode extract      Detect the current activity and extract the current question. No clicking.',
    '    -h, --help          Show this help.',
    '',
    '  Examples:',
    '    npm run doctor                 # verify everything first',
    '    npm run dev -- --dry-run       # safest full run: nothing is clicked',
    '    npm run dev -- --mode plan     # just show the 7 courses + live status',
    '    npm run dev -- --real-run      # allow selecting / submitting answers',
    '',
  ]);
}

async function main(): Promise<void> {
  const cli = parseCli();
  const loaded = loadConfig();
  const config: AppConfig =
    cli.dryRun === undefined ? loaded : { ...loaded, dryRun: cli.dryRun };

  logger.setLevel(config.logLevel);
  logger.setLogFile(`debug/logs/run-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  configureScreenshotDir(config.paths.screenshotDir);
  installSignalHandlers();

  if (cli.mode === 'help') {
    printHelp();
    return;
  }

  logger.banner('IBM SkillsBuild Assistant');
  logger.block([
    `  Mode          : ${cli.mode}${cli.mock ? ' (mock AI)' : ''}`,
    `  Dry run       : ${config.dryRun ? 'YES - nothing will be clicked' : 'NO - clicking allowed'}`,
    `  Log level     : ${config.logLevel}`,
    `  Screenshots   : ${config.paths.screenshotDir}`,
    `  Progress file : ${config.paths.progressFile}`,
    '',
  ]);

  if (!config.dryRun) {
    logger.block([
      '  LIVE MODE: answers will be selected and submitted on the real page.',
      '',
    ]);
  }

  initProgressFile(config);

  if (cli.mode === 'doctor') {
    await runDoctor(config, cli.mock);
    return;
  }

  let provider: AiProvider;
  try {
    provider = createAiProvider(config, { forceMock: cli.mock });
  } catch (error: unknown) {
    logger.fail(error instanceof Error ? error.message : String(error));
    logger.block([
      '  Configure AI_BASE_URL, AI_API_KEY and AI_MODEL in .env (see .env.example),',
      '  or use --mock to test the pipeline with the offline provider.',
      '',
    ]);
    process.exitCode = 1;
    return;
  }
  logger.kv('AI provider', `${provider.name} (${provider.model})`);

  const session = await connectToBrave({ config, openUrls: [config.planUrl] });
  activeSession = session;
  await waitForPageStability(session.page, config.timeouts.navigationMs);

  const gate = await detectHumanGate(session.page);
  if (gate !== null && gate.blocking) {
    logger.warnLine(`Human gate detected: ${gate.reason} (${gate.evidence})`);
    const result = await waitForHuman(session.page, gate, config.timeouts.humanWaitMs);
    if (!result.resolved) {
      logger.block([
        '  IBM sign-in is required. Please log in to SkillsBuild manually in Brave,',
        '  then run this command again. The assistant will not attempt to sign in for you.',
        '',
      ]);
      await session.close();
      process.exitCode = 2;
      return;
    }
  }

  if (cli.mode === 'plan') {
    await showPlan(session.page, config);
    await session.close();
    return;
  }

  if (cli.mode === 'extract') {
    await extractCurrent(session.page, config);
    await session.close();
    return;
  }

  if (cli.course !== undefined) {
    logger.section(`Opening course: ${cli.course}`);
    const { openCourse } = await import('./ibm/learning-plan.js');
    const opened = await openCourse(session.page, cli.course);
    if (!opened.opened) {
      logger.fail(opened.reason);
      await captureScreenshot(session.page, 'course-not-openable');
      await session.close();
      process.exitCode = 3;
      return;
    }
    const { CourseRunner } = await import('./ibm/course.js');
    const runner = new CourseRunner(session.page, config, provider);
    const summary = await runner.run();
    logger.block(['', `  Outcome: ${summary.outcome} - ${summary.note}`, '']);
    await session.close();
    return;
  }

  await runAssistant(session.page, config, provider);
  await session.close();
}

async function showPlan(page: Page, config: AppConfig): Promise<void> {
  const snapshot = await readLearningPlan(page, config.planUrl);
  const progress = loadProgress(config);
  logger.kv('Plan URL', snapshot.url);
  renderPlan(snapshot.courses, snapshot.planName);
  logger.block(['  (Live values read from the page just now. progress.json is only a cache.)', '']);
  if (snapshot.courses.length === 0) {
    logger.block([
      '  No courses detected. The UI may have changed, or the page may not be fully loaded.',
      '  A screenshot was saved to debug/screenshots/plan-not-loaded.png.',
      '',
    ]);
  }
  logger.debug(`Cached course count in progress.json: ${Object.keys(progress.courses).length}`);
  const target = chooseNextCourse(snapshot.courses);
  if (target !== null) {
    logger.raw(`  Next up: ${target.name}`);
    logger.raw('');
  }
}

async function extractCurrent(page: Page, config: AppConfig): Promise<void> {
  const { detectActivity } = await import('./ibm/activity-detector.js');
  const { extractQuestion } = await import('./ibm/question-extractor.js');
  const { renderCurrent } = await import('./ui/render.js');
  const { describePage } = await import('./ibm/dom-utils.js');

  const state = await describePage(page);
  logger.kv('URL', state.url);
  logger.kv('Title', state.title);
  renderCurrent(state.heading !== '' ? state.heading : state.title);

  const activity = await detectActivity(page);
  logger.kv('Activity type', activity.kind);
  if (activity.isVideo) {
    logger.kv('Video', `present (paused=${activity.video.paused}, ended=${activity.video.ended})`);
  }

  const question = await extractQuestion(page);
  if (question === null) {
    logger.warnLine('No question with 2+ answer options detected on this view.');
    await captureScreenshot(page, 'extract-none', { fullPage: true });
    await sleep(0);
    return;
  }

  logger.raw('');
  logger.raw(`Type: ${question.type}`);
  logger.raw('');
  question.options.forEach((option, index) => {
    logger.raw(`  ${index + 1}. ${option.text}`);
  });
  logger.raw('');
  logger.kv('Options found', question.options.length);
  if (config.dryRun) logger.kv('Dry run', 'true (extract mode never clicks)');
  logger.raw('');
}

async function runDoctor(config: AppConfig, useMock: boolean): Promise<void> {
  logger.section('1. Brave');
  const binary = findBraveBinary(config.brave.executablePath);
  logger.raw(binary !== undefined ? `  ✓ Brave binary: ${binary}` : '  ✗ Brave binary not found (set BRAVE_PATH)');
  logger.raw(`  CDP endpoint: ${config.brave.cdpUrl ?? `http://127.0.0.1:${config.brave.cdpPort}`}`);

  logger.section('2. AI provider');
  let provider: AiProvider;
  try {
    provider = createAiProvider(config, { forceMock: useMock });
  } catch (error: unknown) {
    logger.fail(error instanceof Error ? error.message : String(error));
    return;
  }
  const health = await provider.healthCheck();
  logger.raw(health.ok ? `  ✓ ${health.detail}` : `  ✗ ${health.detail}`);

  if (!useMock) {
    const question = SAMPLE_QUESTION;
    try {
      const answer = await provider.answerQuestion(question);
      logger.raw('  ✓ Sample question answered:');
      answer.answers.forEach((index) => logger.raw(`      ${index}. ${question.options[index - 1]?.text ?? ''}`));
      logger.raw(`      confidence ${answer.confidence.toFixed(2)}`);
    } catch (error: unknown) {
      logger.raw(`  ✗ Sample question failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  logger.section('3. Brave connection');
  try {
    const session = await connectToBrave({ config, openUrls: [config.planUrl] });
    logger.success('Connected to Brave ✓');

    const gate = await detectHumanGate(session.page);
    if (gate !== null && gate.blocking) {
      logger.warnLine(`Human gate on the current page: ${gate.reason} (${gate.evidence})`);
    } else {
      logger.success('No login/CAPTCHA gate detected on the current tab.');
    }

    logger.section('4. Learning plan');
    const snapshot = await readLearningPlan(session.page, config.planUrl);
    renderPlan(snapshot.courses, snapshot.planName);
    if (snapshot.courses.length === 0) {
      logger.warnLine('No courses detected - selectors may need updating.');
      await captureScreenshot(session.page, 'doctor-no-courses', { fullPage: true });
    }

    await session.close();
    logger.success('Doctor complete. Brave was left running.');
  } catch (error: unknown) {
    logger.fail(error instanceof Error ? error.message : String(error));
  }
}

const SAMPLE_QUESTION = {
  question: 'Which language is used to add behaviour to a web page in the browser?',
  options: [
    { text: 'HTML', selector: 'unused', nativeInput: true },
    { text: 'CSS', selector: 'unused', nativeInput: true },
    { text: 'JavaScript', selector: 'unused', nativeInput: true },
    { text: 'XML', selector: 'unused', nativeInput: true },
  ],
  type: 'single' as const,
  context: 'Sample question used by --doctor. Not taken from the site.',
};

await main();
