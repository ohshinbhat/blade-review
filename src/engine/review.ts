/**
 * The engine. `review()` is the entire public API.
 *
 * The CLI and the CI adapter are both thin wrappers over this function — the form
 * factor is a delivery detail, this is the product. Control flow is deterministic
 * top to bottom: no agent loop, no tool calls, no model-driven branching. The
 * model contributes exactly one structured judgment at one point in the pipeline,
 * and Layer 3 decides what to do with it.
 */
import type { ProposedChange, Verdict, Finding, VerdictStatus } from '../types.js';
import type { BladeGraph } from '../extract/graph.js';
import type { LlmProvider } from './llm/provider.js';
import { buildChangeModel } from '../checks/changeModel.js';
import { runDeterministicChecks } from '../checks/index.js';
import { buildContext } from '../knowledge/retrieval.js';
import type { ContextBundle } from '../knowledge/retrieval.js';
import { RULEBOOK } from '../knowledge/rulebook.js';
import { SYSTEM_PROMPT, buildUserMessage } from './prompt.js';
import { OfflineProvider } from './llm/offline.js';
import { AnthropicProvider } from './llm/anthropic.js';

export interface ReviewOptions {
  provider?: LlmProvider;
  /** Confidence below which a model verdict is routed to a human instead of enforced. */
  confidenceThreshold?: number;
  /** Skip the model entirely (deterministic floor only). */
  deterministicOnly?: boolean;
}

/**
 * Routing thresholds — Layer 3.
 *
 * Asymmetric on purpose. A false reject costs a designer a round trip; a false
 * approve corrupts the design system permanently and silently. So an uncertain
 * 'correct' becomes 'needs_human', while an uncertain 'incorrect' is still
 * surfaced (as a non-blocking comment) because the cost of showing it is low.
 */
const DEFAULT_APPROVE_THRESHOLD = 0.75;

export function createProvider(
  graph: BladeGraph,
  bundleRef: { current?: ContextBundle },
): LlmProvider {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return new OfflineProvider(bundleRef);
  return new AnthropicProvider({
    apiKey,
    knownRuleIds: new Set(RULEBOOK.map((r) => r.id)),
    knownComponents: new Set(graph.allComponentNames()),
  });
}

export async function review(
  change: ProposedChange,
  graph: BladeGraph,
  options: ReviewOptions = {},
): Promise<Verdict> {
  const started = Date.now();
  const threshold = options.confidenceThreshold ?? DEFAULT_APPROVE_THRESHOLD;

  // ---- Layer 1: deterministic -------------------------------------------
  const model = buildChangeModel(change, graph);
  const deterministicFindings = runDeterministicChecks(model, graph);

  // ---- Retrieval ---------------------------------------------------------
  const bundle = buildContext(model, graph, deterministicFindings);
  const bundleRef = { current: bundle };
  const provider = options.provider ?? createProvider(graph, bundleRef);

  // The computed cascade is authoritative and is attached to the verdict whether
  // or not the model ran.
  const cascade = bundle.cascade.filter((c) => c.affectedComponents.length > 0);

  const blockers = deterministicFindings.filter((f) => f.severity === 'blocker');

  // ---- Layer 2: judgment -------------------------------------------------
  let findings: Finding[] = [...deterministicFindings];
  let status: VerdictStatus;
  let confidence: number;
  let summary: string;
  let reasoning: string;
  let rulesCited: string[];
  let suggestedApproach: string | undefined;
  let decidedBy: Verdict['decidedBy'];
  let providerName = 'deterministic-only';

  if (options.deterministicOnly) {
    status = blockers.length ? 'incorrect' : 'needs_human';
    confidence = blockers.length ? 0.95 : 0.3;
    summary = blockers.length
      ? `${blockers.length} architectural rule violation(s).`
      : 'No deterministic violation; judgment layer disabled.';
    reasoning = blockers.map((f) => `${f.ruleId}: ${f.message}`).join('\n') || 'No mechanical violations found.';
    rulesCited = [...new Set(blockers.map((f) => f.ruleId))];
    decidedBy = 'deterministic';
  } else {
    providerName = provider.name;
    try {
      const { judgment } = await provider.judge(SYSTEM_PROMPT, buildUserMessage(model, bundle));

      status = judgment.status;
      confidence = judgment.confidence;
      summary = judgment.summary;
      reasoning = judgment.reasoning;
      rulesCited = judgment.rulesCited;
      suggestedApproach = judgment.suggestedApproach;
      decidedBy = 'model';

      // The model's non-deterministic findings are recorded as MODEL provenance so
      // a reader can always tell which half of the verdict is proven.
      if (judgment.status === 'incorrect' && !blockers.length) {
        findings.push({
          ruleId: judgment.rulesCited[0] ?? 'JUDGMENT',
          category: inferCategory(judgment.rulesCited),
          severity: 'warning',
          message: judgment.summary,
          evidence: [judgment.reasoning],
          suggestion: judgment.suggestedApproach
            ? { before: change.intent, after: judgment.suggestedApproach }
            : undefined,
          provenance: 'MODEL',
        });
      }
    } catch (err) {
      // A judgment-layer failure must never approve a change and must never hard-fail
      // the build. It falls back to the proven layer and routes to a human.
      status = blockers.length ? 'incorrect' : 'needs_human';
      confidence = blockers.length ? 0.95 : 0;
      summary = blockers.length
        ? `${blockers.length} architectural rule violation(s); judgment layer unavailable.`
        : 'Judgment layer unavailable — routing to a human reviewer.';
      reasoning = `Provider error: ${(err as Error).message}`;
      rulesCited = [...new Set(blockers.map((f) => f.ruleId))];
      decidedBy = 'routing';
    }
  }

  // ---- Layer 3: routing --------------------------------------------------
  // Proven blockers always win. A model cannot approve past a deterministic
  // violation — that is the point of proving it.
  if (blockers.length && status !== 'incorrect') {
    status = 'incorrect';
    confidence = Math.max(confidence, 0.95);
    summary = `${blockers.length} architectural rule violation(s) proven by static analysis.`;
    rulesCited = [...new Set([...rulesCited, ...blockers.map((f) => f.ruleId)])];
    decidedBy = 'routing';
  }

  // An under-confident approval becomes a deferral, never an approval.
  if (status === 'correct' && confidence < threshold) {
    status = 'needs_human';
    summary = `Likely correct, but below the ${threshold} confidence threshold for automatic approval. ${summary}`;
    decidedBy = 'routing';
  }

  return {
    status,
    confidence,
    summary,
    reasoning,
    rulesCited: [...new Set(rulesCited)],
    findings,
    cascade,
    suggestedApproach,
    decidedBy,
    meta: {
      bladeRef: graph.bladeRef,
      provider: providerName,
      latencyMs: Date.now() - started,
      contextTokensApprox: bundle.approxTokens,
    },
  };
}

function inferCategory(ruleIds: string[]): Finding['category'] {
  const id = ruleIds[0] ?? '';
  if (id.startsWith('CAS')) return 'cascading';
  if (id.startsWith('REUSE')) return 'reuse';
  return 'encoding';
}
