import { AiProviderAdapter } from './ai-provider.interface.js';
import { MockProvider } from './mock-provider.js';
import { GeminiProvider } from './gemini-provider.js';
import { OpenAiProvider } from './openai-provider.js';
import { AiProviderName } from '../types.js';

export class AiProviderFactory {
  private static instance: AiProviderAdapter | null = null;
  private static mockProviderInstance: MockProvider = new MockProvider();

  /**
   * Get the active AI provider adapter based on environment configuration.
   * Priority:
   * 1. If AI_ENABLED is 'false', returns an offline stub/mock provider.
   * 2. If AI_PROVIDER is 'gemini' and GEMINI_API_KEY is set, returns GeminiProvider.
   * 3. If AI_PROVIDER is 'openai' and OPENAI_API_KEY is set, returns OpenAiProvider.
   * 4. Otherwise, defaults to offline deterministic MockProvider (FR-AI-007).
   */
  public static getProvider(overrideProvider?: AiProviderName): AiProviderAdapter {
    const aiEnabled = process.env.AI_ENABLED !== 'false';
    const providerType =
      overrideProvider ||
      (process.env.AI_PROVIDER as AiProviderName) ||
      'mock';

    if (!aiEnabled) {
      // In offline / disabled mode, MockProvider is used as safe fallback
      return this.mockProviderInstance;
    }

    if (overrideProvider) {
      return this.instantiateProvider(overrideProvider);
    }

    if (!this.instance) {
      this.instance = this.instantiateProvider(providerType);
    }
    return this.instance;
  }

  public static getMockProvider(): MockProvider {
    return this.mockProviderInstance;
  }

  public static reset(): void {
    this.instance = null;
  }

  private static instantiateProvider(type: AiProviderName): AiProviderAdapter {
    switch (type) {
      case 'gemini': {
        const gemini = new GeminiProvider();
        return gemini.isAvailable() ? gemini : this.mockProviderInstance;
      }
      case 'openai': {
        const openai = new OpenAiProvider();
        return openai.isAvailable() ? openai : this.mockProviderInstance;
      }
      case 'mock':
      default:
        return this.mockProviderInstance;
    }
  }
}
