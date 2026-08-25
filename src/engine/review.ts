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
import { OpenAICompatibleProvider } from './llm/openaiCompatible.js';

export interface ReviewOptions {
  provider?: LlmProvider;
  /** Base-commit graph used for "did this already exist?" prior-art checks. */
  priorGraph?: BladeGraph;
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
  const requested = process.env.BLADE_REVIEW_PROVIDER?.toLowerCase();
  const knownRuleIds = new Set(RULEBOOK.map((r) => r.id));
  const knownComponents = new Set(graph.allComponentNames());

  if (requested === 'offline') return new OfflineProvider(bundleRef);

  // Preserve the existing zero-config Anthropic behaviour when no provider is
  // selected. OpenRouter is auto-selected when it is the only configured key.
  const useOpenRouter =
    requested === 'openrouter' || (!requested && !process.env.ANTHROPIC_API_KEY && !!process.env.OPENROUTER_API_KEY);
  if (useOpenRouter) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('BLADE_REVIEW_PROVIDER=openrouter requires OPENROUTER_API_KEY.');

    const headers: Record<string, string> = {};
    if (process.env.OPENROUTER_SITE_URL) headers['HTTP-Referer'] = process.env.OPENROUTER_SITE_URL;
    if (process.env.OPENROUTER_APP_NAME) headers['X-Title'] = process.env.OPENROUTER_APP_NAME;

    return new OpenAICompatibleProvider({
      apiKey,
      model: process.env.BLADE_REVIEW_MODEL ?? 'openai/gpt-4o-mini',
      baseUrl: process.env.BLADE_REVIEW_BASE_URL ?? 'https://openrouter.ai/api/v1',
      providerName: 'openrouter',
      headers,
      knownRuleIds,
      knownComponents,
    });
  }

  if (requested && requested !== 'anthropic') {
    throw new Error(`Unknown BLADE_REVIEW_PROVIDER ${JSON.stringify(requested)}. Use offline, anthropic, or openrouter.`);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    if (requested === 'anthropic') {
      throw new Error('BLADE_REVIEW_PROVIDER=anthropic requires ANTHROPIC_API_KEY.');
    }
    return new OfflineProvider(bundleRef);
  }
  return new AnthropicProvider({ apiKey, knownRuleIds, knownComponents });
}

export async function review(
  change: ProposedChange,
  graph: BladeGraph,
  options: ReviewOptions = {},
): Promise<Verdict> {
  const started = Date.now();
  const threshold = options.confidenceThreshold ?? DEFAULT_APPROVE_THRESHOLD;
  const priorGraph = options.priorGraph ?? graph;

  // ---- Layer 1A/1B: deterministic facts + semantic UI structure ---------
  const model = buildChangeModel(change, graph);
  if (
    model.targetComponents.some(
      (name) => !priorGraph.component(name) && graph.component(name),
    )
  ) {
    model.proposesNewComponent = true;
  }
  const deterministicFindings = runDeterministicChecks(model, graph, priorGraph);

  // ---- Retrieval ---------------------------------------------------------
  const bundle = buildContext(model, graph, deterministicFindings, priorGraph);
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
    // Mirrors OfflineProvider's three-way split (blocker / warning / nothing) —
    // the same distinction had no observable effect before COMP-001 and the
    // Typography-nesting half of COMP-004 introduced the first *standing*
    // warning-severity findings (every other rule's warnings only ever appear
    // via the prose-signal downgrade, which this deterministic-only mode never
    // exercises since prose alone produces no findings here). Folding warnings
    // into blockers-only citation would silently drop them from `rulesCited` —
    // a warning-only finding is real evidence, not nothing, and this mode is
    // the one place in the pipeline that gets to run with zero model cost.
    const warnings = deterministicFindings.filter((f) => f.severity === 'warning');
    if (blockers.length) {
      status = 'incorrect';
      confidence = 0.95;
      summary = `${blockers.length} architectural rule violation(s).`;
      reasoning = blockers.map((f) => `${f.ruleId}: ${f.message}`).join('\n');
      rulesCited = [...new Set(blockers.map((f) => f.ruleId))];
    } else if (warnings.length) {
      status = 'needs_human';
      confidence = 0.5;
      summary = `${warnings.length} advisory finding(s); no blocking violation.`;
      reasoning = warnings.map((f) => `${f.ruleId}: ${f.message}`).join('\n');
      rulesCited = [...new Set(warnings.map((f) => f.ruleId))];
    } else {
      status = 'needs_human';
      confidence = 0.3;
      summary = 'No deterministic violation; judgment layer disabled.';
      reasoning = 'No mechanical violations found.';
      rulesCited = [];
    }
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
  if (id.startsWith('COMP')) return 'composition';
  if (id.startsWith('REND')) return 'render';
  return 'encoding';
}
