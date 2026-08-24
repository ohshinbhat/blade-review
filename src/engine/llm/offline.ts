/**
 * Offline provider — the deterministic floor.
 *
 * This is NOT a mock that pretends to be a model. It is a real, honest judge that
 * reasons only from what Layer 1 proved, and abstains (`needs_human`) whenever the
 * deterministic layer found nothing conclusive.
 *
 * Two reasons it exists:
 *  1. The whole system — CLI, CI adapter, eval harness — runs end to end with no
 *     API key and no network. Anyone can clone this and see it work.
 *  2. It gives the eval harness a control arm. Reporting "deterministic floor:
 *     X, with model: Y" shows exactly what the model is contributing, which is a
 *     question every reviewer of an LLM system should ask and few can answer.
 */
import type { LlmProvider, ModelJudgment } from './provider.js';
import type { ContextBundle } from '../../knowledge/retrieval.js';

export class OfflineProvider implements LlmProvider {
  readonly name = 'offline:deterministic-floor';

  constructor(private readonly bundleRef: { current?: ContextBundle }) {}

  async judge(): Promise<{ judgment: ModelJudgment; raw: string }> {
    const bundle = this.bundleRef.current;
    const findings = bundle?.deterministicFindings ?? [];

    const blockers = findings.filter((f) => f.severity === 'blocker');
    const warnings = findings.filter((f) => f.severity === 'warning');
    const cascadeSet = new Set<string>();
    for (const c of bundle?.cascade ?? []) for (const comp of c.affectedComponents) cascadeSet.add(comp);

    let judgment: ModelJudgment;

    if (blockers.length) {
      judgment = {
        status: 'incorrect',
        confidence: 0.95,
        summary: `${blockers.length} architectural rule${blockers.length > 1 ? 's' : ''} violated.`,
        reasoning: blockers.map((f) => `${f.ruleId}: ${f.message}`).join('\n'),
        rulesCited: [...new Set(blockers.map((f) => f.ruleId))],
        affectedComponents: [...cascadeSet],
        suggestedApproach: blockers.find((f) => f.suggestion)?.suggestion
          ? `Replace \`${blockers.find((f) => f.suggestion)!.suggestion!.before}\` with \`${blockers.find((f) => f.suggestion)!.suggestion!.after}\`.`
          : undefined,
      };
    } else if (warnings.length) {
      judgment = {
        status: 'needs_human',
        confidence: 0.5,
        summary: `${warnings.length} advisory finding${warnings.length > 1 ? 's' : ''}; no blocking violation.`,
        reasoning:
          warnings.map((f) => `${f.ruleId}: ${f.message}`).join('\n') +
          '\n\nThe deterministic layer found no blocking violation. Architectural judgment on the remaining question requires the model provider or a human reviewer.',
        rulesCited: [...new Set(warnings.map((f) => f.ruleId))],
        affectedComponents: [...cascadeSet],
      };
    } else {
      // Critically: no findings does NOT mean correct. It means the deterministic
      // layer had nothing to say. Claiming "correct" here would be the single most
      // dangerous failure mode this system has — a false approve.
      judgment = {
        status: 'needs_human',
        confidence: 0.3,
        summary: 'No deterministic violation found; architectural judgment not available offline.',
        reasoning:
          'Layer 1 found no rule violation. Deciding whether this is the *right* way to build the change requires the judgment layer. Running offline, so this routes to a human rather than being approved by default.',
        rulesCited: [],
        affectedComponents: [...cascadeSet],
      };
    }

    return { judgment, raw: JSON.stringify(judgment) };
  }
}
