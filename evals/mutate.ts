/**
 * Synthetic mutation generator.
 *
 * Labelled negatives are the expensive half of any eval set. Rather than hand-write
 * them, we take Blade's *actual, merged, correct* source and programmatically
 * corrupt it in ways that map one-to-one onto rulebook violations. The label is
 * known by construction, and the distribution across rule categories is something
 * we control rather than something we inherit from whatever PRs happened to exist.
 *
 * Every mutation below is a real failure mode a designer PR exhibits:
 *   - inline a token's value as a literal            -> ENC-001
 *   - duplicate an existing token under a new name   -> REUSE-001
 *   - add a global token to serve one component      -> REUSE-002
 *   - re-add a variant value that already exists     -> REUSE-003
 *   - express a variant as a switch                  -> ENC-002
 *   - edit .web without .native                      -> CAS-004
 *   - rename a boolean prop off-convention           -> REUSE-005
 */
import type { BladeGraph } from '../src/extract/graph.js';
import type { EvalCase } from './types.js';

function diffFor(file: string, added: string[], removed: string[] = [], isNew = false): string {
  const lines = [`diff --git a/${file} b/${file}`];
  if (isNew) lines.push('new file mode 100644');
  lines.push(`--- a/${file}`, `+++ b/${file}`, '@@ -1,4 +1,6 @@');
  for (const r of removed) lines.push(`-${r}`);
  for (const a of added) lines.push(`+${a}`);
  return lines.join('\n');
}

export function generateMutations(g: BladeGraph): EvalCase[] {
  const cases: EvalCase[] = [];

  // ---- ENC-001: inline a real token's value as a literal -------------------
  const dimensionTokens = g.graph.tokens.filter(
    (t) => t.scope === 'global' && typeof t.value === 'number' && t.value > 0 && (t.category === 'spacing' || t.category === 'border'),
  );
  for (const t of dimensionTokens.slice(0, 6)) {
    const comp = pickComponentConsuming(g, t.path) ?? 'Card';
    cases.push({
      id: `mut-enc001-${t.path.replace(/\./g, '-')}`,
      origin: 'mutation',
      category: 'encoding',
      intent: `Set the padding on ${comp} directly.`,
      diff: diffFor(`packages/blade/src/components/${comp}/Styled${comp}.web.tsx`, [
        `  padding: ${t.value}px;`,
      ]),
      expected: { status: 'incorrect', rules: ['ENC-001'] },
      rationale: `${t.value}px is the literal value of \`${t.path}\`. Inlining it bypasses the token.`,
    });
  }

  // ---- REUSE-001: duplicate an existing token's value ----------------------
  for (const t of dimensionTokens.slice(0, 4)) {
    cases.push({
      id: `mut-reuse001-${t.path.replace(/\./g, '-')}`,
      origin: 'mutation',
      category: 'reuse',
      intent: `Add a new spacing token for the card gutter.`,
      diff: diffFor('packages/blade/src/tokens/global/spacing.ts', [
        `  cardGutter: ${t.value},`,
      ]),
      expected: { status: 'incorrect', rules: ['REUSE-001'] },
      rationale: `Value ${t.value} is already encoded by \`${t.path}\`.`,
    });
  }

  // ---- REUSE-003: re-propose a variant value that already exists -----------
  const componentsWithVariants = g
    .allComponentNames()
    .map((name) => ({ name, axes: g.variantAxes(name) }))
    .filter((c) => c.axes.some((a) => a.values.length >= 2))
    .slice(0, 40);

  for (const { name, axes } of componentsWithVariants.slice(0, 8)) {
    const axis = axes.find((a) => a.values.length >= 2)!;
    const existing = axis.values[axis.values.length - 1];
    cases.push({
      id: `mut-reuse003-${name}-${axis.prop}-${existing}`,
      origin: 'mutation',
      category: 'reuse',
      intent: `I want to add a new ${existing} ${axis.prop} to ${name}.`,
      expected: { status: 'incorrect', rules: ['REUSE-003'] },
      rationale: `${name}.${axis.prop} already accepts "${existing}".`,
    });
  }

  // ---- ENC-002: variant styling as a switch --------------------------------
  for (const { name } of componentsWithVariants.slice(0, 4)) {
    cases.push({
      id: `mut-enc002-${name}`,
      origin: 'mutation',
      category: 'encoding',
      intent: `Add the new variant styling to ${name}.`,
      diff: diffFor(`packages/blade/src/components/${name}/${name}.tsx`, [
        `  switch (variant) {`,
        `    case 'tertiary':`,
        `      return isDisabled ? 'surface.text.gray.disabled' : 'surface.text.gray.normal';`,
        `  }`,
      ]),
      expected: { status: 'incorrect', rules: ['ENC-002'] },
      rationale: 'Variant styling must be a declarative mapping in the component token file.',
    });
  }

  // ---- REUSE-005: off-convention boolean prop -----------------------------
  for (const { name } of componentsWithVariants.slice(0, 4)) {
    cases.push({
      id: `mut-reuse005-${name}`,
      origin: 'mutation',
      category: 'reuse',
      intent: `Add a loading prop to ${name}.`,
      diff: diffFor(`packages/blade/src/components/${name}/types.ts`, [
        `  loading?: 'true' | 'false';`,
      ]),
      expected: { status: 'incorrect', rules: ['REUSE-005'] },
      rationale: 'Blade uses isLoading; `loading` is off-convention.',
    });
  }

  // ---- CAS-004: web edited without native ---------------------------------
  const crossPlatform = g.graph.components.filter((c) => c.platforms.web && c.platforms.native).slice(0, 4);
  for (const c of crossPlatform) {
    cases.push({
      id: `mut-cas004-${c.name}`,
      origin: 'mutation',
      category: 'cascading',
      intent: `Adjust the pressed state on ${c.name}.`,
      diff: diffFor(`packages/blade/src/components/${c.name}/Styled${c.name}.web.tsx`, [
        `  transform: scale(0.98);`,
      ]),
      expected: { status: 'incorrect', rules: ['CAS-004'] },
      rationale: `${c.name} ships web and native; a web-only styling change breaks parity.`,
    });
  }

  // ---- REUSE-002: global token added to serve one component ---------------
  for (const { name } of componentsWithVariants.slice(0, 3)) {
    cases.push({
      id: `mut-reuse002-${name}`,
      origin: 'mutation',
      category: 'reuse',
      intent: `${name} needs a slightly different radius, so add a global token for it.`,
      diff: diffFor('packages/blade/src/tokens/global/border.ts', [
        `    ${lower(name)}Radius: 14,`,
      ]),
      expected: { status: 'incorrect', rules: ['REUSE-002'] },
      rationale: 'Start within, then promote across: a single-consumer token stays component-local.',
    });
  }

  return cases;
}

function pickComponentConsuming(g: BladeGraph, tokenPath: string): string | undefined {
  const impact = g.cascade(tokenPath);
  return impact.affectedComponents.find((c) => /^[A-Z]/.test(c) && !c.startsWith('Base'));
}

function lower(s: string): string {
  return s[0].toLowerCase() + s.slice(1);
}
