/**
 * LLM provider interface.
 *
 * Deliberately narrow: the engine asks for one structured judgment and gets one
 * back. There is no agent loop, no tool use, no multi-turn state. The decision
 * procedure lives in TypeScript where it can be read, tested and diffed; the
 * model supplies judgment on a single well-scoped question.
 */

export interface ModelJudgment {
  status: 'correct' | 'incorrect' | 'needs_human';
  confidence: number;
  summary: string;
  reasoning: string;
  rulesCited: string[];
  affectedComponents: string[];
  suggestedApproach?: string;
}

export interface LlmProvider {
  readonly name: string;
  judge(system: string, user: string): Promise<{ judgment: ModelJudgment; raw: string }>;
}

/** JSON Schema the model must satisfy. Also used to validate the response. */
export const JUDGMENT_SCHEMA = {
  type: 'object',
  required: ['status', 'confidence', 'summary', 'reasoning', 'rulesCited'],
  properties: {
    status: { type: 'string', enum: ['correct', 'incorrect', 'needs_human'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    summary: { type: 'string' },
    reasoning: { type: 'string' },
    rulesCited: { type: 'array', items: { type: 'string' } },
    affectedComponents: { type: 'array', items: { type: 'string' } },
    suggestedApproach: { type: 'string' },
  },
} as const;

export class JudgmentValidationError extends Error {}

/**
 * Validate and normalise a model response.
 *
 * `knownRuleIds` and `knownComponents` are passed in so a model that cites a rule
 * or a component that does not exist is caught here rather than reaching a
 * designer. Grounding is enforced, not hoped for.
 */
export function validateJudgment(
  value: unknown,
  knownRuleIds: Set<string>,
  knownComponents: Set<string>,
): ModelJudgment {
  if (typeof value !== 'object' || value === null) {
    throw new JudgmentValidationError('Model response was not a JSON object.');
  }
  const v = value as Record<string, unknown>;

  const status = v.status;
  if (status !== 'correct' && status !== 'incorrect' && status !== 'needs_human') {
    throw new JudgmentValidationError(`Invalid status: ${JSON.stringify(status)}`);
  }

  const confidence = typeof v.confidence === 'number' ? Math.max(0, Math.min(1, v.confidence)) : NaN;
  if (Number.isNaN(confidence)) throw new JudgmentValidationError('confidence must be a number.');

  if (typeof v.summary !== 'string' || typeof v.reasoning !== 'string') {
    throw new JudgmentValidationError('summary and reasoning must be strings.');
  }

  const rawRules = Array.isArray(v.rulesCited) ? v.rulesCited.map(String) : [];
  const unknown = rawRules.filter((r) => !knownRuleIds.has(r));
  if (unknown.length) {
    throw new JudgmentValidationError(
      `Model cited rules that do not exist in the rulebook: ${unknown.join(', ')}`,
    );
  }

  const rawComponents = Array.isArray(v.affectedComponents) ? v.affectedComponents.map(String) : [];
  // Silently drop hallucinated components rather than failing: the deterministic
  // cascade set is authoritative anyway and is merged in by the caller.
  const affectedComponents = rawComponents.filter((c) => knownComponents.has(c));

  return {
    status,
    confidence,
    summary: v.summary,
    reasoning: v.reasoning,
    rulesCited: rawRules,
    affectedComponents,
    suggestedApproach: typeof v.suggestedApproach === 'string' ? v.suggestedApproach : undefined,
  };
}

/** Extract the first JSON object from a model response that may be fenced or prefixed. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new JudgmentValidationError('No JSON object found in model response.');
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (err) {
    throw new JudgmentValidationError(`Model response was not valid JSON: ${(err as Error).message}`);
  }
}
