/**
 * Retrieval — assembling the context bundle for Layer 2.
 *
 * The model never sees "Blade" as a blob. It sees a small, precisely-scoped
 * bundle computed from the change: the rules that could apply, the exact variant
 * axes of the target component, the tokens that already exist near this change,
 * and the computed cascade set.
 *
 * Two consequences worth stating in review:
 *  - Cost. A PR costs a few thousand tokens of context, not a repo dump.
 *  - Grounding. The model cannot hallucinate a token that is not in the bundle,
 *    because the bundle is the only place tokens come from, and the verdict
 *    validator rejects cited tokens that are not in the graph.
 */
import type { ChangeModel } from '../checks/changeModel.js';
import type { BladeGraph } from '../extract/graph.js';
import type { Finding, Rule, CascadeImpact } from '../types.js';
import { RULEBOOK } from './rulebook.js';

export interface ContextBundle {
  rules: Rule[];
  targetComponents: {
    name: string;
    variantAxes: { prop: string; values: string[] }[];
    tokenFiles: string[];
    platforms: { web: boolean; native: boolean };
    composes: string[];
    composedBy: string[];
    hasDecisionsDoc: boolean;
    sampleTokens: string[];
  }[];
  /** Existing tokens semantically near the change — the reuse candidates. */
  candidateTokens: { path: string; scope: string; value?: string | number }[];
  cascade: CascadeImpact[];
  /** Components that already expose the proposed props, for the reuse question. */
  priorArt: { prop: string; usedBy: { component: string; allowedValues: string[] }[] }[];
  proposedNewComponent: boolean;
  similarComponents: {
    proposed: string;
    candidate: string;
    sharedProps: string[];
    proposedProps: string[];
    candidateProps: string[];
    /** Coverage of the proposed surface by the existing component. */
    score: number;
  }[];
  deterministicFindings: Finding[];
  excerpts: { source: string; text: string }[];
  approxTokens: number;
}

/** Pull the section of an architectural doc most relevant to the change. */
function excerptDoc(text: string, terms: string[], maxChars = 1400): string {
  const lines = text.split('\n');
  let bestIdx = 0;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const window = lines.slice(i, i + 20).join(' ').toLowerCase();
    let score = 0;
    for (const t of terms) if (window.includes(t.toLowerCase())) score++;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestScore === 0) return text.slice(0, maxChars);
  return lines.slice(Math.max(0, bestIdx - 2), bestIdx + 24).join('\n').slice(0, maxChars);
}

export function buildContext(
  m: ChangeModel,
  g: BladeGraph,
  deterministicFindings: Finding[],
  prior: BladeGraph = g,
): ContextBundle {
  // Rules: everything the change could plausibly touch. The rulebook is small
  // enough to send whole, which is deliberate — the model must never invent a
  // rule, and it can only cite what it was given.
  const rules = RULEBOOK;

  const targetComponents = m.targetComponents.map((name) => {
    const node = g.component(name);
    return {
      name,
      variantAxes: g.variantAxes(name),
      tokenFiles: node?.tokenFiles ?? [],
      platforms: node?.platforms ?? { web: false, native: false },
      composes: node?.composes ?? [],
      composedBy: g.transitiveConsumers(name),
      hasDecisionsDoc: node?.hasDecisionsDoc ?? false,
      sampleTokens: g.tokensFor(name).slice(0, 25),
    };
  });

  // Reuse candidates: tokens matching the change's vocabulary, plus exact-value matches.
  const queryTerms = [
    ...m.proposedVariantValues,
    ...m.proposedProps,
    ...m.targetComponents,
    ...m.intent.split(/\s+/).filter((w) => w.length > 4),
  ];
  const candidateSet = new Map<string, { path: string; scope: string; value?: string | number }>();
  for (const term of queryTerms.slice(0, 12)) {
    for (const t of g.searchTokens(term, 6)) {
      candidateSet.set(t.path, { path: t.path, scope: t.scope, value: t.value });
    }
  }
  for (const lit of m.literalDimensions) {
    for (const t of g.tokensWithValue(Number(lit.value))) {
      candidateSet.set(t.path, { path: t.path, scope: t.scope, value: t.value });
    }
  }
  for (const lit of m.literalColors) {
    for (const t of g.tokensWithValue(lit.value)) {
      candidateSet.set(t.path, { path: t.path, scope: t.scope, value: t.value });
    }
  }

  // Cascade: computed, never recalled.
  const cascade: CascadeImpact[] = [];
  const cascadeSeen = new Set<string>();
  for (const p of m.tokenPaths) {
    if (cascadeSeen.has(p)) continue;
    cascadeSeen.add(p);
    cascade.push(g.cascade(p));
  }
  for (const name of m.targetComponents) {
    const downstream = g.transitiveConsumers(name);
    if (downstream.length) {
      cascade.push({ tokenPath: `component:${name}`, affectedComponents: downstream, aliasedBy: [] });
    }
  }

  const priorArt = m.proposedProps.map((prop) => ({
    prop,
    usedBy: prior.componentsWithProp(prop).filter((c) => c.allowedValues.length).slice(0, 10),
  }));

  // For a new component PR, give the judgment layer concrete existing surfaces
  // to compare instead of asking it to recall Blade components from memory.
  const similarComponents: ContextBundle['similarComponents'] = [];
  if (m.proposesNewComponent) {
    for (const proposedName of m.targetComponents) {
      const proposedNode = g.component(proposedName);
      const proposedProps = [...new Set(proposedNode?.props.map((p) => p.name) ?? m.proposedProps)].sort();
      if (!proposedProps.length) continue;
      for (const candidateNode of prior.graph.components) {
        if (candidateNode.name === proposedName) continue;
        const candidateProps = [...new Set(candidateNode.props.map((p) => p.name))].sort();
        const candidateSet = new Set(candidateProps);
        const sharedProps = proposedProps.filter((p) => candidateSet.has(p));
        const score = sharedProps.length / proposedProps.length;
        if (sharedProps.length < 2 || score < 0.3) continue;
        similarComponents.push({
          proposed: proposedName,
          candidate: candidateNode.name,
          sharedProps,
          proposedProps,
          candidateProps,
          score,
        });
      }
    }
    similarComponents.sort((a, b) => b.score - a.score || b.sharedProps.length - a.sharedProps.length);
    similarComponents.splice(8);
  }

  const excerpts: { source: string; text: string }[] = [];
  const docs = g.graph.documents;
  const docTerms = queryTerms.length ? queryTerms : ['token'];
  for (const key of ['rfcs/2021-01-04-tokens-naming-convention.md']) {
    if (docs[key]) excerpts.push({ source: key, text: excerptDoc(docs[key], docTerms) });
  }
  // The target component's own API decision doc is the most specific prior art there is.
  for (const name of m.targetComponents) {
    const node = g.component(name);
    if (node?.decisionsDocPath && docs[node.decisionsDocPath]) {
      excerpts.push({
        source: node.decisionsDocPath,
        text: excerptDoc(docs[node.decisionsDocPath], docTerms, 1200),
      });
    }
  }

  const bundle: ContextBundle = {
    rules,
    targetComponents,
    candidateTokens: [...candidateSet.values()].slice(0, 40),
    cascade,
    priorArt,
    proposedNewComponent: m.proposesNewComponent,
    similarComponents,
    deterministicFindings,
    excerpts,
    approxTokens: 0,
  };
  bundle.approxTokens = Math.ceil(JSON.stringify(bundle).length / 4);
  return bundle;
}
