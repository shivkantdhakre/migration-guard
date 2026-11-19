import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockProvider } from '../../src/ai/providers/mock-provider.js';
import { AiProviderFactory } from '../../src/ai/providers/provider-factory.js';
import { AiService } from '../../src/ai/ai.service.js';
import { GeminiProvider } from '../../src/ai/providers/gemini-provider.js';
import { OpenAiProvider } from '../../src/ai/providers/openai-provider.js';

describe('AI Offline Deterministic Mock & Provider Abstraction (FR-AI-007)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    AiProviderFactory.reset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    AiProviderFactory.reset();
  });

  it('should default to deterministic MockProvider when no external provider is configured', () => {
    delete process.env.AI_PROVIDER;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const provider = AiProviderFactory.getProvider();
    expect(provider).toBeInstanceOf(MockProvider);
    expect(provider.providerName).toBe('mock');
    expect(provider.isAvailable()).toBe(true);
  });

  it('should generate deterministic text response offline without network calls', async () => {
    const provider = new MockProvider();
    const res = await provider.generateText({
      prompt: 'Summarize migration plan',
    });

    expect(res.rawText).toBeDefined();
    expect(res.usage.totalTokens).toBeGreaterThan(0);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    expect(res.model).toBe('mock-deterministic-v1');
  });

  it('should remain 100% operational when AI is disabled via AI_ENABLED=false (FR-AI-007)', async () => {
    process.env.AI_ENABLED = 'false';

    const aiService = new AiService();
    expect(aiService.isAiEnabled()).toBe(false);

    // MockProvider still provides safe fallback without crashing application
    const provider = AiProviderFactory.getProvider();
    expect(provider.providerName).toBe('mock');
  });

  it('should report unavailability for Gemini and OpenAI when API keys are missing', () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const gemini = new GeminiProvider();
    expect(gemini.isAvailable()).toBe(false);

    const openai = new OpenAiProvider();
    expect(openai.isAvailable()).toBe(false);
  });

  it('should fallback to MockProvider when external provider is requested but unavailable', () => {
    delete process.env.GEMINI_API_KEY;
    process.env.AI_PROVIDER = 'gemini';

    const provider = AiProviderFactory.getProvider('gemini');
    expect(provider.providerName).toBe('mock');
  });
});
