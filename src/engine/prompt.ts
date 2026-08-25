/**
 * Prompt construction.
 *
 * The system prompt states the job and the constraints. The user message is the
 * context bundle rendered compactly. Note what is NOT here: any fact about Blade
 * written by hand. Every token, variant axis, cascade set and rule in the prompt
 * came out of the extractor or the rulebook, so when Blade v13 ships the prompt
 * changes without anyone editing this file.
 */
import type { ContextBundle } from '../knowledge/retrieval.js';
import type { ChangeModel } from '../checks/changeModel.js';

export const SYSTEM_PROMPT = `You are the architectural reviewer for Blade, Razorpay's design system.

Your scope is strictly OBJECTIVE. You answer one question: assuming the requirement is valid, has the change been built the right way?

You do NOT judge whether the change should exist, whether it fits Razorpay's design language, or whether it looks good. Those are subjective questions that belong to a human designer. If a change is architecturally sound but you have an aesthetic or product opinion about it, the change is 'correct'.

You decide on three axes only:
1. Correct encoding — is the property architected the right way for this component? Tokens rather than one-off values, config-driven mappings rather than conditional CSS, correct token naming and placement.
2. Correct cascading — does the change propagate to related elements correctly, and is its blast radius intended?
3. Reuse over duplication — does an existing token, variant or component already satisfy this? Did the change extend the right thing?

Hard constraints:
- Cite ONLY rule ids present in the RULEBOOK given to you. Never invent a rule id, and never state a rule that is not in the rulebook.
- Cite ONLY tokens present in EXISTING TOKENS or the component's token list. If you believe a token exists but it is not in the context, say so rather than naming it.
- The CASCADE section is computed from the source AST and is authoritative. Do not add or remove components from it based on your own recollection of Blade.
- DETERMINISTIC FINDINGS are already proven true. Do not re-litigate them, contradict them, or restate them as your own discovery. Reason about what they leave open.
- If the change is under-specified, or the right answer depends on design intent you were not given, return status 'needs_human'. Routing to a human is a correct answer, not a failure. A wrong 'correct' is far more costly than a 'needs_human': it corrupts the design system permanently, while a deferral costs one reviewer a few minutes.
- Prefer extending an existing axis over creating a new one, and a component-local token over a shared one, unless the context shows a clear reason otherwise.

When status is 'incorrect', suggestedApproach MUST contain the concrete correct implementation — real code using real token paths from the context, not a description of what to do.

Respond with a single JSON object and nothing else:
{
  "status": "correct" | "incorrect" | "needs_human",
  "confidence": <number 0..1>,
  "summary": "<one sentence>",
  "reasoning": "<why, referencing rule ids and specific tokens/components>",
  "rulesCited": ["<rule id>", ...],
  "affectedComponents": ["<component>", ...],
  "suggestedApproach": "<correct implementation, when status is incorrect>"
}`;

export function buildUserMessage(m: ChangeModel, bundle: ContextBundle): string {
  const parts: string[] = [];

  parts.push('## PROPOSED CHANGE');
  parts.push(m.intent || '(no natural-language intent given; review the diff)');
  if (m.signalSource !== 'prose') {
    parts.push(
      `\nSignal source: ${m.signalSource}. Files touched: ${m.files.map((f) => f.path).join(', ') || 'none'}`,
    );
  } else {
    parts.push(
      '\nSignal source: prose only. No diff was supplied, so file-level facts are unavailable and any conclusion about implementation details must be hedged.',
    );
  }

  if (m.files.length) {
    parts.push('\n## DIFF (added lines only)');
    for (const f of m.files.slice(0, 10)) {
      const added = f.added.filter((l) => l.trim()).slice(0, 40);
      if (!added.length) continue;
      parts.push(`\n### ${f.path}${f.isNew ? ' (new file)' : ''}`);
      parts.push('```');
      parts.push(added.join('\n'));
      parts.push('```');
    }
  }

  parts.push('\n## RULEBOOK');
  for (const r of bundle.rules) {
    parts.push(
      `- **${r.id}** (${r.category}, ${r.severity}) ${r.title}\n  ${r.statement}\n  source: ${r.source}`,
    );
  }

  if (bundle.targetComponents.length) {
    parts.push('\n## TARGET COMPONENTS (extracted from source)');
    for (const c of bundle.targetComponents) {
      parts.push(`\n### ${c.name}`);
      if (c.variantAxes.length) {
        parts.push('Existing variant axes:');
        for (const a of c.variantAxes) {
          parts.push(`  - \`${a.prop}\`: ${a.values.map((v) => `"${v}"`).join(' | ')}`);
        }
      } else {
        parts.push('No string-union variant axes extracted for this component.');
      }
      parts.push(`Token files: ${c.tokenFiles.length ? c.tokenFiles.join(', ') : 'none'}`);
      parts.push(`Platforms shipped: web=${c.platforms.web}, native=${c.platforms.native}`);
      if (c.composes.length) parts.push(`Composes: ${c.composes.join(', ')}`);
      if (c.composedBy.length) parts.push(`Composed by: ${c.composedBy.join(', ')}`);
      if (c.sampleTokens.length) {
        parts.push(`Tokens it already consumes (sample): ${c.sampleTokens.slice(0, 15).join(', ')}`);
      }
    }
  }

  if (bundle.candidateTokens.length) {
    parts.push('\n## EXISTING TOKENS RELEVANT TO THIS CHANGE');
    parts.push('These are the only token paths you may cite.');
    for (const t of bundle.candidateTokens) {
      parts.push(`  - \`${t.path}\` (${t.scope}${t.value !== undefined ? `, value: ${t.value}` : ''})`);
    }
  }

  if (bundle.priorArt.some((p) => p.usedBy.length)) {
    parts.push('\n## PRIOR ART — components already exposing the proposed props');
    for (const p of bundle.priorArt) {
      if (!p.usedBy.length) continue;
      parts.push(`  - \`${p.prop}\`:`);
      for (const u of p.usedBy) {
        parts.push(`      ${u.component}: ${u.allowedValues.map((v) => `"${v}"`).join(' | ')}`);
      }
    }
  }

  if (bundle.proposedNewComponent) {
    parts.push('\n## NEW COMPONENT DUPLICATION CHECK');
    if (bundle.similarComponents.length) {
      parts.push('Compare the proposed component against these existing Blade component surfaces:');
      for (const c of bundle.similarComponents) {
        parts.push(
          `  - ${c.proposed} vs ${c.candidate}: ${(c.score * 100).toFixed(0)}% of proposed props overlap; shared: ${c.sharedProps.join(', ')}`,
        );
        parts.push(`      proposed props: ${c.proposedProps.join(', ')}`);
        parts.push(`      existing props: ${c.candidateProps.join(', ')}`);
      }
      parts.push('Apply REUSE-004 when this evidence shows the proposal is a variant of an existing component.');
    } else {
      parts.push('No comparable prop surface could be extracted. Do not approve duplication safety; defer if it cannot be established from the diff.');
    }
  }

  if (bundle.cascade.length) {
    parts.push('\n## CASCADE (computed from the AST — authoritative)');
    for (const c of bundle.cascade) {
      parts.push(
        `  - \`${c.tokenPath}\` -> ${c.affectedComponents.length} component(s): ${c.affectedComponents.slice(0, 30).join(', ')}${c.affectedComponents.length > 30 ? `, +${c.affectedComponents.length - 30} more` : ''}`,
      );
      if (c.aliasedBy.length) {
        parts.push(`      matched via: ${c.aliasedBy.slice(0, 5).join(', ')}`);
      }
    }
  }

  if (bundle.deterministicFindings.length) {
    parts.push('\n## DETERMINISTIC FINDINGS (already proven — do not re-derive)');
    for (const f of bundle.deterministicFindings) {
      parts.push(`  - [${f.severity}] ${f.ruleId}: ${f.message}`);
      for (const e of f.evidence.slice(0, 3)) parts.push(`      ${e}`);
    }
  } else {
    parts.push(
      '\n## DETERMINISTIC FINDINGS\nNone. Layer 1 found no mechanical violation. This does not mean the change is correct — it means the remaining question is a judgment call, which is why it reached you.',
    );
  }

  for (const ex of bundle.excerpts) {
    parts.push(`\n## EXCERPT — ${ex.source}`);
    parts.push('```');
    parts.push(ex.text);
    parts.push('```');
  }

  parts.push('\n## YOUR TASK');
  parts.push(
    'Decide whether this change is architected correctly. Respond with the JSON object described in your instructions and nothing else.',
  );

  return parts.join('\n');
}
