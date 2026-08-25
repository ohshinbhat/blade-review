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
      'A change to a Base/primitive component propagates to every component that composes it. All composing components and their stories must be considered.',
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

  // ---------------------------------------------------------------------
  // Correct composition — the JSX tree the change builds
  // ---------------------------------------------------------------------
  {
    id: 'COMP-001',
    title: 'Compose with Blade primitives, not raw intrinsics',
    category: 'composition',
    severity: 'warning',
    statement:
      'Where an equivalent Blade primitive exists (Box for layout containers, Typography for text, Button/Input/Link/List/Table for their raw HTML counterparts), a raw HTML/View intrinsic should not be used in its place. The intrinsic renders, but it bypasses the component layer that token-driven styling and web/native parity are applied through.',
    source: `${BLADE_AGENTS} § Package Structure — "ships React (web) and React Native components from a single shared codebase"; § Common Patterns — new structures should stay "consistent with existing components." A raw intrinsic where a primitive already exists is the composition-level version of that same consistency requirement.`,
    deterministic: true,
    examples: {
      incorrect: '<div style={{ padding: 4 }}>Total</div>',
      correct: '<Box padding="spacing.2"><Typography>Total</Typography></Box>',
    },
  },
  {
    id: 'COMP-002',
    title: 'No inline style/css props on composed elements',
    category: 'composition',
    severity: 'blocker',
    statement:
      'An element must not be styled with a `style` or `css` prop carrying an object/expression value. This is the same violation ENC-001 catches for a bare CSS declaration, one level up: an inline style object is a bundle of hard-coded literal values, not a token reference.',
    source: `${RFC_TOKENS} § Summary — "Design tokens are pieces of data that take the place of hard-coded properties." Applies identically whether the hard-coded values arrive as a raw declaration or as an inline style/css prop.`,
    deterministic: true,
    examples: {
      incorrect: '<Box style={{ borderRadius: 12 }} />',
      correct: '<Box borderRadius="medium" />',
    },
  },
  {
    id: 'COMP-003',
    title: 'Reuse an existing Blade composition before rebuilding raw UI structure',
    category: 'composition',
    severity: 'warning',
    statement:
      'When most elements in an added JSX subtree have verified Blade primitive equivalents, compose the UI from those existing components instead of rebuilding the same container, text, control, list, or table structure with raw intrinsics.',
    source: `${BLADE_AGENTS} § Package Structure — Blade ships shared web/native components; § Common Patterns — new component structures must remain consistent with existing components. The recommendation is emitted only for primitives present in the extracted component graph.`,
    deterministic: true,
    examples: {
      incorrect: '<section><h3>Total</h3><button>Pay</button></section>',
      correct: '<Box><Typography>Total</Typography><Button>Pay</Button></Box>',
    },
  },
  {
    id: 'COMP-004',
    title: 'Interactive elements do not nest; text primitives do not wrap themselves',
    category: 'composition',
    severity: 'blocker',
    statement:
      'An interactive component (Button, Link, Checkbox, Radio, Switch, Chip, SegmentedControl, FloatingActionButton) must not be composed inside another interactive component — the inner control becomes unreachable and the DOM/AT roles collide. A Typography element should not be nested inside another Typography element.',
    source:
      'packages/blade/src/components/Button/_decisions/decisions.md § Open Questions — on Link vs Button: "We would have another Link component that will be an <a> tag. We do this to maintain the correct roles for button & link components." Nesting interactive roles breaks the exact guarantee that decision exists to preserve.',
    deterministic: true,
    examples: {
      incorrect: '<Button><Link href="/help">Help</Link></Button>',
      correct: '<Button icon={HelpIcon} accessibilityLabel="Help" onClick={goToHelp} />',
    },
  },
  {
    id: 'COMP-005',
    title: 'A variant-axis prop must be set to one of its declared values',
    category: 'composition',
    severity: 'blocker',
    statement:
      "Where JSX passes a string literal to a prop the component's own extracted type declares as a variant axis (a string-literal union), the literal must be one of that union's members. Complements REUSE-003: that rule catches a PR proposing to add a value that already exists on the union; this one catches a value used in JSX that was never added to the union at all.",
    source:
      "Enforced by each component's own Props type, extracted per-component from the AST — not recalled, not a style guide. Uses the same `variantAxes` extraction REUSE-003 already relies on for prior-art checks.",
    deterministic: true,
    examples: {
      incorrect: '<Button variant="quaternary">Pay</Button>  // Button.variant only allows primary | secondary | tertiary',
      correct: '<Button variant="tertiary">Pay</Button>',
    },
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
