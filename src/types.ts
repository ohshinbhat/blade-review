/**
 * Core domain model for the Blade design-system PR review agent.
 *
 * Everything downstream (checks, retrieval, LLM judgment, verdict routing) is
 * typed against these structures. The knowledge graph is the single source of
 * truth about Blade; nothing about Blade is hard-coded into a prompt.
 */

// ---------------------------------------------------------------------------
// Layer 0 — extracted knowledge graph
// ---------------------------------------------------------------------------

/** Where a token lives in the system. Drives the "start within, then promote across" rule. */
export type TokenScope = 'global' | 'theme' | 'component';

export type TokenCategory =
  | 'color'
  | 'spacing'
  | 'size'
  | 'border'
  | 'typography'
  | 'motion'
  | 'elevation'
  | 'opacity'
  | 'blur'
  | 'breakpoint'
  | 'unknown';

export interface TokenNode {
  /** Dot-notation path as authored, e.g. `border.radius.medium`. */
  path: string;
  scope: TokenScope;
  category: TokenCategory;
  /** Statically resolvable literal value, when the source is a literal. */
  value?: string | number;
  /** Source file the token is declared in, repo-relative. */
  file: string;
  line: number;
  /** For component-scoped tokens: which component owns them. */
  owner?: string;
}

export interface PropDefinition {
  name: string;
  /** Union members when the prop is a string-literal union (i.e. a variant axis). */
  allowedValues: string[];
  optional: boolean;
  /** True when the prop's type is a string-literal union — the "variant axis" shape. */
  isVariantAxis: boolean;
  type: string;
  file: string;
  line: number;
}

export interface ComponentNode {
  name: string;
  /** Repo-relative directory. */
  dir: string;
  props: PropDefinition[];
  /** Component-scoped token file(s), if the component follows the token-file pattern. */
  tokenFiles: string[];
  /** Platform implementations present. Used for cross-platform parity checks. */
  platforms: { web: boolean; native: boolean };
  /** Whether the component ships an API decisions doc. */
  hasDecisionsDoc: boolean;
  decisionsDocPath?: string;
  /** Base/primitive component this one composes, when detectable (e.g. Button -> BaseButton). */
  composes: string[];
}

/** A typed edge: component (optionally a specific variant) consumes a token path. */
export interface TokenUsageEdge {
  component: string;
  tokenPath: string;
  /** Object-literal key path inside the component token file, e.g. `base.primary.default`. */
  contextPath?: string;
  file: string;
  line: number;
  /** EXTRACTED = read straight off the AST. Nothing in this graph is inferred. */
  provenance: 'EXTRACTED';
}

export interface KnowledgeGraph {
  /** Commit SHA of the Blade source this graph was extracted from. */
  bladeRef: string;
  extractedAt: string;
  tokens: TokenNode[];
  components: ComponentNode[];
  usages: TokenUsageEdge[];
  /** Raw text of architectural source documents, keyed by repo-relative path. */
  documents: Record<string, string>;
  stats: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Input — the change under review
// ---------------------------------------------------------------------------

export interface ProposedChange {
  /** Natural-language statement of intent, e.g. "add a tertiary Button variant that is green". */
  intent: string;
  /** Optional unified diff, when reviewing a real PR rather than an intent. */
  diff?: string;
  /** Component the change targets. Inferred from intent/diff when omitted. */
  component?: string;
  author?: string;
  prUrl?: string;
}

// ---------------------------------------------------------------------------
// Layer 1A/1B — deterministic findings and semantic UI-structure reuse
// ---------------------------------------------------------------------------

export type CheckCategory = 'encoding' | 'cascading' | 'reuse' | 'composition';

export type Severity = 'blocker' | 'warning' | 'info';

export interface Finding {
  ruleId: string;
  category: CheckCategory;
  severity: Severity;
  message: string;
  /** Concrete evidence pulled from the graph or the diff — never model-generated. */
  evidence: string[];
  /** Machine-applicable fix, rendered as a GitHub suggestion block when available. */
  suggestion?: { file?: string; line?: number; before: string; after: string };
  /** Deterministic checks are exact. Only LLM findings carry uncertainty. */
  provenance: 'DETERMINISTIC' | 'MODEL';
}

// ---------------------------------------------------------------------------
// Layer 2/3 — judgment and routing
// ---------------------------------------------------------------------------

export type VerdictStatus = 'correct' | 'incorrect' | 'needs_human';

export interface CascadeImpact {
  tokenPath: string;
  /** Every component that consumes this token. Computed from the graph, never recalled. */
  affectedComponents: string[];
  /** Component tokens that alias this path. */
  aliasedBy: string[];
}

export interface Verdict {
  status: VerdictStatus;
  confidence: number;
  summary: string;
  reasoning: string;
  rulesCited: string[];
  findings: Finding[];
  cascade: CascadeImpact[];
  suggestedApproach?: string;
  /** Which layer produced the final status — used by the eval harness. */
  decidedBy: 'deterministic' | 'model' | 'routing';
  meta: {
    bladeRef: string;
    provider: string;
    latencyMs: number;
    contextTokensApprox: number;
  };
}

// ---------------------------------------------------------------------------
// Rulebook
// ---------------------------------------------------------------------------

export interface Rule {
  id: string;
  title: string;
  category: CheckCategory;
  severity: Severity;
  /** Statement the agent is allowed to cite verbatim. */
  statement: string;
  /** Provenance in the Blade repo. A rule with no source is a rule nobody agreed to. */
  source: string;
  /** True when a deterministic check fully covers this rule (no LLM needed). */
  deterministic: boolean;
  examples?: { correct?: string; incorrect?: string };
}
