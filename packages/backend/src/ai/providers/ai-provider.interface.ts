import { z } from 'zod';
import { GenerateOptions, ProviderResponse, AiProviderName } from '../types.js';

export interface AiProviderAdapter {
  readonly providerName: AiProviderName;
  readonly defaultModel: string;

  /**
   * Check whether the provider is configured and available (e.g., API key present or offline mock).
   */
  isAvailable(): boolean;

  /**
   * Generate raw text response from prompt.
   */
  generateText(options: GenerateOptions): Promise<ProviderResponse<string>>;

  /**
   * Generate structured output validated against a Zod schema.
   * Performs at most 1 bounded retry if the output initially fails schema validation (FR-AI-003).
   */
  generateStructured<T>(
    schema: z.ZodType<T>,
    options: GenerateOptions
  ): Promise<ProviderResponse<T>>;
}
