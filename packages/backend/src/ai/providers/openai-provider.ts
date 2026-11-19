import { z } from 'zod';
import { AiProviderAdapter } from './ai-provider.interface.js';
import { GenerateOptions, ProviderResponse, TokenUsage, AiProviderName } from '../types.js';
import { DataMasker } from '../masking/data-masker.js';
import { PromptSanitizer } from '../safety/prompt-sanitizer.js';

export class OpenAiProvider implements AiProviderAdapter {
  public readonly providerName: AiProviderName = 'openai';
  public readonly defaultModel: string;
  private apiKey?: string;
  private baseUrl: string;

  constructor(options: { apiKey?: string; model?: string; baseUrl?: string } = {}) {
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY;
    this.defaultModel = options.model || process.env.OPENAI_MODEL || 'gpt-4o';
    this.baseUrl = options.baseUrl || 'https://api.openai.com/v1';
  }

  public isAvailable(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  public async generateText(
    options: GenerateOptions
  ): Promise<ProviderResponse<string>> {
    if (!this.isAvailable()) {
      throw new Error(
        'OpenAiProvider is not available. OPENAI_API_KEY environment variable is not configured.'
      );
    }

    const startTime = Date.now();
    const sanitizedPrompt = DataMasker.sanitizeText(options.prompt);

    const messages = [];
    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: sanitizedPrompt });

    const payload = {
      model: this.defaultModel,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 2048,
      stop: options.stopSequences,
    };

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API error [${response.status}]: ${DataMasker.sanitizeText(errText)}`);
    }

    const data: any = await response.json();
    const rawText = data?.choices?.[0]?.message?.content ?? '';
    PromptSanitizer.validateSafeOutput(rawText);

    const usage: TokenUsage = {
      promptTokens: data?.usage?.prompt_tokens ?? Math.ceil(sanitizedPrompt.length / 4),
      completionTokens: data?.usage?.completion_tokens ?? Math.ceil(rawText.length / 4),
      totalTokens: data?.usage?.total_tokens ?? 0,
    };

    return {
      rawText,
      usage,
      latencyMs: Date.now() - startTime,
      model: this.defaultModel,
      finishReason: data?.choices?.[0]?.finish_reason || 'stop',
    };
  }

  public async generateStructured<T>(
    schema: z.ZodType<T>,
    options: GenerateOptions
  ): Promise<ProviderResponse<T>> {
    if (!this.isAvailable()) {
      throw new Error(
        'OpenAiProvider is not available. OPENAI_API_KEY environment variable is not configured.'
      );
    }

    const startTime = Date.now();
    const sanitizedPrompt = DataMasker.sanitizeText(options.prompt);

    const systemPromptWithSchema = `
${options.systemPrompt || 'You are an AI assistant for MigrationGuard.'}
You MUST output valid, parseable JSON conforming strictly to the requested schema.
`.trim();

    const payload = {
      model: this.defaultModel,
      messages: [
        { role: 'system', content: systemPromptWithSchema },
        { role: 'user', content: sanitizedPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: options.temperature ?? 0.1,
      max_tokens: options.maxTokens ?? 4096,
    };

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API error [${response.status}]: ${DataMasker.sanitizeText(errText)}`);
    }

    const data: any = await response.json();
    const rawText = data?.choices?.[0]?.message?.content ?? '{}';
    PromptSanitizer.validateSafeOutput(rawText);

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawText);
    } catch {
      return this.retryStructured(schema, options, rawText, 'Invalid JSON syntax');
    }

    const parseResult = schema.safeParse(parsedJson);
    if (!parseResult.success) {
      return this.retryStructured(
        schema,
        options,
        rawText,
        parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')
      );
    }

    const usage: TokenUsage = {
      promptTokens: data?.usage?.prompt_tokens ?? Math.ceil(sanitizedPrompt.length / 4),
      completionTokens: data?.usage?.completion_tokens ?? Math.ceil(rawText.length / 4),
      totalTokens: data?.usage?.total_tokens ?? 0,
    };

    return {
      rawText,
      parsed: parseResult.data,
      usage,
      latencyMs: Date.now() - startTime,
      model: this.defaultModel,
      finishReason: 'stop',
    };
  }

  private async retryStructured<T>(
    schema: z.ZodType<T>,
    options: GenerateOptions,
    previousOutput: string,
    errorDetails: string
  ): Promise<ProviderResponse<T>> {
    const correctionPrompt = `
The previous output failed schema validation with error: ${errorDetails}
Previous output was:
${previousOutput}

Please fix the output so it strictly adheres to the JSON schema. Return only valid JSON.
`.trim();

    const payload = {
      model: this.defaultModel,
      messages: [
        { role: 'user', content: correctionPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.0,
    };

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`OpenAI correction retry failed with status ${response.status}`);
    }

    const data: any = await response.json();
    const rawText = data?.choices?.[0]?.message?.content ?? '{}';
    PromptSanitizer.validateSafeOutput(rawText);

    const parsedJson = JSON.parse(rawText);
    const parsed = schema.parse(parsedJson);

    return {
      rawText,
      parsed,
      usage: {
        promptTokens: 250,
        completionTokens: 200,
        totalTokens: 450,
      },
      latencyMs: 100,
      model: this.defaultModel,
      finishReason: 'retry_success',
    };
  }
}
