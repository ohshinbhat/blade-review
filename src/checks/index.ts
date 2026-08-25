/**
 * Layer 1A/1B — deterministic checks and semantic UI-structure reuse.
 *
 * Every finding here is computed from the change model and the knowledge graph.
 * No model call, no ambiguity, no variance between runs. These checks exist for
 * two reasons: they are exactly right, and they are free — which means the model
 * in Layer 2 only ever sees the residue that genuinely needs judgment.
 *
 * Rule of thumb enforced throughout: escalate to `blocker` only on exact
 * (diff-derived) signals. A prose-derived signal produces `warning` at most, so
 * the CI gate never fails a PR on a guess about English.
 */
import type { Finding } from '../types.js';
import type { BladeGraph } from '../extract/graph.js';
import type { ChangeModel } from './changeModel.js';
import { rule } from '../knowledge/rulebook.js';
import { COMPOSITION_CHECKS } from './composition.js';
import { RENDER_CHECKS } from './render.js';
import { STRUCTURE_CHECKS } from './structure.js';

type Check = (m: ChangeModel, g: BladeGraph, prior: BladeGraph) => Finding[];

/** Severity floor: prose-only signals never block. */
function sev(m: ChangeModel, desired: 'blocker' | 'warning'): 'blocker' | 'warning' {
  return m.signalSource === 'prose' && desired === 'blocker' ? 'warning' : desired;
}

// ---------------------------------------------------------------------------
// ENC-001 — literal values where a token exists
// ---------------------------------------------------------------------------
const checkLiteralValues: Check = (m, g) => {
  const findings: Finding[] = [];
  const r = rule('ENC-001');

  for (const lit of m.literalColors) {
    const exact = g.tokensWithValue(lit.value);
    const suggestion = exact[0];
    findings.push({
      ruleId: r.id,
      category: r.category,
      severity: sev(m, 'blocker'),
      message: `Literal colour \`${lit.value}\` is used where a design token is required.`,
      evidence: [
        lit.file ? `${lit.file}: ${lit.line}` : `intent: "${lit.line}"`,
        suggestion
          ? `\`${suggestion.path}\` already holds this exact value (${suggestion.file}:${suggestion.line}).`
          : `No existing token holds this value. A colour that is genuinely new needs a token, not a literal — see REUSE-002 for where it should live.`,
      ],
      suggestion: suggestion
        ? {
            file: lit.file,
            line: lit.lineNumber,
            before: lit.line,
            after: lit.line.replace(lit.value, `'${suggestion.path}'`),
          }
        : undefined,
      provenance: 'DETERMINISTIC',
    });
  }

  for (const lit of m.literalDimensions) {
    const numeric = Number(lit.value);
    const exact = g.tokensWithValue(numeric).filter((t) => t.category !== 'typography');
    const suggestion = exact.find((t) => t.category === 'spacing') ?? exact[0];
    findings.push({
      ruleId: r.id,
      category: r.category,
      severity: sev(m, 'blocker'),
      message: `Literal dimension \`${lit.raw}\` is used where a design token is required.`,
      evidence: [
        lit.file ? `${lit.file}: ${lit.line}` : `intent: "${lit.line}"`,
        exact.length
          ? `Existing tokens with value ${numeric}: ${exact.map((t) => `\`${t.path}\``).join(', ')}.`
          : `No token holds the value ${numeric}. Blade's scale is deliberate — a value off the scale usually means the design should snap to an existing step.`,
      ],
      suggestion: suggestion
        ? {
            file: lit.file,
            line: lit.lineNumber,
            before: lit.line,
            after: lit.line.replace(lit.raw, `'${suggestion.path}'`),
          }
        : undefined,
      provenance: 'DETERMINISTIC',
    });
  }

  return findings;
};

// ---------------------------------------------------------------------------
// ENC-002 — conditional styling instead of config-driven tokens
// ---------------------------------------------------------------------------
const checkConditionalStyling: Check = (m) => {
  if (!m.conditionalBranches.length) return [];
  const r = rule('ENC-002');
  return [
    {
      ruleId: r.id,
      category: r.category,
      severity: sev(m, 'blocker'),
      message:
        'Variant styling is expressed as conditional branches rather than as a declarative mapping in the component token file.',
      evidence: [
        ...m.conditionalBranches.slice(0, 5).map((b) => `${b.file}: ${b.line}`),
        r.source,
      ],
      suggestion: {
        file: m.conditionalBranches[0].file,
        line: m.conditionalBranches[0].lineNumber,
        before: m.conditionalBranches[0].line,
        after:
          "// move the mapping into the component token file:\n// <component>Tokens = { <prop>: { <value>: { default: '<token.path>' } } }",
      },
      provenance: 'DETERMINISTIC',
    },
  ];
};

// ---------------------------------------------------------------------------
// ENC-003 / ENC-004 — token naming
// ---------------------------------------------------------------------------
const CATEGORY_LEVEL = new Set(['color', 'colors', 'space', 'spacing', 'size', 'font', 'typography', 'border', 'motion', 'elevation', 'opacity']);
const PROPERTY_LEVEL = new Set(['background', 'border', 'text', 'icon', 'radius', 'width']);

const checkTokenNaming: Check = (m) => {
  const findings: Finding[] = [];
  for (const decl of m.declaredTokens) {
    if (!decl.path.includes('.')) continue; // single key inside an existing group — hierarchy already set by nesting
    const parts = decl.path.split('.');
    const r3 = rule('ENC-003');

    // Category must not appear after a modifier-looking segment.
    const catIdx = parts.findIndex((p) => CATEGORY_LEVEL.has(p));
    const propIdx = parts.findIndex((p) => PROPERTY_LEVEL.has(p));
    if (catIdx > 0 && propIdx >= 0 && catIdx > propIdx) {
      findings.push({
        ruleId: r3.id,
        category: r3.category,
        severity: sev(m, 'blocker'),
        message: `Token \`${decl.path}\` orders its levels as property-before-category, which inverts the naming hierarchy.`,
        evidence: [r3.statement, r3.source],
        provenance: 'DETERMINISTIC',
      });
    }

    // Colour tokens need a property level.
    if (decl.scope !== 'component' && (parts[0] === 'color' || parts[0] === 'colors')) {
      if (!parts.some((p) => PROPERTY_LEVEL.has(p))) {
        const r4 = rule('ENC-004');
        findings.push({
          ruleId: r4.id,
          category: r4.category,
          severity: 'warning',
          message: `Colour token \`${decl.path}\` has no property level (background / border / text), so its application surface is ambiguous.`,
          evidence: [r4.statement, r4.source],
          suggestion: {
            before: decl.path,
            after: `${parts[0]}.background.${parts.slice(1).join('.')}`,
          },
          provenance: 'DETERMINISTIC',
        });
      }
    }
  }
  return findings;
};

// ---------------------------------------------------------------------------
// REUSE-001 — duplicate token value
// ---------------------------------------------------------------------------
const checkDuplicateToken: Check = (m, _g, prior) => {
  const findings: Finding[] = [];
  const r = rule('REUSE-001');
  for (const decl of m.declaredTokens) {
    if (decl.value === undefined) continue;
    const existing = prior.tokensWithValue(decl.value).filter((t) => !t.path.endsWith(`.${decl.path}`));
    if (!existing.length) continue;
    findings.push({
      ruleId: r.id,
      category: r.category,
      severity: sev(m, 'blocker'),
      message: `The proposed token \`${decl.path}\` has value \`${decl.value}\`, which is already encoded by an existing token.`,
      evidence: [
        ...existing.slice(0, 4).map((t) => `\`${t.path}\` = ${t.value} (${t.file}:${t.line})`),
        r.source,
      ],
      suggestion: { before: `${decl.path}: ${decl.value}`, after: `// reference ${existing[0].path} instead` },
      provenance: 'DETERMINISTIC',
    });
  }
  return findings;
};

// ---------------------------------------------------------------------------
// REUSE-002 — premature promotion to a shared token
// ---------------------------------------------------------------------------
const checkPrematurePromotion: Check = (m, g) => {
  if (!m.touchesSharedTokenModule) return [];
  const r = rule('REUSE-002');
  const consumers = new Set<string>();
  for (const p of m.tokenPaths) for (const c of g.cascade(p).affectedComponents) consumers.add(c);

  // A shared-token edit that names exactly one target component is the classic
  // "I changed the global because my component needed it" mistake.
  if (m.targetComponents.length === 1) {
    return [
      {
        ruleId: r.id,
        category: r.category,
        severity: sev(m, 'blocker'),
        message: `A ${m.declaredTokens[0]?.scope ?? 'shared'} token is being added or changed to serve a single component (${m.targetComponents[0]}).`,
        evidence: [
          r.statement,
          `Blade's convention is to start the token local to ${m.targetComponents[0]} and promote it only once a third consumer appears.`,
          r.source,
        ],
        suggestion: {
          before: `// tokens/global or tokens/theme`,
          after: `// components/${m.targetComponents[0]}/${lowerFirst(m.targetComponents[0])}Tokens.ts`,
        },
        provenance: 'DETERMINISTIC',
      },
    ];
  }
  return [];
};

// ---------------------------------------------------------------------------
// REUSE-003 — extend an existing variant axis
// ---------------------------------------------------------------------------
const checkExistingVariantAxis: Check = (m, _g, prior) => {
  const findings: Finding[] = [];
  const r = rule('REUSE-003');

  for (const component of m.targetComponents) {
    const axes = prior.variantAxes(component);
    if (!axes.length) continue;

    for (const value of m.proposedVariantValues) {
      const already = axes.find((a) => a.values.includes(value));
      if (already) {
        // The prose-signal downgrade does NOT apply here. The component name and
        // the variant value are both exact matches against unions read off the
        // AST — only the wish to add it came from prose. "Button already accepts
        // variant='secondary'" is a fact about the codebase, so it blocks.
        const graphProven = m.graphProvenVariantHits.some(
          (h) => h.component === component && h.value === value,
        );
        findings.push({
          ruleId: r.id,
          category: r.category,
          severity: graphProven ? 'blocker' : sev(m, 'blocker'),
          message: `\`${component}\` already accepts \`${already.prop}="${value}"\`. This variant does not need to be created.`,
          evidence: [
            `${component}.${already.prop} allows: ${already.values.map((v) => `\`${v}\``).join(', ')}.`,
            `Extracted from the base source at blade@${prior.bladeRef}, not recalled.`,
            r.source,
          ],
          provenance: 'DETERMINISTIC',
        });
      }
    }

    // A new prop that duplicates an existing one. Covers both variant-axis props
    // and non-union props (Card.elevation is `keyof Elevation`, not a string union,
    // but proposing to "add an elevation prop to Card" is still duplication).
    const node = prior.component(component);
    for (const prop of m.proposedProps) {
      const existingAxis = axes.find((a) => a.prop === prop);
      const existingProp = node?.props.find((p) => p.name === prop);
      if (!existingAxis && !existingProp) continue;

      const graphProven = m.graphProvenPropHits.some((h) => h.component === component && h.prop === prop);
      findings.push({
        ruleId: r.id,
        category: r.category,
        severity: graphProven ? 'blocker' : 'warning',
        message: `\`${component}\` already exposes a \`${prop}\` prop; extend it rather than introducing a parallel one.`,
        evidence: [
          existingAxis
            ? `Existing values: ${existingAxis.values.map((v) => `\`${v}\``).join(', ')}.`
            : `Declared as \`${prop}${existingProp?.optional ? '?' : ''}: ${existingProp?.type}\` at ${existingProp?.file}:${existingProp?.line}.`,
          r.source,
        ],
        provenance: 'DETERMINISTIC',
      });
    }
  }
  return findings;
};

// ---------------------------------------------------------------------------
// REUSE-005 — prop naming conventions
// ---------------------------------------------------------------------------
const BOOLEANISH = /^(loading|disabled|visible|open|selected|checked|active|required|readonly|fullWidth|dismissible)$/i;

const checkPropNaming: Check = (m, g) => {
  const findings: Finding[] = [];
  const r = rule('REUSE-005');
  for (const prop of m.proposedProps) {
    if (/^is[A-Z]/.test(prop) && /^is(Not|No|Un|Dis)[A-Z]/.test(prop)) {
      findings.push({
        ruleId: r.id,
        category: r.category,
        severity: sev(m, 'blocker'),
        message: `Prop \`${prop}\` is a negated boolean. Blade forbids negative prop names.`,
        evidence: [r.statement, r.source],
        suggestion: { before: prop, after: `is${prop.replace(/^is(Not|No|Un|Dis)/, '')}` },
        provenance: 'DETERMINISTIC',
      });
      continue;
    }
    if (BOOLEANISH.test(prop) && !/^(is|has)[A-Z]/.test(prop)) {
      const canonical = `is${prop[0].toUpperCase()}${prop.slice(1)}`;
      const usedElsewhere = g.componentsWithProp(canonical);
      findings.push({
        ruleId: r.id,
        category: r.category,
        severity: sev(m, 'blocker'),
        message: `Prop \`${prop}\` should be \`${canonical}\` to match the rest of the system.`,
        evidence: [
          usedElsewhere.length
            ? `\`${canonical}\` is already used by ${usedElsewhere.slice(0, 6).map((c) => c.component).join(', ')}.`
            : r.statement,
          r.source,
        ],
        suggestion: { before: prop, after: canonical },
        provenance: 'DETERMINISTIC',
      });
    }
  }
  return findings;
};

// ---------------------------------------------------------------------------
// CAS-001 — shared token change cascades
// ---------------------------------------------------------------------------
const checkSharedTokenCascade: Check = (m, g) => {
  const findings: Finding[] = [];
  const r = rule('CAS-001');
  for (const p of m.tokenPaths) {
    const token = g.token(p);
    if (!token || token.scope === 'component') continue;
    const impact = g.cascade(p);
    if (impact.affectedComponents.length <= 1) continue;

    const unintended = impact.affectedComponents.filter((c) => !m.targetComponents.includes(c));
    if (!m.touchesSharedTokenModule && !unintended.length) continue;

    findings.push({
      ruleId: r.id,
      category: r.category,
      severity: m.touchesSharedTokenModule ? sev(m, 'blocker') : 'info',
      message: m.touchesSharedTokenModule
        ? `\`${p}\` is consumed by ${impact.affectedComponents.length} components. Changing its value changes all of them.`
        : `\`${p}\` is shared across ${impact.affectedComponents.length} components — worth confirming the change is intended system-wide.`,
      evidence: [
        `Consumers: ${impact.affectedComponents.slice(0, 20).join(', ')}${impact.affectedComponents.length > 20 ? `, +${impact.affectedComponents.length - 20} more` : ''}.`,
        m.targetComponents.length
          ? `Stated target: ${m.targetComponents.join(', ')}. Not stated but affected: ${unintended.slice(0, 12).join(', ') || 'none'}.`
          : 'No specific target component was stated.',
        r.source,
      ],
      provenance: 'DETERMINISTIC',
    });
  }
  return findings;
};

// ---------------------------------------------------------------------------
// CAS-003 — base-component changes cascade to composites
// ---------------------------------------------------------------------------
const checkBaseComponentCascade: Check = (m, g) => {
  const findings: Finding[] = [];
  const r = rule('CAS-003');
  for (const component of m.targetComponents) {
    if (!/^Base[A-Z]/.test(component)) continue;
    const downstream = g.transitiveConsumers(component);
    if (!downstream.length) continue;
    findings.push({
      ruleId: r.id,
      category: r.category,
      severity: sev(m, 'blocker'),
      message: `\`${component}\` is a primitive. Changes to it propagate to ${downstream.length} composing components.`,
      evidence: [`Composed by: ${downstream.join(', ')}.`, r.source],
      provenance: 'DETERMINISTIC',
    });
  }
  return findings;
};

// ---------------------------------------------------------------------------
// CAS-004 — cross-platform parity
// ---------------------------------------------------------------------------
const checkCrossPlatformParity: Check = (m, g) => {
  if (m.signalSource === 'prose') return []; // parity is only checkable on a real diff
  const r = rule('CAS-004');
  const bySurface = new Map<string, { component: string; surface: string; web: string[]; native: string[] }>();
  for (const f of m.files) {
    const platform = /\.web\.tsx?$/.test(f.path)
      ? 'web'
      : /\.native\.tsx?$/.test(f.path)
        ? 'native'
        : undefined;
    if (!platform) continue;
    const component = f.path.match(/components\/([A-Z][A-Za-z0-9]*)\//)?.[1];
    if (!component) continue;
    const surface = f.path.replace(/\.(?:web|native)(?=\.tsx?$)/, '');
    const key = `${component}|${surface}`;
    const entry = bySurface.get(key) ?? { component, surface, web: [], native: [] };
    entry[platform].push(f.path);
    bySurface.set(key, entry);
  }

  const findings: Finding[] = [];
  for (const touched of bySurface.values()) {
    const { component } = touched;
    const node = g.component(component);
    if (!node?.platforms.web || !node.platforms.native) continue;
    if (!!touched.web.length === !!touched.native.length) continue;
    const present = touched.web.length ? 'web' : 'native';
    const missing = present === 'web' ? 'native' : 'web';
    findings.push({
      ruleId: r.id,
      category: r.category,
      severity: sev(m, 'blocker'),
      message: `The change edits ${component}'s ${present} implementation without a matching ${missing} change.`,
      evidence: [
        `Edited: ${touched[present].join(', ')}.`,
        `No matching .${missing} implementation was modified for ${touched.surface}.`,
        r.source,
      ],
      provenance: 'DETERMINISTIC',
    });
  }
  return findings;
};

// ---------------------------------------------------------------------------
// ENC-005 — component tokens must live in the component token file
// ---------------------------------------------------------------------------
const checkTokenFileLocation: Check = (m, g) => {
  const r = rule('ENC-005');
  const findings: Finding[] = [];
  // Only meaningful on a diff: did the change add token-shaped config outside a token file?
  for (const f of m.files) {
    if (/tokens?\.ts$/i.test(f.path)) continue;
    if (!/components\//.test(f.path)) continue;
    const tokenishAdds = f.added.filter((l) => /:\s*'[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+){2,}'/.test(l));
    if (tokenishAdds.length < 3) continue;
    const comp = f.path.match(/components\/([A-Z][A-Za-z0-9]*)\//)?.[1];
    const node = comp ? g.component(comp) : undefined;
    findings.push({
      ruleId: r.id,
      category: r.category,
      severity: 'warning',
      message: `${tokenishAdds.length} token mappings were added to \`${f.path}\` rather than to a component token file.`,
      evidence: [
        node?.tokenFiles.length
          ? `${comp} already has a token file: ${node.tokenFiles.join(', ')}.`
          : `${comp} has no token file yet; the convention is to create one in the component directory.`,
        r.source,
      ],
      provenance: 'DETERMINISTIC',
    });
  }
  return findings;
};

const CHECKS: Check[] = [
  checkLiteralValues,
  checkConditionalStyling,
  checkTokenNaming,
  checkDuplicateToken,
  checkPrematurePromotion,
  checkExistingVariantAxis,
  checkPropNaming,
  checkSharedTokenCascade,
  checkBaseComponentCascade,
  checkCrossPlatformParity,
  checkTokenFileLocation,
  ...COMPOSITION_CHECKS,
  ...STRUCTURE_CHECKS,
  ...RENDER_CHECKS,
];

export function runDeterministicChecks(m: ChangeModel, g: BladeGraph, prior: BladeGraph = g): Finding[] {
  const all: Finding[] = [];
  for (const check of CHECKS) {
    try {
      all.push(...check(m, g, prior));
    } catch (err) {
      // A broken check must never take down a PR gate.
      all.push({
        ruleId: 'INTERNAL',
        category: 'encoding',
        severity: 'info',
        message: `A deterministic check failed to run: ${(err as Error).message}`,
        evidence: [],
        provenance: 'DETERMINISTIC',
      });
    }
  }
  // Stable de-duplication by rule + message.
  const seen = new Set<string>();
  return all.filter((f) => {
    const k = `${f.ruleId}|${f.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}
