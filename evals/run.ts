#!/usr/bin/env node
/**
 * Eval runner.
 *
 * Reports two arms side by side:
 *
 *   DETERMINISTIC FLOOR — Layer 1 only. Fully reproducible, zero cost, zero
 *   network. This is the guaranteed behaviour of the system.
 *
 *   WITH JUDGMENT LAYER — the full pipeline. The delta between the two arms is
 *   exactly what the model contributes, which is the question anyone reviewing an
 *   LLM system should ask and few can answer with a number.
 *
 *   npm run eval
 *   npm run eval -- --runs 3          # variance across repeated runs
 *   npm run eval -- --only gold-002   # single case, for debugging
 *   npm run eval -- --json out.json   # machine-readable, for CI trend tracking
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadGraph } from '../src/extract/index.js';
import { review } from '../src/engine/review.js';
import { generateMutations, generatePositiveControls } from './mutate.js';
import { computeMetrics, computeVariance, renderMetrics } from './metrics.js';
import type { EvalCase, CaseResult } from './types.js';
import type { BladeGraph } from '../src/extract/graph.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadCases(g: BladeGraph): EvalCase[] {
  const dir = path.resolve('evals/cases');
  const handwritten: EvalCase[] = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    handwritten.push(...(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as EvalCase[]));
  }
  const mutations = generateMutations(g);
  const positives = generatePositiveControls(g);
  return [...handwritten, ...mutations, ...positives];
}

async function runCase(
  c: EvalCase,
  g: BladeGraph,
  deterministicOnly: boolean,
): Promise<CaseResult> {
  const t0 = Date.now();
  try {
    const v = await review({ intent: c.intent, diff: c.diff }, g, { deterministicOnly });

    const cascadeComponents = [...new Set(v.cascade.flatMap((x) => x.affectedComponents))];

    // Rule citation: every expected rule must appear. Extra rules are allowed —
    // a change can violate more than one rule and we do not want to punish
    // finding a real second problem.
    const expectedRules = c.expected.rules ?? [];
    const rulesCorrect = expectedRules.length
      ? expectedRules.every((r) => v.rulesCited.includes(r))
      : true;

    const expectedComponents = c.expected.affectedComponents ?? [];
    const cascadeRecall = expectedComponents.length
      ? expectedComponents.filter((x) => cascadeComponents.includes(x)).length / expectedComponents.length
      : null;

    return {
      case: c,
      actual: v.status,
      confidence: v.confidence,
      rulesCited: v.rulesCited,
      cascadeComponents,
      statusCorrect: v.status === c.expected.status,
      rulesCorrect,
      cascadeRecall,
      latencyMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      case: c,
      actual: 'needs_human',
      confidence: 0,
      rulesCited: [],
      cascadeComponents: [],
      statusCorrect: c.expected.status === 'needs_human',
      rulesCorrect: false,
      cascadeRecall: null,
      latencyMs: Date.now() - t0,
      error: (err as Error).message,
    };
  }
}

async function runAll(cases: EvalCase[], g: BladeGraph, deterministicOnly: boolean): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  // Sequential on purpose: a review gate's latency profile should be measured
  // the way it actually runs, and rate limits are real.
  for (const c of cases) results.push(await runCase(c, g, deterministicOnly));
  return results;
}

function renderFailures(results: CaseResult[]): string {
  const failures = results.filter((r) => !r.statusCorrect || !r.rulesCorrect);
  if (!failures.length) return '  no failing cases\n';
  const out: string[] = ['  FAILING CASES', '  ' + '─'.repeat(64), ''];
  for (const r of failures) {
    const reason = !r.statusCorrect
      ? `expected ${r.case.expected.status}, got ${r.actual}`
      : `verdict right, rules wrong: expected ${(r.case.expected.rules ?? []).join(',')}, cited ${r.rulesCited.join(',') || 'none'}`;
    out.push(`  ✗ ${r.case.id}  [${r.case.category}/${r.case.origin}]`);
    out.push(`      ${reason}`);
    out.push(`      ground truth: ${r.case.rationale}`);
    if (r.error) out.push(`      error: ${r.error}`);
    out.push('');
  }
  return out.join('\n');
}

async function main(): Promise<void> {
  const graph = loadGraph(path.resolve(flag('graph') ?? 'data/blade-graph.json'));
  const only = flag('only');
  const runs = Number(flag('runs') ?? 1);
  const jsonOut = flag('json');

  let cases = loadCases(graph);
  if (only) cases = cases.filter((c) => c.id.includes(only));
  if (!cases.length) {
    process.stderr.write('No matching eval cases.\n');
    process.exit(2);
  }

  process.stdout.write(`\n  Blade architecture review — eval suite\n`);
  process.stdout.write(`  blade@${graph.bladeRef} · ${cases.length} cases · ${runs} run(s)\n`);
  const remoteProvider = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY);
  const providerLabel = process.env.OPENROUTER_API_KEY && !process.env.ANTHROPIC_API_KEY
    ? `openrouter (${process.env.BLADE_REVIEW_MODEL ?? 'openai/gpt-4o-mini'})`
    : process.env.ANTHROPIC_API_KEY
      ? `anthropic (${process.env.BLADE_REVIEW_MODEL ?? 'claude-sonnet-4-5'})`
      : 'offline (no model API key set)';
  process.stdout.write(`  provider: ${providerLabel}\n`);

  // Arm 1 — deterministic floor.
  const floorResults = await runAll(cases, graph, true);
  const floorMetrics = computeMetrics(floorResults);
  process.stdout.write(renderMetrics(floorMetrics, 'DETERMINISTIC FLOOR — Layer 1 only'));

  // Arm 2 — full pipeline, repeated for variance.
  const allRuns: CaseResult[][] = [];
  for (let i = 0; i < runs; i++) allRuns.push(await runAll(cases, graph, false));
  const fullResults = allRuns[0];
  const fullMetrics = computeMetrics(fullResults);
  const variance = computeVariance(allRuns);
  process.stdout.write(
    renderMetrics(fullMetrics, 'WITH JUDGMENT LAYER — full pipeline', runs > 1 ? variance : undefined),
  );

  const delta = fullMetrics.accuracy - floorMetrics.accuracy;
  process.stdout.write(
    `  Δ from the judgment layer: ${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)} points of accuracy, ` +
      `deferrals ${(floorMetrics.deferralRate * 100).toFixed(0)}% → ${(fullMetrics.deferralRate * 100).toFixed(0)}%\n\n`,
  );

  process.stdout.write(renderFailures(fullResults));

  if (jsonOut) {
    fs.writeFileSync(
      path.resolve(jsonOut),
      JSON.stringify(
        { bladeRef: graph.bladeRef, floor: floorMetrics, full: fullMetrics, variance, results: fullResults },
        null,
        2,
      ),
    );
    process.stdout.write(`  wrote ${jsonOut}\n\n`);
  }

  // CI gate on the eval suite itself: a regression in false approves fails the build.
  const budget = Number(process.env.EVAL_FALSE_APPROVE_BUDGET ?? 0);
  if (fullMetrics.falseApproveCount > budget) {
    process.stderr.write(
      `  FAIL: ${fullMetrics.falseApproveCount} false approve(s), budget is ${budget}.\n\n`,
    );
    process.exit(1);
  }

  // A configured judgment layer must prove it can make useful positive decisions,
  // not merely avoid false approvals by deferring everything.
  const minCorrectApproval = Number(
    process.env.EVAL_MIN_CORRECT_APPROVAL_RATE ?? (remoteProvider ? 0.5 : 0),
  );
  const minDecisionCoverage = Number(
    process.env.EVAL_MIN_DECISION_COVERAGE ?? (remoteProvider ? 0.75 : 0),
  );
  if (
    fullMetrics.correctApprovalRate < minCorrectApproval ||
    fullMetrics.decisionCoverage < minDecisionCoverage
  ) {
    process.stderr.write(
      `  FAIL: correct approval rate ${(fullMetrics.correctApprovalRate * 100).toFixed(1)}% ` +
      `(minimum ${(minCorrectApproval * 100).toFixed(1)}%); decision coverage ` +
      `${(fullMetrics.decisionCoverage * 100).toFixed(1)}% ` +
      `(minimum ${(minDecisionCoverage * 100).toFixed(1)}%).\n\n`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`\nerror: ${(err as Error).stack}\n`);
  process.exit(2);
});
