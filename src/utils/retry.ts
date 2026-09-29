import { logger } from './logger.js';

export interface RetryOptions {
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly label: string;
  readonly retryOn?: (error: unknown) => boolean;
}

export const DEFAULT_RETRY: RetryOptions = {
  attempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5_000,
  label: 'operation',
};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function withJitter(ms: number): number {
  const jitter = Math.floor(Math.random() * Math.min(400, Math.max(50, ms * 0.25)));
  return ms + jitter;
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error: unknown) {
    if (controller.signal.aborted) {
      throw new TimeoutError(`"${label}" timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bounded exponential backoff. Always gives up - there are no unbounded loops.
 */
export async function retry<T>(
  operation: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_RETRY.attempts);
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs;
  const label = options.label ?? DEFAULT_RETRY.label;
  const shouldRetry = options.retryOn ?? ((): boolean => true);

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      lastError = error;
      const isLast = attempt >= attempts;
      if (isLast || !shouldRetry(error)) break;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      logger.debug(
        `${label} failed (attempt ${attempt}/${attempts}): ${
          error instanceof Error ? error.message : String(error)
        }. Retrying in ${delay}ms`,
      );
      await sleep(withJitter(delay));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${label} failed: ${String(lastError)}`);
}
