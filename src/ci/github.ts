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
  /** Plain-text title for the dedicated verdict check run. */
  checkTitle: string;
  body: string;
  /** Inline comments, anchored to a file where the finding carries one. */
  comments: { path: string; line: number; side: 'RIGHT'; body: string }[];
  /** Reviewers to request. Populated for needs_human. */
  requestReviewers: string[];
  /** Check-run conclusion, kept separate from the review event. */
  conclusion: 'success' | 'failure' | 'neutral';
}

const HEADER = '<!-- blade-ds-review -->';

const REVIEW_TITLE: Record<Verdict['status'], string> = {
  correct: '## Blade architecture review: passed',
  incorrect: '## Blade architecture review: changes requested',
  needs_human: '## Blade architecture review: human review needed',
};

const CHECK_TITLE: Record<Verdict['status'], string> = {
  correct: 'Architecture review passed',
  incorrect: 'Architecture changes required',
  needs_human: 'Human architecture review required',
};

export function toGitHubReview(
  v: Verdict,
  dsTeam = 'razorpay/design-system',
  requestHumanReview = true,
): GitHubReview {
  const body: string[] = [HEADER, REVIEW_TITLE[v.status], '', v.summary, ''];

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
    body.push('### Verified findings', '');
    for (const f of proven) {
      const icon = f.severity === 'blocker' ? '🔴' : f.severity === 'warning' ? '🟡' : 'ℹ️';
      body.push(`${icon} **${f.ruleId}** — ${f.message}`);
      for (const e of f.evidence.slice(0, 3)) body.push(`> ${e}`);
      body.push('');
    }
  }

  if (judged.length) {
    body.push('### Model-assisted findings', '');
    for (const f of judged) {
      body.push(`🟡 **${f.ruleId}** — ${f.message}`);
      body.push(`> ${f.evidence[0] ?? ''}`);
      body.push('');
    }
  }

  const realCascade = v.cascade.filter((c) => c.affectedComponents.length > 1);
  if (realCascade.length) {
    body.push('### Affected components', '');
    body.push('<details><summary>Show the components identified from the AST</summary>', '');
    for (const c of realCascade.slice(0, 8)) {
      body.push(
        `- \`${c.tokenPath}\` → **${c.affectedComponents.length}** components: ${c.affectedComponents.join(', ')}`,
      );
    }
    body.push('', '</details>', '');
  }

  if (v.suggestedApproach) {
    body.push('### Suggested implementation', '', '```tsx', v.suggestedApproach, '```', '');
  }

  if (v.status === 'needs_human') {
    body.push(
      `---`,
      '',
      requestHumanReview
        ? `The automated review could not reach a safe conclusion. This pull request is not blocked; @${dsTeam} has been asked to review the findings above.`
        : 'The automated review could not reach a safe conclusion. This pull request is not blocked. Automatic reviewer assignment is disabled, so a maintainer should review the findings above.',
      '',
    );
  }

  if (v.status !== 'correct') {
    body.push(
      '---',
      '',
      `_Review context: Blade \`${v.meta.bladeRef}\` · Rules: ${v.rulesCited.map((r) => `\`${r}\``).join(', ') || 'none'}._`,
      '',
      '_If this finding is incorrect, comment `/ds-agent disagree <reason>`. The override will be recorded for rule evaluation._',
    );
  }

  // Inline comments with suggestion blocks, where the finding names a file.
  const comments: GitHubReview['comments'] = [];
  for (const f of v.findings) {
    if (!f.suggestion?.file || !f.suggestion.line) continue;
    comments.push({
      path: f.suggestion.file,
      line: f.suggestion.line,
      side: 'RIGHT',
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
    checkTitle: CHECK_TITLE[v.status],
    body: body.join('\n'),
    comments,
    requestReviewers: v.status === 'needs_human' && requestHumanReview ? [dsTeam] : [],
    // needs_human is explicitly `neutral`, not `failure`. Deferring to a human must
    // never look like a broken build, or teams will start ignoring the check.
    conclusion: v.status === 'incorrect' ? 'failure' : v.status === 'correct' ? 'success' : 'neutral',
  };
}
