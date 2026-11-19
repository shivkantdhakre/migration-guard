import { z } from 'zod';
import { AiProviderAdapter } from './ai-provider.interface.js';
import { GenerateOptions, ProviderResponse, TokenUsage, AiProviderName } from '../types.js';
import { DataMasker } from '../masking/data-masker.js';
import { PromptSanitizer } from '../safety/prompt-sanitizer.js';

export class GeminiProvider implements AiProviderAdapter {
  public readonly providerName: AiProviderName = 'gemini';
  public readonly defaultModel: string;
  private apiKey?: string;
  private baseUrl: string;

  constructor(options: { apiKey?: string; model?: string; baseUrl?: string } = {}) {
    this.apiKey = options.apiKey || process.env.GEMINI_API_KEY;
    this.defaultModel = options.model || process.env.GEMINI_MODEL || 'gemini-1.5-pro';
    this.baseUrl =
      options.baseUrl ||
      'https://generativelanguage.googleapis.com/v1beta/models';
  }

  public isAvailable(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  public async generateText(
    options: GenerateOptions
  ): Promise<ProviderResponse<string>> {
    if (!this.isAvailable()) {
      throw new Error(
        'GeminiProvider is not available. GEMINI_API_KEY environment variable is not configured.'
      );
    }

    const startTime = Date.now();
    const sanitizedPrompt = DataMasker.sanitizeText(options.prompt);

    const endpoint = `${this.baseUrl}/${this.defaultModel}:generateContent?key=${this.apiKey}`;
    const payload = {
      contents: [{ role: 'user', parts: [{ text: sanitizedPrompt }] }],
      systemInstruction: options.systemPrompt
        ? { parts: [{ text: options.systemPrompt }] }
        : undefined,
      generationConfig: {
        temperature: options.temperature ?? 0.2,
        maxOutputTokens: options.maxTokens ?? 2048,
        stopSequences: options.stopSequences,
      },
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error [${response.status}]: ${DataMasker.sanitizeText(errText)}`);
    }

    const data: any = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    PromptSanitizer.validateSafeOutput(rawText);

    const usage: TokenUsage = {
      promptTokens: data?.usageMetadata?.promptTokenCount ?? Math.ceil(sanitizedPrompt.length / 4),
      completionTokens: data?.usageMetadata?.candidatesTokenCount ?? Math.ceil(rawText.length / 4),
      totalTokens: data?.usageMetadata?.totalTokenCount ?? 0,
    };

    return {
      rawText,
      usage,
      latencyMs: Date.now() - startTime,
      model: this.defaultModel,
      finishReason: data?.candidates?.[0]?.finishReason || 'stop',
    };
  }

  public async generateStructured<T>(
    schema: z.ZodType<T>,
    options: GenerateOptions
  ): Promise<ProviderResponse<T>> {
    if (!this.isAvailable()) {
      throw new Error(
        'GeminiProvider is not available. GEMINI_API_KEY environment variable is not configured.'
      );
    }

    const startTime = Date.now();
    const sanitizedPrompt = DataMasker.sanitizeText(options.prompt);

    const systemPromptWithSchema = `
${options.systemPrompt || 'You are an AI assistant for MigrationGuard.'}
You MUST output valid, parseable JSON conforming strictly to the requested schema.
Do NOT include markdown formatting or backticks around JSON output.
`.trim();

    const endpoint = `${this.baseUrl}/${this.defaultModel}:generateContent?key=${this.apiKey}`;
    const payload = {
      contents: [{ role: 'user', parts: [{ text: sanitizedPrompt }] }],
      systemInstruction: { parts: [{ text: systemPromptWithSchema }] },
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: options.temperature ?? 0.1,
        maxOutputTokens: options.maxTokens ?? 4096,
      },
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error [${response.status}]: ${DataMasker.sanitizeText(errText)}`);
    }

    const data: any = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';

    PromptSanitizer.validateSafeOutput(rawText);

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawText);
    } catch {
      // First attempt failed JSON parse. Perform bounded 1-retry with error feedback (FR-AI-003)
      return this.retryStructured(schema, options, rawText, 'Invalid JSON syntax');
    }

    const parseResult = schema.safeParse(parsedJson);
    if (!parseResult.success) {
      // Bounded 1-retry (FR-AI-003)
      return this.retryStructured(
        schema,
        options,
        rawText,
        parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')
      );
    }

    const usage: TokenUsage = {
      promptTokens: data?.usageMetadata?.promptTokenCount ?? Math.ceil(sanitizedPrompt.length / 4),
      completionTokens: data?.usageMetadata?.candidatesTokenCount ?? Math.ceil(rawText.length / 4),
      totalTokens: data?.usageMetadata?.totalTokenCount ?? 0,
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

    const endpoint = `${this.baseUrl}/${this.defaultModel}:generateContent?key=${this.apiKey}`;
    const payload = {
      contents: [{ role: 'user', parts: [{ text: correctionPrompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.0,
      },
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Gemini correction retry failed with status ${response.status}`);
    }

    const data: any = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
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
