/**
 * Offline self-test for extractQuestion() and the answer-validation layer.
 *
 * Runs against a local fixture file with a local Chromium/Brave instance.
 * It never touches IBM SkillsBuild and needs no AI API key.
 *
 *   npx tsx src/selftest.ts
 */
import path from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import { loadConfig } from './config.js';
import { findBraveBinary } from './browser/brave.js';
import { MockProvider } from './ai/mock-provider.js';
import { parseAiAnswer, buildPrompt, type ExtractedQuestion } from './ai/provider.js';
import { extractQuestion } from './ibm/question-extractor.js';
import { detectActivity } from './ibm/activity-detector.js';
import { clearOptionTags } from './ibm/dom-utils.js';
import { initProgressFile, loadProgress, saveProgress } from './ibm/progress.js';
import { detectHumanGate } from './ibm/human-gate.js';

const FIXTURE = `file://${path.resolve(process.cwd(), 'debug/fixtures/quiz.html')}`;

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail !== '' ? ` — ${detail}` : ''}`);
  }
}

async function testPromptAndParsing(): Promise<void> {
  console.log('\n[1] Prompt building + strict JSON validation');
  const question: ExtractedQuestion = {
    question: 'Which language adds behaviour to a page?',
    options: [
      { text: 'HTML', selector: 'x', nativeInput: true },
      { text: 'CSS', selector: 'x', nativeInput: true },
      { text: 'JavaScript', selector: 'x', nativeInput: true },
    ],
    type: 'single',
  };

  const { system, user } = buildPrompt(question);
  check('prompt contains QUESTION: section', user.includes('QUESTION:'));
  check('prompt contains OPTIONS: section', user.includes('OPTIONS:'));
  check('prompt numbers options 1..3', user.includes('1. HTML') && user.includes('3. JavaScript'));
  check('prompt demands the JSON shape', system.includes('"answers"'));
  check('prompt allows multiple answers', system.includes('ALL correct option numbers'));
  check('single-select is stated explicitly', user.includes('SINGLE-SELECT'));

  check('parses bare JSON', JSON.stringify(parseAiAnswer('{"answers":[3],"confidence":0.9,"reason":"x"}', 3).answers) === '[3]');
  check(
    'parses fenced JSON',
    JSON.stringify(parseAiAnswer('```json\n{"answers":[1],"confidence":0.5,"reason":"y"}\n```', 3).answers) === '[1]',
  );
  check(
    'parses JSON embedded in prose',
    parseAiAnswer('Sure! {"answers":[2],"confidence":0.7,"reason":"z"} Hope that helps.', 3).answers[0] === 2,
  );
  check(
    'parses multi-select arrays',
    JSON.stringify(parseAiAnswer('{"answers":[1,3],"confidence":0.8,"reason":"multi"}', 4).answers) === '[1,3]',
  );
  check(
    'deduplicates and sorts',
    JSON.stringify(parseAiAnswer('{"answers":[3,1,3],"confidence":0.8,"reason":"multi"}', 4).answers) === '[1,3]',
  );
  check(
    'clamps confidence into 0..1',
    parseAiAnswer('{"answers":[1],"confidence":5,"reason":"r"}', 3).confidence === 1,
  );

  const rejects: ReadonlyArray<[string, string]> = [
    ['out-of-range index', '{"answers":[9],"confidence":0.5,"reason":"r"}'],
    ['zero index', '{"answers":[0],"confidence":0.5,"reason":"r"}'],
    ['non-numeric answer', '{"answers":["blue"],"confidence":0.5,"reason":"r"}'],
    ['empty answers', '{"answers":[],"confidence":0.5,"reason":"r"}'],
    ['not JSON at all', 'I think the answer is HTML.'],
    ['JSON array instead of object', '[1,2,3]'],
  ];
  for (const [name, payload] of rejects) {
    let threw = false;
    try {
      parseAiAnswer(payload, 4);
    } catch {
      threw = true;
    }
    check(`rejects ${name}`, threw);
  }
}

async function testMockProvider(): Promise<void> {
  console.log('\n[2] Mock AI provider (offline)');
  const provider = new MockProvider();
  const answer = await provider.answerQuestion({
    question: 'Which language adds behaviour to a page in the browser?',
    options: [
      { text: 'HTML', selector: 'x', nativeInput: true },
      { text: 'CSS', selector: 'x', nativeInput: true },
      { text: 'JavaScript', selector: 'x', nativeInput: true },
    ],
    type: 'single',
  });
  check('mock returns a valid option index', answer.answers.every((index) => index >= 1 && index <= 3));
  check('mock returns a confidence', answer.confidence >= 0 && answer.confidence <= 1);
  check('mock returns a reason', answer.reason.length > 0);
}

async function testExtraction(browser: Browser): Promise<void> {
  console.log('\n[3] extractQuestion() against a local fixture');
  const page = await browser.newPage();
  await page.goto(FIXTURE, { waitUntil: 'domcontentloaded' });

  // Case 1: radios with label[for]
  await page.locator('#case-1 form input').first().waitFor();
  let extracted = await extractQuestion(page);
  check('finds the quiz question', extracted !== null);
  if (extracted !== null) {
    check('question text is the prompt', extracted.question.includes('behaviour'), extracted.question);
    check('finds 4 options', extracted.options.length === 4, `got ${extracted.options.length}`);
    check(
      'option labels are correct',
      extracted.options[0]?.text === 'HTML' && extracted.options[2]?.text === 'JavaScript',
      extracted.options.map((option) => option.text).join(' | '),
    );
    check('type is single', extracted.type === 'single', extracted.type);
    check('radios are marked nativeInput', extracted.options.every((option) => option.nativeInput));
    check('every option has a unique selector', new Set(extracted.options.map((o) => o.selector)).size === 4);

    const tagged = await page.locator(extracted.options[0]?.selector ?? '').count();
    check('option selectors resolve in the DOM', tagged === 1, `count=${tagged}`);

    const isChecked = await page
      .locator(extracted.options[0]?.selector ?? '')
      .evaluate((node: Element) => (node as HTMLInputElement).checked)
      .catch(() => null);
    check('selector targets the real input element', isChecked === false);
  }
  await clearOptionTags(page);
  check('tags are cleaned up', (await page.locator('[data-sba-option]').count()) === 0);

  // Case 2: "select all that apply" checkboxes
  await page.locator('#case-1').evaluate((node: Element) => node.remove());
  extracted = await extractQuestion(page);
  check('finds the multi-select question', extracted !== null);
  if (extracted !== null) {
    check('type is multiple', extracted.type === 'multiple', extracted.type);
    check('finds 4 checkbox options', extracted.options.length === 4, `got ${extracted.options.length}`);
    check(
      'checkbox text is read from the wrapping label',
      extracted.options.some((option) => option.text.includes('article')),
      extracted.options.map((o) => o.text).join(' | '),
    );
  }
  await clearOptionTags(page);

  // Case 3: button/role=radio True-False
  await page.locator('#case-2').evaluate((node: Element) => node.remove());
  extracted = await extractQuestion(page);
  check('finds the true/false question', extracted !== null);
  if (extracted !== null) {
    check('type is true-false', extracted.type === 'true-false', extracted.type);
    check('finds exactly the 2 answers', extracted.options.length === 2, `got ${extracted.options.length}`);
    check(
      'options are True/False',
      extracted.options[0]?.text === 'True' && extracted.options[1]?.text === 'False',
      extracted.options.map((o) => o.text).join(' | '),
    );
    check('buttons are not nativeInput', extracted.options.every((option) => !option.nativeInput));
  }
  await clearOptionTags(page);

  // Case 4: content with no options
  await page.locator('#case-3').evaluate((node: Element) => node.remove());
  extracted = await extractQuestion(page);
  check('returns null when there are no options', extracted === null);

  const activity = await detectActivity(page);
  check('classifies a plain content page', activity.kind !== 'quiz', activity.kind);

  const gate = await detectHumanGate(page);
  check('no false-positive human gate on a normal page', gate === null, gate?.reason ?? '');

  await page.close();
}

function testProgress(): void {
  console.log('\n[4] progress.json handling (non-sensitive only)');
  const config = { ...loadConfig(), paths: { progressFile: 'debug/selftest-progress.json', screenshotDir: 'debug/screenshots' } };
  initProgressFile(config);

  const snapshot = {
    url: 'https://skills.yourlearning.ibm.com/activity/PLAN-8749C02A78EC',
    planName: 'Web Development Fundamentals',
    rawText: '',
    courses: [
      { name: 'Web Development Basics', status: 'complete' as const, progressPercent: 100, linkText: '', index: 0, href: null },
      { name: 'Developing Sites for the Web', status: 'in-progress' as const, progressPercent: 92, linkText: '', index: 1, href: '/course/x' },
    ],
  };
  saveProgress(config, snapshot);
  const loaded = loadProgress(config);
  check('writes the plan URL', loaded.planUrl.includes('PLAN-8749C02A78EC'));
  check('records completed course', loaded.courses['Web Development Basics']?.lastKnownStatus === 'complete');
  check('records partial progress', loaded.courses['Developing Sites for the Web']?.lastKnownProgress === 92);
  check('progress keys are course names only', Object.keys(loaded.courses).length === 2);
  return;
}

async function main(): Promise<void> {
  console.log('IBM SkillsBuild Assistant — offline self-test\n(uses a local fixture only; IBM is not contacted)');

  await testPromptAndParsing();
  await testMockProvider();
  testProgress();

  const config = loadConfig();
  const executablePath = findBraveBinary(config.brave.executablePath);
  if (executablePath === undefined) {
    console.log('\n[3] extractQuestion() — SKIPPED (no Chromium/Brave binary found)');
  } else {
    const browser = await chromium.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      await testExtraction(browser);
    } finally {
      await browser.close();
    }
  }

  console.log(`\n${'-'.repeat(50)}\nPassed: ${passed}   Failed: ${failed}\n${'-'.repeat(50)}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();
