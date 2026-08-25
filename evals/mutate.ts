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
 *   - raw intrinsic where a Blade primitive exists   -> COMP-001
 *   - inline style prop instead of styled props      -> COMP-002
 *   - nest one interactive element inside another    -> COMP-004
 *   - use a variant value never added to the union   -> COMP-005
 *   - a computed snapshot value off the token scale  -> REND-001
 *   - web/native snapshots resolve the same story
 *     to different values                            -> REND-002
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

  // ---- COMP-001: raw intrinsic where a Blade primitive exists --------------
  for (const { name } of componentsWithVariants.slice(0, 3)) {
    cases.push({
      id: `mut-comp001-${name}`,
      origin: 'mutation',
      category: 'composition',
      intent: `Add a small total row to ${name}.`,
      diff: diffFor(`packages/blade/src/components/${name}/Preview.tsx`, [
        `  <div>`,
        `    <span>Total</span>`,
        `  </div>`,
      ]),
      expected: { status: 'needs_human', rules: ['COMP-001'] },
      rationale:
        'Raw `<div>`/`<span>` are used where Box/Typography already exist. COMP-001 is a warning, not a blocker — there are legitimate reasons to reach for a raw element — so this defers rather than rejects.',
    });
  }

  // ---- COMP-002: inline style prop instead of token-driven styled props ----
  for (const { name } of componentsWithVariants.slice(0, 3)) {
    cases.push({
      id: `mut-comp002-${name}`,
      origin: 'mutation',
      category: 'composition',
      intent: `Nudge the spacing on ${name}'s wrapper.`,
      diff: diffFor(`packages/blade/src/components/${name}/Preview.tsx`, [
        `  <Box style={{ padding: 4 }}>`,
        `    <Typography>${name}</Typography>`,
        `  </Box>`,
      ]),
      expected: { status: 'incorrect', rules: ['COMP-002'] },
      rationale:
        'An inline `style` object is a bundle of hard-coded literal values — the same violation ENC-001 catches, expressed as a prop instead of a bare declaration.',
    });
  }

  // ---- COMP-004: interactive element nested inside another -----------------
  cases.push({
    id: 'mut-comp004-interactive',
    origin: 'mutation',
    category: 'composition',
    intent: 'Add a help link inside the confirm action.',
    diff: diffFor('packages/blade/src/components/Button/Preview.tsx', [
      `  <Button variant="tertiary">`,
      `    <Link href="/help">Help</Link>`,
      `  </Button>`,
    ]),
    expected: { status: 'incorrect', rules: ['COMP-004'] },
    rationale: 'Link is nested inside Button. Interactive elements cannot nest — the inner control is unreachable and the roles collide.',
  });

  // ---- COMP-004: Typography nested inside Typography (warning, not blocker) ---
  cases.push({
    id: 'mut-comp004-typography',
    origin: 'mutation',
    category: 'composition',
    intent: 'Wrap the label in an extra text element for emphasis.',
    diff: diffFor('packages/blade/src/components/Card/Preview.tsx', [
      `  <Typography>`,
      `    <Typography>Nested</Typography>`,
      `  </Typography>`,
    ]),
    expected: { status: 'needs_human', rules: ['COMP-004'] },
    rationale:
      'Typography wrapping Typography is a structural smell, not a hard architecture violation, so COMP-004 reports it as a warning here and the change defers rather than rejects.',
  });

  // ---- COMP-005: a variant value never added to the declared union ---------
  cases.push({
    id: 'mut-comp005-button-variant',
    origin: 'mutation',
    category: 'composition',
    intent: 'Use the new quaternary button style on the confirm action.',
    diff: diffFor('packages/blade/src/components/Button/Preview.tsx', [
      `  <Button variant="quaternary">Pay</Button>`,
    ]),
    expected: { status: 'incorrect', rules: ['COMP-005'] },
    rationale: "Button.variant only allows primary | secondary | tertiary. \"quaternary\" was never added to the union.",
  });

  // ---- REND-001: an off-scale value in the rendered snapshot ---------------
  const offScale = offScaleValue(g);
  for (const { name } of componentsWithVariants.slice(0, 3)) {
    cases.push({
      id: `mut-rend001-${name}`,
      origin: 'mutation',
      category: 'render',
      intent: `Tighten up the ${name} spacing slightly.`,
      diff: diffFor(`packages/blade/src/components/${name}/__tests__/__snapshots__/${name}.web.test.tsx.snap`, [
        `exports[\`${name} renders correctly 1\`] = \``,
        `  padding: ${offScale}px;`,
        '`;',
      ]),
      expected: { status: 'incorrect', rules: ['REND-001'] },
      rationale: `${offScale}px matches no token in the scale. Read from the diffed snapshot's computed CSS, not from a literal the diff shows in source.`,
    });
  }

  // ---- REND-002: web and native resolve the same story differently ---------
  for (const { name } of componentsWithVariants.slice(0, 3)) {
    const web = `packages/blade/src/components/${name}/__tests__/__snapshots__/${name}.web.test.tsx.snap`;
    const native = `packages/blade/src/components/${name}/__tests__/__snapshots__/${name}.native.test.tsx.snap`;
    cases.push({
      id: `mut-rend002-${name}`,
      origin: 'mutation',
      category: 'render',
      intent: `Update the ${name} padding on both platforms.`,
      diff: [
        diffFor(web, [`exports[\`${name} renders correctly 1\`] = \``, '  padding: 8px;', '`;']),
        diffFor(native, [`exports[\`${name} renders correctly 1\`] = \``, '  padding: 12px;', '`;']),
      ].join('\n'),
      expected: { status: 'incorrect', rules: ['REND-002'] },
      rationale: `${name} resolves padding to 8px on web and 12px on native for the same story — the two platforms no longer render the same thing.`,
    });
  }

  return cases;
}

/** A numeric value guaranteed not to match any extracted global token — for REND-001 cases. */
function offScaleValue(g: BladeGraph): number {
  for (let candidate = 15; candidate < 80; candidate++) {
    if (!g.tokensWithValue(candidate).length) return candidate;
  }
  return 9999;
}

/**
 * Positive controls derived from real component/token surfaces. These prevent a
 * reject-only reviewer from looking accurate merely because negative mutations
 * dominate the suite.
 */
export function generatePositiveControls(g: BladeGraph): EvalCase[] {
  const cases: EvalCase[] = [];
  const withVariantsAndTokens = g.graph.components
    .map((component) => ({ component, axes: g.variantAxes(component.name), tokens: g.tokensFor(component.name) }))
    .filter((x) => x.axes.length && x.component.tokenFiles.length && x.tokens.length)
    .slice(0, 8);

  for (const { component, axes, tokens } of withVariantsAndTokens) {
    const axis = axes[0];
    const value = axis.values[0];
    cases.push({
      id: `positive-existing-config-${component.name}-${axis.prop}-${value}`,
      origin: 'mutation',
      category: 'encoding',
      intent:
        `Adjust the existing ${component.name}.${axis.prop}="${value}" appearance inside ` +
        `${component.tokenFiles[0]}, using only its current token mappings such as ${tokens[0]}. ` +
        'The API and token inventory stay unchanged, with shared config read by both platforms.',
      expected: { status: 'correct' },
      rationale: 'Positive control: an existing axis is updated through its existing config and token surfaces.',
    });
  }

  const crossPlatform = g.graph.components.filter((c) => c.platforms.web && c.platforms.native).slice(0, 4);
  for (const component of crossPlatform) {
    const web = `packages/blade/src/components/${component.name}/PositiveControl.web.tsx`;
    const native = `packages/blade/src/components/${component.name}/PositiveControl.native.tsx`;
    cases.push({
      id: `positive-cross-platform-${component.name}`,
      origin: 'mutation',
      category: 'cascading',
      intent: `Apply the same token-backed pressed-state adjustment to ${component.name} on web and native.`,
      diff: [
        diffFor(web, ['  opacity: theme.opacity[8];']),
        diffFor(native, ['  opacity: theme.opacity[8],']),
      ].join('\n'),
      expected: { status: 'correct' },
      rationale: 'Positive control: both shipped platforms are updated with the same existing token.',
    });
  }

  // ---- Positive control: composed entirely from Blade primitives -----------
  cases.push({
    id: 'positive-composition-box-typography',
    origin: 'mutation',
    category: 'composition',
    intent: 'Add a small total row using existing Blade primitives.',
    diff: diffFor('packages/blade/src/components/PositiveComposition/PositiveComposition.tsx', [
      `export const PositiveComposition = () => (`,
      `  <Box padding="spacing.4">`,
      `    <Typography>Total</Typography>`,
      `  </Box>`,
      `);`,
    ]),
    expected: { status: 'correct' },
    rationale: 'Positive control: composed entirely from Box/Typography, no raw intrinsics, no inline style, no illegal nesting, no invalid variant literal.',
  });

  // ---- Positive control: paired snapshots resolve to the same value --------
  {
    const web = 'packages/blade/src/components/Card/__tests__/__snapshots__/Card.web.test.tsx.snap';
    const native = 'packages/blade/src/components/Card/__tests__/__snapshots__/Card.native.test.tsx.snap';
    cases.push({
      id: 'positive-render-cross-platform-match',
      origin: 'mutation',
      category: 'render',
      intent: 'Update Card padding on both platforms to the same token-backed value.',
      diff: [
        diffFor(web, ['exports[`Card renders correctly 1`] = `', '  padding: 16px;', '`;']),
        diffFor(native, ['exports[`Card renders correctly 1`] = `', '  padding: 16px;', '`;']),
      ].join('\n'),
      expected: { status: 'correct' },
      rationale: 'Positive control: both platforms resolve padding to 16px (spacing.5) for the same story — on-scale and matching.',
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
