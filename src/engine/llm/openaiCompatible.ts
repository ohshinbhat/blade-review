/**
 * Provider for OpenAI-compatible Chat Completions APIs.
 *
 * OpenRouter implements this wire format, so the review engine can use any
 * model exposed by OpenRouter without adding a model-vendor SDK.
 */
import type { LlmProvider, ModelJudgment } from './provider.js';
import { extractJson, validateJudgment, JudgmentValidationError } from './provider.js';

interface OpenAICompatibleOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  providerName: string;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  headers?: Record<string, string>;
  knownRuleIds: Set<string>;
  knownComponents: Set<string>;
  fetchImpl?: typeof fetch;
}

const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);

export class OpenAICompatibleProvider implements LlmProvider {
  readonly name: string;
  private opts: Required<Omit<OpenAICompatibleOptions, 'headers'>> &
    Pick<OpenAICompatibleOptions, 'headers'>;

  constructor(opts: OpenAICompatibleOptions) {
    this.opts = {
      ...opts,
      maxTokens: opts.maxTokens ?? 2000,
      timeoutMs: opts.timeoutMs ?? 60_000,
      maxRetries: opts.maxRetries ?? 2,
      fetchImpl: opts.fetchImpl ?? fetch,
    };
    this.name = `${opts.providerName}:${opts.model}`;
  }

  async judge(system: string, user: string): Promise<{ judgment: ModelJudgment; raw: string }> {
    let lastErr: Error | undefined;

    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
      try {
        const res = await this.opts.fetchImpl(
          `${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${this.opts.apiKey}`,
              ...this.opts.headers,
            },
            body: JSON.stringify({
              model: this.opts.model,
              max_tokens: this.opts.maxTokens,
              temperature: 0,
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
              ],
            }),
            signal: controller.signal,
          },
        );

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const err = new Error(
            `${this.opts.providerName} API ${res.status}: ${body.slice(0, 300)}`,
          );
          if (TRANSIENT.has(res.status) && attempt < this.opts.maxRetries) {
            lastErr = err;
            await sleep(400 * 2 ** attempt);
            continue;
          }
          throw err;
        }

        const data = (await res.json()) as {
          choices?: { message?: { content?: string | { type?: string; text?: string }[] } }[];
        };
        const content = data.choices?.[0]?.message?.content;
        const raw = Array.isArray(content)
          ? content.map((part) => part.text ?? '').join('')
          : (content ?? '');

        const judgment = validateJudgment(
          extractJson(raw),
          this.opts.knownRuleIds,
          this.opts.knownComponents,
        );
        return { judgment, raw };
      } catch (err) {
        lastErr = err as Error;
        const retryable =
          err instanceof JudgmentValidationError || (err as Error).name === 'AbortError';
        if (retryable && attempt < this.opts.maxRetries) {
          user = `${user}\n\nYour previous response was rejected: ${(err as Error).message}\nRespond with a single valid JSON object and nothing else.`;
          continue;
        }
        if (attempt >= this.opts.maxRetries) break;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastErr ?? new Error(`${this.opts.providerName} provider failed with no recorded error.`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
