/**
 * GitHub adapter — the human surface.
 *
 * There is no separate dashboard here, on purpose. Reviewers already live in the
 * PR, so the PR is the interface. The three verdict states map onto GitHub
 * primitives:
 *
 *   correct      -> passing check, no comment (silence is the reward for doing it right)
 *   incorrect    -> REQUEST_CHANGES with the fix as a suggestion block
 *   needs_human  -> COMMENT + request review from the design systems team, never blocking
 *
 * The suggestion block is the part that matters. GitHub renders it with a
 * "Commit suggestion" button, so a designer who does not know the architecture
 * gets the correct implementation applied in one click. "No, and here is why" is
 * useful; "no, and here is the commit" is what actually scales.
 */
import type { Verdict } from '../types.js';

export interface GitHubReview {
  event: 'REQUEST_CHANGES' | 'COMMENT' | 'APPROVE';
  body: string;
  /** Inline comments, anchored to a file where the finding carries one. */
  comments: { path: string; body: string }[];
  /** Reviewers to request. Populated for needs_human. */
  requestReviewers: string[];
  /** Check-run conclusion, kept separate from the review event. */
  conclusion: 'success' | 'failure' | 'neutral';
}

const HEADER = '<!-- blade-ds-review -->';

const TITLE: Record<Verdict['status'], string> = {
  correct: '### ✅ Architecture check passed',
  incorrect: '### ❌ Architecture check: changes needed',
  needs_human: '### 🔍 Architecture check: design systems review requested',
};

export function toGitHubReview(v: Verdict, dsTeam = 'razorpay/design-system'): GitHubReview {
  const body: string[] = [HEADER, TITLE[v.status], '', v.summary, ''];

  if (v.status === 'correct') {
    body.push(
      `Checked against the Blade rulebook at \`${v.meta.bladeRef}\`. No encoding, cascading, or duplication issues found.`,
      '',
      '_This check covers architecture only. Whether the change belongs in Blade\'s design language is still a human call._',
    );
  }

  const proven = v.findings.filter((f) => f.provenance === 'DETERMINISTIC');
  const judged = v.findings.filter((f) => f.provenance === 'MODEL');

  if (proven.length) {
    body.push('#### Proven by static analysis', '');
    for (const f of proven) {
      const icon = f.severity === 'blocker' ? '🔴' : f.severity === 'warning' ? '🟡' : 'ℹ️';
      body.push(`${icon} **${f.ruleId}** — ${f.message}`);
      for (const e of f.evidence.slice(0, 3)) body.push(`> ${e}`);
      body.push('');
    }
  }

  if (judged.length) {
    body.push('#### Architectural judgment', '');
    for (const f of judged) {
      body.push(`🟡 **${f.ruleId}** — ${f.message}`);
      body.push(`> ${f.evidence[0] ?? ''}`);
      body.push('');
    }
  }

  const realCascade = v.cascade.filter((c) => c.affectedComponents.length > 1);
  if (realCascade.length) {
    body.push('#### Cascade impact', '');
    body.push('<details><summary>Computed from the AST — every consumer, not a sample</summary>', '');
    for (const c of realCascade.slice(0, 8)) {
      body.push(
        `- \`${c.tokenPath}\` → **${c.affectedComponents.length}** components: ${c.affectedComponents.join(', ')}`,
      );
    }
    body.push('', '</details>', '');
  }

  if (v.suggestedApproach) {
    body.push('#### Correct approach', '', '```tsx', v.suggestedApproach, '```', '');
  }

  if (v.status === 'needs_human') {
    body.push(
      `---`,
      '',
      `This one needs a human. ${v.confidence < 0.5 ? 'The agent could not reach a confident conclusion' : 'The agent is below the confidence threshold for an automatic verdict'}, so it is not blocking the PR — @${dsTeam} has been asked to take a look, and the analysis above is a starting point.`,
      '',
    );
  }

  if (v.status !== 'correct') {
    body.push(
      '---',
      '',
      `_Rules cited: ${v.rulesCited.map((r) => `\`${r}\``).join(', ') || 'none'}. Checked against blade@\`${v.meta.bladeRef}\`._`,
      '',
      '_Disagree? Reply `/ds-agent disagree <reason>`. Your override is recorded as an eval case and reviewed when the rulebook is next updated._',
    );
  }

  // Inline comments with suggestion blocks, where the finding names a file.
  const comments: { path: string; body: string }[] = [];
  for (const f of v.findings) {
    if (!f.suggestion?.file) continue;
    comments.push({
      path: f.suggestion.file,
      body: [
        `**${f.ruleId}** — ${f.message}`,
        '',
        '```suggestion',
        f.suggestion.after,
        '```',
      ].join('\n'),
    });
  }

  return {
    event: v.status === 'incorrect' ? 'REQUEST_CHANGES' : 'COMMENT',
    body: body.join('\n'),
    comments,
    requestReviewers: v.status === 'needs_human' ? [dsTeam] : [],
    // needs_human is explicitly `neutral`, not `failure`. Deferring to a human must
    // never look like a broken build, or teams will start ignoring the check.
    conclusion: v.status === 'incorrect' ? 'failure' : v.status === 'correct' ? 'success' : 'neutral',
  };
}
