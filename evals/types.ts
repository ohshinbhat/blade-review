import type { VerdictStatus, CheckCategory } from '../src/types.js';

export interface EvalCase {
  id: string;
  /** Where the case came from. Provenance matters when reading the metrics. */
  origin: 'handwritten' | 'mutation' | 'blade-pr';
  category: CheckCategory;
  intent: string;
  diff?: string;
  expected: {
    status: VerdictStatus;
    /** Rules that MUST be cited. Catches "right answer, wrong reason". */
    rules?: string[];
    /** Components that MUST appear in the cascade set. Cascade recall. */
    affectedComponents?: string[];
  };
  /** Human-readable ground truth, so a failing case is debuggable. */
  rationale: string;
  /** Set when derived from a real Blade PR. */
  sourceUrl?: string;
}

export interface CaseResult {
  case: EvalCase;
  actual: VerdictStatus;
  confidence: number;
  rulesCited: string[];
  cascadeComponents: string[];
  statusCorrect: boolean;
  rulesCorrect: boolean;
  cascadeRecall: number | null;
  latencyMs: number;
  error?: string;
}
