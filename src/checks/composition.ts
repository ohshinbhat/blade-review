/**
 * Layer 1 — composition checks.
 *
 * The checks in `index.ts` decide whether the change is *encoded* correctly
 * (tokens, not literals). These decide whether the change is *composed*
 * correctly — whether the JSX tree the diff adds is built out of Blade's own
 * primitives, the way Blade itself is. Same free-and-exact deal as every
 * other Layer 1 check: a JSX tree read off the AST, checked against the
 * extracted component index. No model call.
 *
 * Composition rules over-fire more easily than token rules — there are
 * plenty of legitimate reasons to reach for a raw element — so severities
 * here lean warning by default and reserve blocker for patterns with very
 * low false-positive risk (an inline style object, an interactive element
 * nested inside another, a literal value the component's own type does not
 * allow).
 *
 * One design note earned the hard way: an earlier draft of this file checked
 * for *missing* required props by reading `ComponentNode.props` — the same
 * field REUSE-003 uses. That field aggregates every `*Props` type across a
 * component's whole directory (public API, internal `Base*` styled
 * implementations, sibling slot components like `Card.Header`), which is
 * exactly what REUSE-003 wants but is the wrong shape for "what must I pass
 * in JSX": querying it against real extracted data flagged `<Chip>Label</Chip>`
 * for missing `theme` and `borderColor` — internal styled-components props no
 * consumer ever passes. COMP-005 below reads `allowedValues` on a declared
 * variant axis instead, which is the one slice of that same field verified
 * against real data to be reliably public-facing (see REUSE-003, which has
 * shipped against it since before this file existed).
 */
import type { Finding } from '../types.js';
import type { BladeGraph } from '../extract/graph.js';
import type { ChangeModel } from './changeModel.js';
import type { JsxNode } from '../extract/jsx.js';
import { flattenJsx } from '../extract/jsx.js';
import { rule } from '../knowledge/rulebook.js';
import { primitiveForIntrinsic } from './structure.js';

type Check = (m: ChangeModel, g: BladeGraph, prior: BladeGraph) => Finding[];

/** Severity floor: prose-only signals never block. Composition signals are always diff-derived in practice, but this keeps the same contract as checks/index.ts. */
function sev(m: ChangeModel, desired: 'blocker' | 'warning'): 'blocker' | 'warning' {
  return m.signalSource === 'prose' && desired === 'blocker' ? 'warning' : desired;
}

function allNodes(m: ChangeModel): { file: string; node: JsxNode; parent?: JsxNode }[] {
  return flattenJsx(m.jsxComposition);
}

// ---------------------------------------------------------------------------
// COMP-001 — raw intrinsic where a verified Blade primitive exists
// ---------------------------------------------------------------------------
/**
 * Deliberately small and conservative: every target here is checked against
 * the live component index at finding-time (`g.component(target)`), so the
 * mapping can never claim a primitive exists when it does not.
 */
const checkRawIntrinsic: Check = (m, g) => {
  const findings: Finding[] = [];
  const r = rule('COMP-001');
  const seen = new Set<string>();
  for (const { file, node } of allNodes(m)) {
    if (node.kind !== 'intrinsic') continue;
    const target = primitiveForIntrinsic(node.element, g);
    const targetNode = target ? g.component(target) : undefined;
    if (!target || !targetNode) continue;
    const key = `${file}:${node.line}:${node.element}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      ruleId: r.id,
      category: r.category,
      severity: 'warning',
      message: `Raw \`<${node.element}>\` is used where Blade's \`${target}\` primitive exists.`,
      evidence: [
        `${file}:${node.line}`,
        `\`${target}\` is extracted from ${targetNode.dir} and carries Blade's token-driven styling and web/native parity; a raw ${node.kind === 'intrinsic' ? 'intrinsic' : 'element'} bypasses both.`,
        r.source,
      ],
      // Replacing only the opening tag would leave the closing tag unchanged and
      // produce invalid JSX. Whole-subtree reuse is reported by COMP-003; a safe
      // auto-fix needs a complete-file AST transform.
      provenance: 'DETERMINISTIC',
    });
  }
  return findings;
};

// ---------------------------------------------------------------------------
// COMP-002 — inline style/css prop instead of Blade's styled, token-driven props
// ---------------------------------------------------------------------------
const checkInlineStyleProp: Check = (m) => {
  const findings: Finding[] = [];
  const r = rule('COMP-002');
  const seen = new Set<string>();
  for (const { file, node } of allNodes(m)) {
    const styleProp = node.props.find((p) => (p.name === 'style' || p.name === 'css') && p.isExpression);
    if (!styleProp) continue;
    const key = `${file}:${node.line}:${styleProp.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      ruleId: r.id,
      category: r.category,
      severity: sev(m, 'blocker'),
      message: `\`<${node.element}>\` sets \`${styleProp.name}\` directly instead of using Blade's styled, token-driven props.`,
      evidence: [`${file}:${node.line}`, r.source],
      provenance: 'DETERMINISTIC',
    });
  }
  return findings;
};

// ---------------------------------------------------------------------------
// COMP-004 — illegal nesting: interactive-in-interactive, Typography-in-Typography
// ---------------------------------------------------------------------------
const INTERACTIVE = new Set(['Button', 'Link', 'Checkbox', 'Radio', 'Switch', 'Chip', 'SegmentedControl', 'FloatingActionButton']);

function baseName(node: JsxNode): string | undefined {
  return node.kind === 'blade' ? node.element.split('.')[0] : undefined;
}

const checkIllegalNesting: Check = (m, g) => {
  const findings: Finding[] = [];
  const r = rule('COMP-004');
  const seen = new Set<string>();

  const visit = (file: string, node: JsxNode, ancestors: JsxNode[]): void => {
    const base = baseName(node);
    if (base) {
      if (INTERACTIVE.has(base) && g.component(base)) {
        const interactiveAncestor = [...ancestors].reverse().find((a) => {
          const ab = baseName(a);
          return !!ab && INTERACTIVE.has(ab) && !!g.component(ab);
        });
        if (interactiveAncestor) {
          const key = `${file}:${node.line}:interactive`;
          if (!seen.has(key)) {
            seen.add(key);
            findings.push({
              ruleId: r.id,
              category: r.category,
              severity: sev(m, 'blocker'),
              message: `\`<${node.element}>\` is nested inside \`<${interactiveAncestor.element}>\`. Interactive elements cannot nest — the inner control is unreachable by keyboard/assistive tech and the two DOM roles collide.`,
              evidence: [
                `${file}:${node.line}`,
                `Outer interactive element: \`<${interactiveAncestor.element}>\` at ${file}:${interactiveAncestor.line}.`,
                r.source,
              ],
              provenance: 'DETERMINISTIC',
            });
          }
        }
      }
      if (base === 'Typography') {
        const typographyAncestor = ancestors.find((a) => baseName(a) === 'Typography');
        if (typographyAncestor) {
          const key = `${file}:${node.line}:typography`;
          if (!seen.has(key)) {
            seen.add(key);
            findings.push({
              ruleId: r.id,
              category: r.category,
              severity: 'warning',
              message: `\`<Typography>\` is nested inside another \`<Typography>\` (${file}:${typographyAncestor.line}). Text primitives should not wrap each other.`,
              evidence: [`${file}:${node.line}`, r.source],
              provenance: 'DETERMINISTIC',
            });
          }
        }
      }
    }
    for (const c of node.children) visit(file, c, [...ancestors, node]);
  };

  for (const { file, roots } of m.jsxComposition) for (const root of roots) visit(file, root, []);
  return findings;
};

// ---------------------------------------------------------------------------
// COMP-005 — literal value not among a declared variant axis's allowed values
// ---------------------------------------------------------------------------
/**
 * Complements REUSE-003, not duplicates it. REUSE-003 catches a PR *proposing
 * to add* a variant value that already exists on the union. This catches a
 * PR *using* a variant value in JSX that was never added to the union at all
 * — a typo'd or hallucinated `variant="quaternary"` on a component whose real
 * axis stops at `tertiary`. A real compiler would eventually catch this too;
 * the point of catching it here is the same as everywhere else in this
 * package — before a build step, with a cited rule instead of a raw TS error.
 */
const checkInvalidVariantLiteral: Check = (m, g) => {
  const findings: Finding[] = [];
  const r = rule('COMP-005');
  const seen = new Set<string>();

  for (const { file, node } of allNodes(m)) {
    if (node.kind !== 'blade' || node.element.includes('.')) continue; // skip slot/compound tags — axis lookup is per top-level component
    const axes = g.variantAxes(node.element);
    if (!axes.length) continue;

    for (const prop of node.props) {
      if (prop.isExpression || typeof prop.literal !== 'string') continue;
      const axis = axes.find((a) => a.prop === prop.name);
      if (!axis || axis.values.includes(prop.literal)) continue;

      const key = `${file}:${node.line}:${prop.name}:${prop.literal}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        ruleId: r.id,
        category: r.category,
        severity: sev(m, 'blocker'),
        message: `\`<${node.element} ${prop.name}="${prop.literal}">\` is not one of ${node.element}'s declared \`${prop.name}\` values.`,
        evidence: [
          `${file}:${node.line}`,
          `${node.element}.${prop.name} allows: ${axis.values.map((v) => `\`${v}\``).join(', ')}. Extracted from the component's own Props type, not recalled.`,
          r.source,
        ],
        provenance: 'DETERMINISTIC',
      });
    }
  }
  return findings;
};

export const COMPOSITION_CHECKS: Check[] = [
  checkRawIntrinsic,
  checkInlineStyleProp,
  checkIllegalNesting,
  checkInvalidVariantLiteral,
];
