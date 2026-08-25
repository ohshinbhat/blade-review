/**
 * Metrics.
 *
 * Accuracy alone is close to useless for a review gate, so it is reported but not
 * led with. The numbers that decide whether this ships:
 *
 *  - FALSE APPROVE RATE. The dangerous one. A false reject costs a designer one
 *    round trip; a false approve puts a wrong pattern into the design system
 *    permanently and silently. Weighted accordingly and reported first.
 *  - RULE-CITATION ACCURACY. Did it pass for the *right reason*? Raw accuracy
 *    hides a model that guesses "incorrect" and happens to be right.
 *  - CASCADE RECALL. Computed from the graph, so it should be exactly 1.00. That
 *    it is 1.00 *because it is deterministic* is the whole argument for splitting
 *    the architecture the way we did.
 *  - DEFERRAL RATE. How often it routes to a human. Too high and it is useless;
 *    too low and it is overconfident.
 */
import type { CaseResult } from './types.js';
import type { CheckCategory, VerdictStatus } from '../src/types.js';

export interface Metrics {
  n: number;
  accuracy: number;
  falseApproveRate: number;
  falseApproveCount: number;
  falseRejectRate: number;
  falseRejectCount: number;
  deferralRate: number;
  /** Expected-correct cases that were actually approved. */
  correctApprovalRate: number;
  /** Cases receiving an enforceable yes/no rather than a deferral. */
  decisionCoverage: number;
  ruleCitationAccuracy: number;
  cascadeRecall: number | null;
  meanLatencyMs: number;
  byCategory: Record<string, { n: number; accuracy: number; falseApprove: number }>;
  confusion: Record<string, Record<string, number>>;
}

const STATUSES: VerdictStatus[] = ['correct', 'incorrect', 'needs_human'];

export function computeMetrics(results: CaseResult[]): Metrics {
  const n = results.length;
  const ok = results.filter((r) => r.statusCorrect).length;

  // A false approve is: ground truth says the change is wrong, agent said correct.
  const falseApproves = results.filter(
    (r) => r.case.expected.status === 'incorrect' && r.actual === 'correct',
  );
  // A false reject is: ground truth says correct, agent said incorrect.
  const falseRejects = results.filter(
    (r) => r.case.expected.status === 'correct' && r.actual === 'incorrect',
  );

  const deferrals = results.filter((r) => r.actual === 'needs_human');

  // Rule citation is only meaningful on cases that specify expected rules AND that
  // the agent got right — otherwise we would be crediting a wrong verdict.
  const citable = results.filter((r) => r.case.expected.rules?.length);
  const citedRight = citable.filter((r) => r.rulesCorrect).length;

  const cascadeCases = results.filter((r) => r.cascadeRecall !== null);
  const cascadeRecall = cascadeCases.length
    ? cascadeCases.reduce((s, r) => s + (r.cascadeRecall ?? 0), 0) / cascadeCases.length
    : null;

  const byCategory: Metrics['byCategory'] = {};
  for (const cat of ['encoding', 'cascading', 'reuse', 'composition'] as CheckCategory[]) {
    const subset = results.filter((r) => r.case.category === cat);
    if (!subset.length) continue;
    byCategory[cat] = {
      n: subset.length,
      accuracy: subset.filter((r) => r.statusCorrect).length / subset.length,
      falseApprove: subset.filter(
        (r) => r.case.expected.status === 'incorrect' && r.actual === 'correct',
      ).length,
    };
  }

  const confusion: Metrics['confusion'] = {};
  for (const exp of STATUSES) {
    confusion[exp] = {};
    for (const act of STATUSES) {
      confusion[exp][act] = results.filter(
        (r) => r.case.expected.status === exp && r.actual === act,
      ).length;
    }
  }

  const shouldReject = results.filter((r) => r.case.expected.status === 'incorrect').length;
  const shouldApprove = results.filter((r) => r.case.expected.status === 'correct').length;

  return {
    n,
    accuracy: n ? ok / n : 0,
    falseApproveRate: shouldReject ? falseApproves.length / shouldReject : 0,
    falseApproveCount: falseApproves.length,
    falseRejectRate: shouldApprove ? falseRejects.length / shouldApprove : 0,
    falseRejectCount: falseRejects.length,
    deferralRate: n ? deferrals.length / n : 0,
    correctApprovalRate: shouldApprove
      ? results.filter((r) => r.case.expected.status === 'correct' && r.actual === 'correct').length / shouldApprove
      : 0,
    decisionCoverage: n ? results.filter((r) => r.actual !== 'needs_human').length / n : 0,
    ruleCitationAccuracy: citable.length ? citedRight / citable.length : 0,
    cascadeRecall,
    meanLatencyMs: n ? results.reduce((s, r) => s + r.latencyMs, 0) / n : 0,
    byCategory,
    confusion,
  };
}

/** Run-to-run variance: the honest answer to "can I trust a non-deterministic reviewer". */
export function computeVariance(runs: CaseResult[][]): { flakyCases: string[]; stability: number } {
  if (runs.length < 2) return { flakyCases: [], stability: 1 };
  const byId = new Map<string, Set<string>>();
  for (const run of runs) {
    for (const r of run) {
      if (!byId.has(r.case.id)) byId.set(r.case.id, new Set());
      byId.get(r.case.id)!.add(r.actual);
    }
  }
  const flaky = [...byId.entries()].filter(([, s]) => s.size > 1).map(([id]) => id);
  return {
    flakyCases: flaky,
    stability: byId.size ? (byId.size - flaky.length) / byId.size : 1,
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const bar = (x: number, width = 24): string => {
  const filled = Math.round(x * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
};

export function renderMetrics(m: Metrics, label: string, variance?: { flakyCases: string[]; stability: number }): string {
  const out: string[] = [];
  out.push('');
  out.push(`  ${label}  (n=${m.n})`);
  out.push('  ' + '─'.repeat(64));
  out.push('');
  out.push(`  FALSE APPROVE RATE   ${bar(m.falseApproveRate)}  ${pct(m.falseApproveRate)}  (${m.falseApproveCount} case${m.falseApproveCount === 1 ? '' : 's'})`);
  out.push(`     the dangerous one: a wrong pattern merged silently`);
  out.push('');
  out.push(`  false reject rate    ${bar(m.falseRejectRate)}  ${pct(m.falseRejectRate)}  (${m.falseRejectCount})`);
  out.push(`  verdict accuracy     ${bar(m.accuracy)}  ${pct(m.accuracy)}`);
  out.push(`  rule-citation acc.   ${bar(m.ruleCitationAccuracy)}  ${pct(m.ruleCitationAccuracy)}  (right answer for the right reason)`);
  if (m.cascadeRecall !== null) {
    out.push(`  cascade recall       ${bar(m.cascadeRecall)}  ${pct(m.cascadeRecall)}  (deterministic — should be 100%)`);
  }
  out.push(`  deferral rate        ${bar(m.deferralRate)}  ${pct(m.deferralRate)}  (routed to a human)`);
  out.push(`  correct approvals    ${bar(m.correctApprovalRate)}  ${pct(m.correctApprovalRate)}  (recall on positive controls)`);
  out.push(`  decision coverage    ${bar(m.decisionCoverage)}  ${pct(m.decisionCoverage)}  (automatic yes/no)`);
  if (variance) {
    out.push(`  run-to-run stability ${bar(variance.stability)}  ${pct(variance.stability)}${variance.flakyCases.length ? `  flaky: ${variance.flakyCases.join(', ')}` : ''}`);
  }
  out.push('');
  out.push(`  mean latency         ${m.meanLatencyMs.toFixed(0)}ms`);
  out.push('');

  out.push('  by category');
  for (const [cat, s] of Object.entries(m.byCategory)) {
    out.push(`    ${cat.padEnd(12)} n=${String(s.n).padEnd(4)} accuracy ${pct(s.accuracy).padStart(6)}   false approves ${s.falseApprove}`);
  }
  out.push('');

  out.push('  confusion matrix   (rows = expected, cols = actual)');
  out.push(`    ${''.padEnd(14)}${STATUSES.map((s) => s.padStart(13)).join('')}`);
  for (const exp of STATUSES) {
    const row = STATUSES.map((act) => String(m.confusion[exp][act]).padStart(13)).join('');
    out.push(`    ${exp.padEnd(14)}${row}`);
  }
  out.push('');
  return out.join('\n');
}
