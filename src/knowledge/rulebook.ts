/**
 * The rulebook.
 *
 * This is the product. The design-systems team stops being a reviewer of 60
 * designers' PRs and becomes the author of this file. Every verdict the agent
 * emits cites a rule id from here, and every rule cites where in the Blade repo
 * it was agreed. A rule with no `source` is a rule nobody agreed to, which is
 * why `source` is required by the type.
 *
 * Rules marked `deterministic: true` are fully decided by an AST/graph check and
 * never reach the model. The model only adjudicates the rest.
 */
import type { Rule } from '../types.js';

const RFC_TOKENS = 'rfcs/2021-01-04-tokens-naming-convention.md';
const BLADE_AGENTS = 'packages/blade/CLAUDE.md';

export const RULEBOOK: Rule[] = [
  // ---------------------------------------------------------------------
  // Correct encoding
  // ---------------------------------------------------------------------
  {
    id: 'ENC-001',
    title: 'No hard-coded literal values',
    category: 'encoding',
    severity: 'blocker',
    statement:
      'Visual properties must reference a design token, never a literal hex, px, rem or numeric value. Design tokens exist precisely to take the place of hard-coded properties.',
    source: `${RFC_TOKENS} § Summary — "Design tokens are pieces of data that take the place of hard-coded properties."`,
    deterministic: true,
    examples: {
      incorrect: "background-color: #0A8000;",
      correct: "backgroundColor: 'interactive.background.positive.default'",
    },
  },
  {
    id: 'ENC-002',
    title: 'Variant styling is config-driven, not conditional',
    category: 'encoding',
    severity: 'blocker',
    statement:
      'A variant must be expressed as a declarative mapping in the component token file. It must not be expressed as if/else or switch branches that return values inside the component or its styled implementation. The token file is the config; the component reads it.',
    source: `${RFC_TOKENS} § The current state — the switch-based fontColor() implementation is called out as the problem this convention replaces.`,
    deterministic: true,
    examples: {
      incorrect:
        "switch (variant) { case 'tertiary': return disabled ? 'light.950' : 'light.900' }",
      correct:
        "const buttonTokens = { base: { tertiary: { default: 'surface.background.gray.intense' } } }",
    },
  },
  {
    id: 'ENC-003',
    title: 'Token names follow Object.Base.Modifier hierarchy',
    category: 'encoding',
    severity: 'blocker',
    statement:
      'A token name is composed as Object.Base.Modifier. Base orders as category, then behavior, then property. Modifier orders as variant, then state, then scale, then mode. Levels may be skipped but never reordered.',
    source: `${RFC_TOKENS} § Creating a new token`,
    deterministic: true,
    examples: {
      correct: 'interactive.background.primary.highlighted',
      incorrect: 'interactive.primary.background.highlighted',
    },
  },
  {
    id: 'ENC-004',
    title: 'Specificity over flexibility',
    category: 'encoding',
    severity: 'warning',
    statement:
      'A colour token must carry a property level (background, border, text). A token that names only a category and a variant leaves the application surface to the consumer and is not specific enough.',
    source: `${RFC_TOKENS} § Principles Used — Specificity over Flexibility`,
    deterministic: true,
    examples: {
      incorrect: 'theme.color.success',
      correct: 'theme.color.background.success',
    },
  },
  {
    id: 'ENC-005',
    title: 'Component tokens live in the component token file',
    category: 'encoding',
    severity: 'warning',
    statement:
      'Component-scoped tokens belong in a token file inside the component directory, so that every platform implementation of the component reads the same source and the typings are shared.',
    source: `${RFC_TOKENS} § Storing component tokens`,
    deterministic: true,
  },

  // ---------------------------------------------------------------------
  // Correct cascading
  // ---------------------------------------------------------------------
  {
    id: 'CAS-001',
    title: 'Changing a shared token changes every consumer',
    category: 'cascading',
    severity: 'blocker',
    statement:
      'Modifying the value of a global or theme token alters every component that consumes it. A change intended for one component must not be made by editing a shared token; scope it to the component instead.',
    source: `${RFC_TOKENS} § Overlapping Decisions — aliasing the specific token to the generic one preserves the ability to change one without impacting the other.`,
    deterministic: true,
  },
  {
    id: 'CAS-002',
    title: 'Alias the specific to the generic rather than diverging',
    category: 'cascading',
    severity: 'warning',
    statement:
      'When a component needs the same decision a generic token already encodes, alias the component token to the generic token. This keeps the values in sync while preserving the ability to diverge later without affecting other consumers.',
    source: `${RFC_TOKENS} § Overlapping Decisions`,
    deterministic: false,
    examples: {
      correct: "Notification.color.text.error = color.feedback.error",
    },
  },
  {
    id: 'CAS-003',
    title: 'Base-component changes cascade to composites',
    category: 'cascading',
    severity: 'blocker',
    statement:
      'A change to a Base/primitive component propagates to every component that composes it. All composing components must be considered, and their snapshots and stories updated.',
    source: `${BLADE_AGENTS} § Common Patterns — component structures must stay consistent across the system.`,
    deterministic: true,
  },
  {
    id: 'CAS-004',
    title: 'Cross-platform parity',
    category: 'cascading',
    severity: 'blocker',
    statement:
      'Blade ships React web and React Native from one codebase. A styling or behavioural change applied to a .web implementation must have a corresponding .native change, and vice versa.',
    source: 'rfcs/writing-cross-platform-typescript.md',
    deterministic: true,
  },

  // ---------------------------------------------------------------------
  // Reuse over duplication
  // ---------------------------------------------------------------------
  {
    id: 'REUSE-001',
    title: 'Do not create a token that duplicates an existing value',
    category: 'reuse',
    severity: 'blocker',
    statement:
      'A new token whose value already exists in the system must not be created. Reference the existing token, or alias to it if the new name carries distinct semantic meaning.',
    source: `${RFC_TOKENS} § Overlapping Decisions — "If purpose of two different choices is nearly identical, should it be 1 or 2 tokens?"`,
    deterministic: true,
  },
  {
    id: 'REUSE-002',
    title: 'Start within, then promote across',
    category: 'reuse',
    severity: 'blocker',
    statement:
      'A new token starts local to the component. It is promoted to a global token only once it is used in more than two places. Adding a global token to serve a single component is premature promotion.',
    source: `${RFC_TOKENS} § Principles Used — Start within, then promote across`,
    deterministic: true,
  },
  {
    id: 'REUSE-003',
    title: 'Extend an existing variant axis before creating a new one',
    category: 'reuse',
    severity: 'blocker',
    statement:
      'If a component already exposes a prop whose union expresses the intended axis of variation, add to that union. Do not introduce a second prop, or a new component, to express a variation the existing axis already covers.',
    source: `${BLADE_AGENTS} § Common Patterns — new prop names and component structures must be consistent with existing components.`,
    deterministic: true,
  },
  {
    id: 'REUSE-004',
    title: 'Do not create a component that duplicates an existing one',
    category: 'reuse',
    severity: 'blocker',
    statement:
      'A proposed new component whose prop surface substantially overlaps an existing component is a variant of that component, not a new one.',
    source: `${BLADE_AGENTS} § Common Patterns`,
    deterministic: false,
  },
  {
    id: 'REUSE-005',
    title: 'Prop naming is consistent with the rest of the system',
    category: 'reuse',
    severity: 'warning',
    statement:
      'Boolean props are prefixed is/has and are never negated. A prop that exists elsewhere in Blade keeps the same name and shape. Do not use `loading` where the system uses `isLoading`, or `isNotVisible` for a negative.',
    source: `${BLADE_AGENTS} § Common Patterns — "do not use negative prop names isNotVisible or inconsistent names like loading instead of isLoading".`,
    deterministic: true,
  },
];

export const RULES_BY_ID = new Map(RULEBOOK.map((r) => [r.id, r]));

export function rule(id: string): Rule {
  const r = RULES_BY_ID.get(id);
  if (!r) throw new Error(`Unknown rule id: ${id}. Rules must exist in the rulebook to be cited.`);
  return r;
}

/** Rules the model is allowed to cite. Deterministic rules are decided before the model runs. */
export function judgmentRules(): Rule[] {
  return RULEBOOK;
}
