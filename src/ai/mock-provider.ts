import {
  parseAiAnswer,
  type AiAnswer,
  type AiProvider,
  type ExtractedQuestion,
} from './provider.js';

/**
 * Deterministic offline provider used by `--doctor` and by the self-test so the
 * extraction pipeline can be validated before a real API key exists.
 * It never talks to the network.
 */
export class MockProvider implements AiProvider {
  readonly name = 'mock';

  readonly model = 'mock-heuristic-v1';

  async answerQuestion(question: ExtractedQuestion): Promise<AiAnswer> {
    const pick = chooseHeuristically(question);
    const raw = JSON.stringify(pick);
    const parsed = parseAiAnswer(raw, question.options.length);
    return {
      answers: parsed.answers,
      confidence: parsed.confidence,
      reason: parsed.reason,
      raw,
      model: this.model,
    };
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'mock provider (offline, no network calls)' };
  }
}

function chooseHeuristically(question: ExtractedQuestion): {
  answers: number[];
  confidence: number;
  reason: string;
} {
  const text = question.question.toLowerCase();
  const options = question.options;

  const trueFalseIndex = options.findIndex((option) => /^true$/i.test(option.text.trim()));
  const falseIndex = options.findIndex((option) => /^false$/i.test(option.text.trim()));
  if (trueFalseIndex !== -1 && falseIndex !== -1) {
    const saysTrue = /\b(true|yes|is|correct)\b/.test(text);
    return {
      answers: [saysTrue ? trueFalseIndex + 1 : falseIndex + 1],
      confidence: 0.6,
      reason: 'Mock heuristic: True/False question resolved by keyword matching.',
    };
  }

  const keywords = tokenize(text).filter((token) => token.length > 3);
  let bestIndex = 0;
  let bestScore = -1;
  options.forEach((option, index) => {
    const optionTokens = new Set(tokenize(option.text.toLowerCase()));
    const score = keywords.reduce((total, token) => total + (optionTokens.has(token) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  const answers =
    question.type === 'multiple' && options.length > 2
      ? [bestIndex + 1, ((bestIndex + 1) % options.length) + 1]
      : [bestIndex + 1];

  return {
    answers: [...new Set(answers)],
    confidence: 0.5,
    reason: 'Mock heuristic: keyword-overlap with option text. Configure a real AI_BASE_URL for real answers.',
  };
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#.']+/)
    .filter((token) => token.length > 0);
}
