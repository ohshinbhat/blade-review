/**
 * Layer 1B — semantic UI-structure reuse.
 *
 * Composition checks inspect individual JSX mistakes. This layer looks at an
 * entire added subtree and answers the broader reuse question: can the raw UI
 * structure be assembled from Blade primitives that already exist?
 *
 * This is deliberately semantic rather than visual. It uses JSX identity and
 * the extracted component catalog, never pixels, component-name embeddings, or
 * model recollection. A recommendation is advisory because equivalent markup
 * does not by itself prove equivalent product behaviour.
 */
import type { Finding } from '../types.js';
import type { BladeGraph } from '../extract/graph.js';
import type { JsxNode } from '../extract/jsx.js';
import type { ChangeModel } from './changeModel.js';
import { rule } from '../knowledge/rulebook.js';

type Check = (m: ChangeModel, g: BladeGraph, prior: BladeGraph) => Finding[];

const PRIMITIVE_BY_INTRINSIC: Readonly<Record<string, string>> = {
  div: 'Box',
  span: 'Box',
  section: 'Box',
  article: 'Box',
  main: 'Box',
  header: 'Box',
  footer: 'Box',
  nav: 'Box',
  p: 'Typography',
  h1: 'Typography',
  h2: 'Typography',
  h3: 'Typography',
  h4: 'Typography',
  h5: 'Typography',
  h6: 'Typography',
  label: 'Typography',
  strong: 'Typography',
  em: 'Typography',
  small: 'Typography',
  button: 'Button',
  input: 'Input',
  a: 'Link',
  ul: 'List',
  ol: 'List',
  li: 'List',
  table: 'Table',
};

export function primitiveForIntrinsic(element: string, graph: BladeGraph): string | undefined {
  const candidate = PRIMITIVE_BY_INTRINSIC[element];
  return candidate && graph.component(candidate) ? candidate : undefined;
}

export interface UiStructureMapping {
  element: string;
  component: string;
  line: number;
}

export interface UiStructureCandidate {
  file: string;
  line: number;
  mappings: UiStructureMapping[];
  components: string[];
  unmappedIntrinsics: string[];
  intrinsicCount: number;
  /** Portion of intrinsic nodes for which the live Blade graph has a primitive. */
  coverage: number;
}

function intrinsicNodes(root: JsxNode): JsxNode[] {
  const out: JsxNode[] = [];
  const visit = (node: JsxNode): void => {
    if (node.kind === 'intrinsic') out.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return out;
}

/**
 * Find raw JSX subtrees substantially covered by primitives in the current
 * Blade graph. Requiring at least two mapped nodes avoids nagging on a single
 * harmless wrapper; the 60% floor prevents a partial mapping from being
 * presented as a complete reuse plan.
 */
export function findReusableUiStructures(
  model: ChangeModel,
  graph: BladeGraph,
): UiStructureCandidate[] {
  const candidates: UiStructureCandidate[] = [];

  for (const { file, roots } of model.jsxComposition) {
    for (const root of roots) {
      const intrinsics = intrinsicNodes(root);
      if (!intrinsics.length) continue;

      const mappings: UiStructureMapping[] = [];
      const unmappedIntrinsics: string[] = [];
      for (const node of intrinsics) {
        const component = primitiveForIntrinsic(node.element, graph);
        if (component) mappings.push({ element: node.element, component, line: node.line });
        else unmappedIntrinsics.push(node.element);
      }

      const coverage = mappings.length / intrinsics.length;
      if (mappings.length < 2 || coverage < 0.6) continue;

      candidates.push({
        file,
        line: root.line,
        mappings,
        components: [...new Set(mappings.map((mapping) => mapping.component))],
        unmappedIntrinsics: [...new Set(unmappedIntrinsics)],
        intrinsicCount: intrinsics.length,
        coverage,
      });
    }
  }

  return candidates;
}

const checkReusableUiStructure: Check = (model, graph) => {
  const r = rule('COMP-003');
  return findReusableUiStructures(model, graph).map((candidate) => {
    const examples = candidate.mappings
      .slice(0, 8)
      .map((mapping) => `<${mapping.element}> → ${mapping.component} (line ${mapping.line})`);
    const covered = `${candidate.mappings.length}/${candidate.intrinsicCount}`;

    return {
      ruleId: r.id,
      category: r.category,
      severity: 'warning',
      message: `This added UI subtree can be composed from existing Blade primitives: ${candidate.components.join(', ')}.`,
      evidence: [
        `${candidate.file}:${candidate.line}`,
        `Primitive coverage: ${covered} intrinsic nodes (${Math.round(candidate.coverage * 100)}%). ${examples.join('; ')}.`,
        candidate.unmappedIntrinsics.length
          ? `Unmapped intrinsic elements still needing review: ${candidate.unmappedIntrinsics.join(', ')}.`
          : 'Every intrinsic element in this subtree has a verified Blade primitive in the extracted graph.',
        r.source,
      ],
      // Rewriting both opening and closing tags safely requires a complete-file
      // transform, not a one-line GitHub suggestion. Evidence is safer here.
      provenance: 'DETERMINISTIC',
    } satisfies Finding;
  });
};

export const STRUCTURE_CHECKS: Check[] = [checkReusableUiStructure];
