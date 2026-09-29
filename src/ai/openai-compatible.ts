import {
  AiError,
  buildPrompt,
  parseAiAnswer,
  type AiAnswer,
  type AiProvider,
  type ExtractedQuestion,
} from './provider.js';
import type { AppConfig } from '../config.js';
import { logger } from '../utils/logger.js';
import { retry, withTimeout } from '../utils/retry.js';

interface ChatCompletionRequest {
  readonly model: string;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
  readonly temperature: number;
  readonly max_tokens: number;
  readonly response_format?: { readonly type: string };
}

interface ChatCompletionResponse {
  readonly choices?: ReadonlyArray<{
    readonly message?: { readonly content?: string | null };
    readonly finish_reason?: string | null;
  }>;
  readonly error?: { readonly message?: string; readonly type?: string };
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/**
 * OpenAI-compatible chat completions client.
 *
 * Works with OpenAI, OpenRouter, Groq, LM Studio, Ollama, llama.cpp,
 * vLLM, and anything else that speaks /v1/chat/completions.
 */
export class OpenAICompatibleProvider implements AiProvider {
  readonly name = 'openai-compatible';

  readonly model: string;

  private readonly endpoint: string;

  private readonly apiKey: string;

  private readonly temperature: number;

  private readonly maxTokens: number;

  private readonly timeoutMs: number;

  private readonly retries: number;

  private readonly extraHeaders: Readonly<Record<string, string>> | undefined;

  constructor(config: AppConfig) {
    this.endpoint = `${config.ai.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    this.apiKey = config.ai.apiKey;
    this.model = config.ai.model;
    this.temperature = config.ai.temperature;
    this.maxTokens = config.ai.maxTokens;
    this.timeoutMs = config.ai.timeoutMs;
    this.retries = Math.max(0, config.ai.retries);
    this.extraHeaders = config.ai.extraHeaders;

    if (this.apiKey === '' && !this.isLocalEndpoint(config.ai.baseUrl)) {
      logger.warn('AI_API_KEY is empty. Requests will likely be rejected by the provider.');
    }
  }

  private isLocalEndpoint(baseUrl: string): boolean {
    return /^(https?:\/\/)?(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(baseUrl);
  }

  async answerQuestion(question: ExtractedQuestion): Promise<AiAnswer> {
    if (question.options.length === 0) {
      throw new AiError('Question has no visible answer options; nothing to send to the AI.');
    }

    const { system, user } = buildPrompt(question);
    const body: ChatCompletionRequest = {
      model: this.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: this.temperature,
      max_tokens: this.maxTokens,
    };

    const raw = await retry(
      async () => this.send(body),
      {
        attempts: this.retries + 1,
        baseDelayMs: 800,
        maxDelayMs: 8_000,
        label: `AI request to ${this.model}`,
      },
    );

    const parsed = parseAiAnswer(raw, question.options.length);
    return {
      answers: parsed.answers,
      confidence: parsed.confidence,
      reason: parsed.reason,
      raw,
      model: this.model,
    };
  }

  private async send(body: ChatCompletionRequest): Promise<string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.extraHeaders ?? {}),
    };
    if (this.apiKey !== '') {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const response = await withTimeout(
      async (signal) =>
        fetch(this.endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        }),
      this.timeoutMs,
      `AI request to ${this.endpoint}`,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new AiError(
        `AI provider returned HTTP ${response.status} ${response.statusText}`,
        isRetryableStatus(response.status) ? text.slice(0, 500) : `${text.slice(0, 500)} (not retried)`,
      );
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error: unknown) {
      throw new AiError(
        `AI provider returned non-JSON response: ${error instanceof Error ? error.message : String(error)}`,
        text.slice(0, 500),
      );
    }

    return extractContent(parsed);
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    const url = `${this.endpoint.replace(/\/chat\/completions$/, '')}/models`;
    const headers: Record<string, string> = { ...(this.extraHeaders ?? {}) };
    if (this.apiKey !== '') headers['Authorization'] = `Bearer ${this.apiKey}`;

    try {
      const response = await withTimeout((signal) => fetch(url, { headers, signal }), 15_000, `GET ${url}`);
      if (response.ok) {
        return { ok: true, detail: `${this.endpoint} reachable (HTTP ${response.status})` };
      }
      // Some gateways do not expose /models; that is not fatal.
      if (response.status === 401 || response.status === 403) {
        return { ok: false, detail: `Authentication failed (HTTP ${response.status}). Check AI_API_KEY.` };
      }
      return { ok: true, detail: `${this.endpoint} responded HTTP ${response.status} (models endpoint not usable)` };
    } catch (error: unknown) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}

function extractContent(parsed: unknown): string {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new AiError('AI provider response was not a JSON object');
  }
  const record = parsed as ChatCompletionResponse;
  if (record.error !== undefined) {
    throw new AiError(`AI provider error: ${record.error.message ?? record.error.type ?? 'unknown'}`);
  }
  const choice = record.choices?.[0];
  if (choice === undefined) {
    throw new AiError('AI provider response contained no choices');
  }
  const content = choice.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new AiError(
      `AI provider returned an empty message (finish_reason=${choice.finish_reason ?? 'unknown'})`,
    );
  }
  return content;
}
