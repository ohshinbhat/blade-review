/**
 * Anthropic provider — a direct Messages API call over fetch.
 *
 * No SDK dependency: a blocking CI check should own its HTTP surface, its retry
 * policy and its timeout rather than inherit them. Retries are bounded and only
 * on transient status codes, because a review gate that retries forever is an
 * outage.
 */
import type { LlmProvider, ModelJudgment } from './provider.js';
import { extractJson, validateJudgment, JudgmentValidationError } from './provider.js';

interface AnthropicOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  knownRuleIds: Set<string>;
  knownComponents: Set<string>;
}

const TRANSIENT = new Set([408, 429, 500, 502, 503, 504]);

export class AnthropicProvider implements LlmProvider {
  readonly name: string;
  private opts: Required<Omit<AnthropicOptions, 'knownRuleIds' | 'knownComponents'>> &
    Pick<AnthropicOptions, 'knownRuleIds' | 'knownComponents'>;

  constructor(opts: AnthropicOptions) {
    this.opts = {
      apiKey: opts.apiKey,
      model: opts.model ?? process.env.BLADE_REVIEW_MODEL ?? 'claude-sonnet-4-5',
      maxTokens: opts.maxTokens ?? 2000,
      timeoutMs: opts.timeoutMs ?? 60_000,
      maxRetries: opts.maxRetries ?? 2,
      knownRuleIds: opts.knownRuleIds,
      knownComponents: opts.knownComponents,
    };
    this.name = `anthropic:${this.opts.model}`;
  }

  async judge(system: string, user: string): Promise<{ judgment: ModelJudgment; raw: string }> {
    let lastErr: Error | undefined;

    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.opts.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: this.opts.model,
            max_tokens: this.opts.maxTokens,
            // Judgment should be reproducible run to run; the eval harness measures
            // the residual variance rather than assuming there is none.
            temperature: 0,
            system,
            messages: [{ role: 'user', content: user }],
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const err = new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`);
          if (TRANSIENT.has(res.status) && attempt < this.opts.maxRetries) {
            lastErr = err;
            await sleep(400 * 2 ** attempt);
            continue;
          }
          throw err;
        }

        const data = (await res.json()) as { content?: { type: string; text?: string }[] };
        const raw = (data.content ?? [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('');

        const judgment = validateJudgment(
          extractJson(raw),
          this.opts.knownRuleIds,
          this.opts.knownComponents,
        );
        return { judgment, raw };
      } catch (err) {
        lastErr = err as Error;
        // A schema violation is worth exactly one retry: the follow-up prompt is
        // stricter, and if the model cannot produce valid output twice the right
        // answer is to route to a human, not to guess.
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

    throw lastErr ?? new Error('Anthropic provider failed with no error recorded.');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
