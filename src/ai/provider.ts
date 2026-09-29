/**
 * AI provider abstraction.
 *
 * The assistant only needs one capability: given a question + numbered answer
 * choices, return the chosen option number(s), a confidence, and a short
 * reason. Any OpenAI-compatible /chat/completions service can be plugged in
 * through .env (AI_BASE_URL, AI_API_KEY, AI_MODEL).
 */

export type QuestionType = 'single' | 'multiple' | 'true-false' | 'unknown';

export interface QuestionOption {
  /** Visible answer text exactly as rendered on the page. */
  readonly text: string;
  /** How to re-locate this option on the page (Playwright selector). */
  readonly selector: string;
  /** Playwright role-based locator description, when available. */
  readonly role?: string;
  /** Accessible name, when available. */
  readonly name?: string;
  /** True for radio/checkbox inputs, false for clickable buttons/labels. */
  readonly nativeInput: boolean;
  /** Backend `value` attribute, when present. */
  readonly value?: string;
}

export interface ExtractedQuestion {
  readonly question: string;
  readonly options: readonly QuestionOption[];
  readonly type: QuestionType;
  /** Extra page context (instructions, hints, activity title). */
  readonly context?: string;
  /** Best-effort stable key for de-duplicating repeated questions. */
  readonly fingerprint?: string;
}

export interface AiAnswer {
  /** 1-based indices into the option list. */
  readonly answers: readonly number[];
  readonly confidence: number;
  readonly reason: string;
  readonly raw: string;
  readonly model: string;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  answerQuestion(question: ExtractedQuestion): Promise<AiAnswer>;
  /** Cheap connectivity check used by `--doctor`. */
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

/** Build the strict prompt sent to the model. */
export function buildPrompt(question: ExtractedQuestion): { system: string; user: string } {
  const isMulti = question.type === 'multiple';
  const optionsText = question.options
    .map((option, index) => `${index + 1}. ${option.text}`)
    .join('\n');

  const system = [
    'You are a careful assistant answering quiz questions from an online learning course.',
    'You will be given a QUESTION and a numbered list of OPTIONS.',
    'Choose the option (or options) that correctly answer the question.',
    '',
    'Rules:',
    '- Answer ONLY with a single JSON object, no markdown fences, no commentary.',
    '- Required shape: {"answers": [<option numbers>], "confidence": <number between 0 and 1>, "reason": "<short explanation>"}',
    '- "answers" must be a non-empty array of integers, each between 1 and the number of options given.',
    '- Use the option NUMBER exactly as numbered in the OPTIONS list. Never invent numbers.',
    '- If the question says "select all that apply" or is marked multi-select, return ALL correct option numbers (usually more than one).',
    '- Otherwise return exactly one number.',
    '- "confidence" is your calibrated probability that the answer is correct (e.g. 0.98).',
    '- "reason" is one short sentence, no longer than 25 words.',
  ].join('\n');

  const contextBlock =
    question.context !== undefined && question.context.trim() !== ''
      ? `\nCONTEXT:\n${question.context.trim()}\n`
      : '';

  const typeBlock =
    isMulti
      ? '\nThis is a MULTI-SELECT question: you may return several option numbers in "answers".\n'
      : '\nThis is a SINGLE-SELECT question: return exactly one option number in "answers".\n';

  const user = [
    'QUESTION:',
    question.question.trim(),
    '',
    'OPTIONS:',
    optionsText,
    '',
    typeBlock + contextBlock + '\nRespond with JSON only.',
  ].join('\n');

  return { system, user };
}

export interface ParsedAnswer {
  readonly answers: readonly number[];
  readonly confidence: number;
  readonly reason: string;
}

/**
 * Strictly parse + validate the model response.
 *
 * Accepts a bare JSON object, a JSON object wrapped in a ```json fence, or an
 * object embedded in surrounding prose. Every returned index is checked against
 * the real number of visible options, and any out-of-range or non-numeric entry
 * is rejected outright rather than silently dropped.
 */
export function parseAiAnswer(raw: string, optionCount: number): ParsedAnswer {
  const candidates = extractJsonCandidates(raw);
  if (candidates.length === 0) {
    throw new AiError('AI response did not contain a JSON object', raw.slice(0, 800));
  }

  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      return validateAnswerObject(candidate, optionCount);
    } catch (error: unknown) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new AiError('AI response JSON failed validation', failures.join(' | '));
}

function extractJsonCandidates(raw: string): string[] {
  const out: string[] = [];
  const trimmed = raw.trim();

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1] !== undefined) out.push(fence[1].trim());

  const braceStart = trimmed.indexOf('{');
  const braceEnd = trimmed.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    out.push(trimmed.slice(braceStart, braceEnd + 1));
  }
  if (!out.includes(trimmed)) out.push(trimmed);

  return out;
}

function validateAnswerObject(candidate: string, optionCount: number): ParsedAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error: unknown) {
    throw new AiError(
      `AI response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AiError('AI response JSON must be an object');
  }

  const record = parsed as Record<string, unknown>;
  const rawAnswers = record['answers'] ?? record['answer'] ?? record['option'] ?? record['options'];

  let answers: number[];
  if (Array.isArray(rawAnswers)) {
    answers = [];
    for (const entry of rawAnswers) {
      const num = coerceIndex(entry);
      if (num === null) {
        throw new AiError(`AI returned a non-numeric option in "answers": ${JSON.stringify(entry)}`);
      }
      if (num < 1 || num > optionCount) {
        throw new AiError(
          `AI returned option ${num} which is out of range (1-${optionCount}). Refusing to use it.`,
        );
      }
      answers.push(num);
    }
  } else {
    const num = coerceIndex(rawAnswers);
    if (num === null) throw new AiError('AI response is missing a usable "answers" array');
    answers = [num];
  }

  if (answers.length === 0) throw new AiError('AI returned an empty "answers" array');

  const unique = [...new Set(answers)].sort((a, b) => a - b);

  const rawConfidence = record['confidence'];
  const confidence =
    typeof rawConfidence === 'number' && Number.isFinite(rawConfidence)
      ? Math.min(1, Math.max(0, rawConfidence))
      : typeof rawConfidence === 'string' && Number.isFinite(Number(rawConfidence))
        ? Math.min(1, Math.max(0, Number(rawConfidence)))
        : 0.5;

  const rawReason = record['reason'] ?? record['explanation'] ?? record['rationale'];
  const reason = typeof rawReason === 'string' && rawReason.trim() !== '' ? rawReason.trim() : 'No reason provided.';

  return { answers: unique, confidence, reason };
}

function coerceIndex(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
  if (typeof value === 'string') {
    const match = value.match(/-?\d+/);
    if (match?.[0] !== undefined) {
      const parsed = Number.parseInt(match[0], 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}
