import type { AiProvider } from './provider.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { MockProvider } from './mock-provider.js';
import type { AppConfig } from '../config.js';
import { logger } from '../utils/logger.js';

export * from './provider.js';
export { OpenAICompatibleProvider } from './openai-compatible.js';
export { MockProvider } from './mock-provider.js';

export interface CreateProviderOptions {
  /** Force the offline mock provider (used by --doctor and self-tests). */
  readonly forceMock?: boolean;
}

export function createAiProvider(config: AppConfig, options: CreateProviderOptions = {}): AiProvider {
  if (options.forceMock === true) {
    return new MockProvider();
  }

  const baseUrlMissing = config.ai.baseUrl.trim() === '';
  const modelMissing = config.ai.model.trim() === '';
  if (baseUrlMissing || modelMissing) {
    throw new Error('AI_BASE_URL and AI_MODEL must be set in .env (see .env.example).');
  }

  const provider = new OpenAICompatibleProvider(config);
  logger.debug(`AI provider: ${provider.name} model=${provider.model}`);
  return provider;
}
