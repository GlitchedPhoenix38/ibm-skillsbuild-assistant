import type { ExtractedQuestion, AiAnswer } from '../ai/provider.js';
import type { PlanCourse } from '../ibm/learning-plan.js';
import { logger } from '../utils/logger.js';

const STATUS_LABEL: Readonly<Record<PlanCourse['status'], string>> = {
  complete: 'COMPLETE',
  'in-progress': 'IN PROGRESS',
  'not-started': 'NOT STARTED',
  unknown: 'UNKNOWN',
};

function padTo(text: string, width: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length >= width) return `${clean.slice(0, Math.max(0, width - 1))}…`;
  return clean.padEnd(width, ' ');
}

function shortName(name: string, max = 34): string {
  const map: ReadonlyArray<[string, string]> = [
    ['Web Development Basics', 'Web Development Basics'],
    ['Developing Sites for the Web', 'Developing Sites for the Web'],
    ['Introduction to HTML and CSS', 'Introduction to HTML and CSS'],
    ['Bringing Websites to Life with JavaScript', 'Bringing Websites to Life'],
    ['Website Testing and Deployment', 'Website Testing and Deployment'],
    ['Develop an Interactive Task List Web Page', 'Interactive Task List'],
    ['Your Future in Web Development', 'Future in Web Development'],
  ];
  const found = map.find(([full]) => name.includes(full));
  if (found === undefined) return name.slice(0, max);
  return found[1].length > max ? `${found[1].slice(0, max - 1)}…` : found[1];
}

function statusText(course: PlanCourse): string {
  if (course.status === 'complete' || (course.progressPercent !== null && course.progressPercent >= 100)) {
    return 'COMPLETE';
  }
  if (course.progressPercent !== null && course.progressPercent > 0) {
    return `${course.progressPercent}%`;
  }
  return STATUS_LABEL[course.status];
}

export function renderPlan(courses: readonly PlanCourse[], planName: string): void {
  const lines: string[] = ['', 'Learning Plan:', `  ${planName}`, ''];

  courses.forEach((course, index) => {
    const name = padTo(shortName(course.name), 34);
    const status = statusText(course);
    lines.push(`  ${String(index + 1).padStart(2)}. ${name} .. ${status}`);
  });

  lines.push('');
  logger.block(lines);
}

export function renderCurrent(courseName: string | null): void {
  const lines: string[] = ['', 'Current:', `  ${courseName ?? '(none)'}`, ''];
  logger.block(lines);
}

export function renderQuestion(question: ExtractedQuestion, answer: AiAnswer | null): void {
  const lines: string[] = ['', 'Question:', `  ${wrap(question.question, 66, '  ')}`, ''];
  question.options.forEach((option, index) => {
    lines.push(`  ${index + 1}. ${wrap(option.text, 62, '     ')}`);
  });

  if (answer !== null) {
    lines.push('');
    lines.push('AI answer:');
    for (const index of answer.answers) {
      const option = question.options[index - 1];
      lines.push(`  ${index}. ${option?.text ?? '???'}`);
    }
    lines.push('');
    lines.push('Confidence:');
    lines.push(`  ${answer.confidence.toFixed(2)}`);
    lines.push('');
    lines.push('Reason:');
    lines.push(`  ${wrap(answer.reason, 66, '  ')}`);
  }

  lines.push('');
  logger.block(lines);
}

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/).filter((word) => word !== '');
  const out: string[] = [];
  let current = '';
  for (const word of words) {
    if (current === '') current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      out.push(current);
      current = word;
    }
  }
  if (current !== '') out.push(current);
  return out.join(`\n${indent}`);
}
