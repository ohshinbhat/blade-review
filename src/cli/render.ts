/** Terminal rendering for a Verdict. Presentation only — no decisions here. */
import type { Verdict } from '../types.js';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string): string => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string): string => c('1', s);
const dim = (s: string): string => c('2', s);
const red = (s: string): string => c('31', s);
const green = (s: string): string => c('32', s);
const yellow = (s: string): string => c('33', s);
const cyan = (s: string): string => c('36', s);

const BADGE: Record<Verdict['status'], (s: string) => string> = {
  correct: (s) => green(s),
  incorrect: (s) => red(s),
  needs_human: (s) => yellow(s),
};

const LABEL: Record<Verdict['status'], string> = {
  correct: 'YES — this is the right way to build it',
  incorrect: 'NO — this is not the right way to build it',
  needs_human: 'NEEDS A HUMAN — routing to the design systems team',
};

export function renderVerdict(v: Verdict): string {
  const out: string[] = [];
  const paint = BADGE[v.status];

  out.push('');
  out.push(paint(bold(`  ${LABEL[v.status]}`)));
  out.push(dim(`  confidence ${v.confidence.toFixed(2)} · decided by ${v.decidedBy} · blade@${v.meta.bladeRef}`));
  out.push('');
  out.push(`  ${v.summary}`);

  if (v.rulesCited.length) {
    out.push('');
    out.push(`  ${dim('rules')}  ${v.rulesCited.map((r) => cyan(r)).join('  ')}`);
  }

  if (v.findings.length) {
    out.push('');
    out.push(bold('  FINDINGS'));
    for (const f of v.findings) {
      const mark = f.severity === 'blocker' ? red('✗') : f.severity === 'warning' ? yellow('!') : dim('·');
      const prov = f.provenance === 'DETERMINISTIC' ? dim('[proven]') : dim('[judgment]');
      out.push(`  ${mark} ${bold(f.ruleId)} ${prov} ${f.message}`);
      for (const e of f.evidence.slice(0, 3)) out.push(dim(`      ${e}`));
      if (f.suggestion) {
        out.push(`      ${red('-')} ${f.suggestion.before.slice(0, 120)}`);
        out.push(`      ${green('+')} ${f.suggestion.after.slice(0, 200)}`);
      }
      out.push('');
    }
  }

  const realCascade = v.cascade.filter((x) => x.affectedComponents.length > 1);
  if (realCascade.length) {
    out.push(bold('  CASCADE') + dim('  (computed from the AST, not recalled)'));
    for (const cs of realCascade.slice(0, 6)) {
      out.push(`  ${cyan(cs.tokenPath)} → ${bold(String(cs.affectedComponents.length))} components`);
      out.push(dim(`      ${cs.affectedComponents.slice(0, 18).join(', ')}${cs.affectedComponents.length > 18 ? `, +${cs.affectedComponents.length - 18} more` : ''}`));
    }
    out.push('');
  }

  if (v.reasoning && v.status !== 'correct') {
    out.push(bold('  REASONING'));
    for (const line of wrap(v.reasoning, 88)) out.push(`  ${line}`);
    out.push('');
  }

  if (v.suggestedApproach) {
    out.push(bold('  CORRECT APPROACH'));
    for (const line of v.suggestedApproach.split('\n')) out.push(green(`  ${line}`));
    out.push('');
  }

  out.push(
    dim(
      `  ${v.meta.latencyMs}ms · ~${v.meta.contextTokensApprox} context tokens · provider ${v.meta.provider}`,
    ),
  );
  out.push('');
  return out.join('\n');
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if ((line + ' ' + word).trim().length > width) {
        lines.push(line.trim());
        line = word;
      } else {
        line += ' ' + word;
      }
    }
    if (line.trim()) lines.push(line.trim());
  }
  return lines;
}
