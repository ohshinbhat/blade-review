/**
 * The change model.
 *
 * Deterministic checks cannot run on a sentence. This module turns a
 * ProposedChange (natural-language intent and/or a unified diff) into structured,
 * high-confidence signals: literal values, token paths, component names, prop and
 * variant names, and per-file added/removed lines.
 *
 * Design note on honesty: signals extracted from a *diff* are exact. Signals
 * extracted from *prose* are heuristic, and are marked as such via
 * `signalSource`. Deterministic checks only ever escalate to a blocker on exact
 * signals; a prose-derived signal can open a question but never fails a PR on its
 * own. That boundary is what keeps a false-approve/false-reject rate meaningful.
 */
import type { ProposedChange } from '../types.js';
import type { BladeGraph } from '../extract/graph.js';

export interface DiffFile {
  path: string;
  added: string[];
  removed: string[];
  isNew: boolean;
}

export interface ChangeModel {
  intent: string;
  signalSource: 'diff' | 'prose' | 'both';
  files: DiffFile[];
  /** Literal colour values (#hex, rgb(...)) introduced by the change. */
  literalColors: { value: string; file?: string; line: string }[];
  /** Literal dimension values (12px, 1.5rem) introduced by the change. */
  literalDimensions: { value: string; raw: string; file?: string; line: string }[];
  /** Dot-notation token paths referenced by the change. */
  tokenPaths: string[];
  /** Token paths the change *declares* (adds to a token module). */
  declaredTokens: { path: string; value?: string | number; scope: 'global' | 'theme' | 'component' }[];
  /** Components the change targets, resolved against the graph. */
  targetComponents: string[];
  /** Prop names the change introduces or mentions. */
  proposedProps: string[];
  /** Variant/enum member values the change introduces. */
  proposedVariantValues: string[];
  /**
   * Variant values that matched an extracted union exactly.
   *
   * These are graph-proven even when the intent arrived as prose: the component
   * name and the variant value are both exact matches against data read off the
   * AST. Only the *wish* is prose. Findings backed by these are not downgraded.
   */
  graphProvenVariantHits: { component: string; prop: string; value: string }[];
  /** Props named in an additive intent that the component already declares. */
  graphProvenPropHits: { component: string; prop: string }[];
  /** Conditional styling branches introduced (switch/ternary on a variant prop). */
  conditionalBranches: { file: string; line: string }[];
  /** True when the change proposes a brand-new component. */
  proposesNewComponent: boolean;
  /** True when the change edits a global/theme token module. */
  touchesSharedTokenModule: boolean;
}

const HEX_RE = /#(?:[0-9a-fA-F]{3,8})\b/g;
const RGB_RE = /\brgba?\(\s*\d+[^)]*\)/g;
const DIM_RE = /\b(\d+(?:\.\d+)?)(px|rem|em)\b/g;
const TOKEN_PATH_RE = /\b([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_$]+){1,5})\b/g;

const GLOBAL_TOKEN_FILE = /packages\/blade\/src\/tokens\/global\//;
const THEME_TOKEN_FILE = /packages\/blade\/src\/tokens\/theme\//;
const COMPONENT_TOKEN_FILE = /components\/.*tokens?\.ts$/i;

/** Words that look like token paths but are code, not design tokens. */
const TOKEN_PATH_DENYLIST = /^(props|theme|react|console|process|object|array|string|number|window|document|styled|import|export|module|exports|node|path|fs)\./i;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Prop names of a component, longest first so `iconPosition` wins over `icon`. */
function allPropNames(graph: BladeGraph, component: string): string[] {
  const node = graph.component(component);
  if (!node) return [];
  return node.props
    .map((p) => p.name)
    .filter((n) => n.length > 3 && !n.startsWith('_'))
    .sort((a, b) => b.length - a.length);
}

export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;

  for (const raw of diff.split('\n')) {
    const fileHeader = raw.match(/^(?:diff --git a\/(\S+) b\/(\S+)|\+\+\+ b\/(\S+))/);
    if (fileHeader) {
      const p = fileHeader[2] ?? fileHeader[3] ?? fileHeader[1];
      if (p && p !== '/dev/null') {
        if (!current || current.path !== p) {
          current = { path: p, added: [], removed: [], isNew: false };
          files.push(current);
        }
      }
      continue;
    }
    if (/^new file mode/.test(raw) && current) current.isNew = true;
    if (!current) continue;
    if (raw.startsWith('+') && !raw.startsWith('+++')) current.added.push(raw.slice(1));
    else if (raw.startsWith('-') && !raw.startsWith('---')) current.removed.push(raw.slice(1));
  }
  return files;
}

function collect(re: RegExp, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(re.source, re.flags))) out.push(m[0]);
  return out;
}

export function buildChangeModel(change: ProposedChange, graph: BladeGraph): ChangeModel {
  const g = graph;
  const files = change.diff ? parseDiff(change.diff) : [];
  const hasDiff = files.length > 0;
  const prose = change.intent ?? '';

  const model: ChangeModel = {
    intent: prose,
    signalSource: hasDiff && prose ? 'both' : hasDiff ? 'diff' : 'prose',
    files,
    literalColors: [],
    literalDimensions: [],
    tokenPaths: [],
    declaredTokens: [],
    targetComponents: [],
    proposedProps: [],
    proposedVariantValues: [],
    graphProvenVariantHits: [],
    graphProvenPropHits: [],
    conditionalBranches: [],
    proposesNewComponent: false,
    touchesSharedTokenModule: false,
  };

  // ---- signals from the diff (exact) -------------------------------------
  for (const f of files) {
    const isStyleSurface = /\.(tsx?|css|styles\.ts)$/.test(f.path);
    if (GLOBAL_TOKEN_FILE.test(f.path) || THEME_TOKEN_FILE.test(f.path)) {
      model.touchesSharedTokenModule = true;
    }

    for (const line of f.added) {
      if (isStyleSurface) {
        for (const c of collect(HEX_RE, line)) model.literalColors.push({ value: c.toLowerCase(), file: f.path, line: line.trim() });
        for (const c of collect(RGB_RE, line)) model.literalColors.push({ value: c, file: f.path, line: line.trim() });
        for (const m of line.matchAll(DIM_RE)) {
          model.literalDimensions.push({ value: m[1], raw: m[0], file: f.path, line: line.trim() });
        }
      }

      // Token declarations: `medium: 12,` inside a token module.
      const decl = line.match(/^\s*'?([a-zA-Z0-9_$]+)'?\s*:\s*(-?\d+(?:\.\d+)?|'[^']*')\s*,?\s*$/);
      if (decl) {
        const scope = GLOBAL_TOKEN_FILE.test(f.path)
          ? 'global'
          : THEME_TOKEN_FILE.test(f.path)
            ? 'theme'
            : COMPONENT_TOKEN_FILE.test(f.path)
              ? 'component'
              : undefined;
        if (scope) {
          const rawVal = decl[2];
          const key = decl[1];
          model.declaredTokens.push({
            path: key,
            value: rawVal.startsWith("'") ? rawVal.slice(1, -1) : Number(rawVal),
            scope,
          });

          // A diff hunk gives us the leaf key (`medium`) but not the nesting that
          // makes it addressable (`border.radius.medium`). Resolve it against the
          // graph by matching the file the edit landed in. Without this, editing a
          // shared token in place looks like an unrelated declaration and the
          // cascade check never fires — which is the single most important case
          // this tool exists to catch.
          for (const t of g.tokensDeclaredIn(f.path)) {
            if (t.path === key || t.path.endsWith(`.${key}`)) model.tokenPaths.push(t.path);
          }
        }
      }

      // Conditional styling branches — the ENC-002 smell.
      if (
        /\bswitch\s*\(\s*(variant|size|emphasis|color|intent)\b/.test(line) ||
        /\bcase\s+'[a-z]+'\s*:\s*return\b/.test(line) ||
        /\b(variant|emphasis|intent)\s*===\s*'[a-z]+'\s*\?/.test(line)
      ) {
        model.conditionalBranches.push({ file: f.path, line: line.trim() });
      }

      // Prop declarations: `variant?: 'primary' | 'secondary'`
      const propDecl = line.match(/^\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\??\s*:\s*(.+?);?\s*$/);
      if (propDecl && /'[^']+'\s*\|/.test(propDecl[2])) {
        model.proposedProps.push(propDecl[1]);
        for (const v of propDecl[2].matchAll(/'([^']+)'/g)) model.proposedVariantValues.push(v[1]);
      }

      for (const m of line.matchAll(TOKEN_PATH_RE)) {
        const p = m[1];
        if (!TOKEN_PATH_DENYLIST.test(p) && graph.token(p)) model.tokenPaths.push(p);
      }
    }

    if (f.isNew && /components\/[A-Z][A-Za-z0-9]*\/[A-Z][A-Za-z0-9]*\.tsx$/.test(f.path)) {
      model.proposesNewComponent = true;
    }

    const comp = f.path.match(/components\/([A-Z][A-Za-z0-9]*)\//);
    if (comp) model.targetComponents.push(comp[1]);
  }

  // ---- signals from prose (heuristic) ------------------------------------
  if (prose) {
    for (const c of collect(HEX_RE, prose)) model.literalColors.push({ value: c.toLowerCase(), line: prose });
    for (const c of collect(RGB_RE, prose)) model.literalColors.push({ value: c, line: prose });
    for (const m of prose.matchAll(DIM_RE)) {
      model.literalDimensions.push({ value: m[1], raw: m[0], file: undefined, line: prose });
    }
    for (const m of prose.matchAll(TOKEN_PATH_RE)) {
      const p = m[1];
      if (!TOKEN_PATH_DENYLIST.test(p) && graph.token(p)) model.tokenPaths.push(p);
    }

    // Component resolution against the graph — no fuzzy guessing, exact name match
    // on a word boundary, longest name first so "ButtonGroup" beats "Button".
    const names = graph.allComponentNames().sort((a, b) => b.length - a.length);
    const claimed: string[] = [];
    for (const n of names) {
      if (new RegExp(`\\b${n}\\b`).test(prose)) {
        if (!claimed.some((c) => c.includes(n))) {
          model.targetComponents.push(n);
          claimed.push(n);
        }
      }
    }

    if (/\bnew component\b|\bcreate a (?:new )?component\b|\badd a component\b/i.test(prose)) {
      model.proposesNewComponent = true;
    }

    // "add a `tertiary` variant" / "new variant called ghost" / "a size prop"
    for (const m of prose.matchAll(
      /\b(?:new |add(?:ing)? (?:a )?|create (?:a )?)?[`'"]?([a-zA-Z][a-zA-Z0-9]*)[`'"]?\s+(variant|size|emphasis|prop|property)\b/gi,
    )) {
      const word = m[1].toLowerCase();
      if (['a', 'an', 'the', 'new', 'another', 'this', 'that', 'add', 'create'].includes(word)) continue;
      if (m[2].toLowerCase() === 'prop' || m[2].toLowerCase() === 'property') model.proposedProps.push(m[1]);
      else model.proposedVariantValues.push(m[1]);
    }
    for (const m of prose.matchAll(/\bvariant\s+(?:called|named)\s+[`'"]?([a-zA-Z][a-zA-Z0-9]*)/gi)) {
      model.proposedVariantValues.push(m[1]);
    }

    // Graph-driven variant detection. The regexes above only know the prop names
    // we thought to enumerate; the graph knows every variant axis of every
    // component. If the intent is additive and names a value that the target
    // component's union already contains, that is a fact, not a guess — and it is
    // exactly the "you already have this" case REUSE-003 exists to catch.
    // A prop is only "proposed" when it is the grammatical object of an additive
    // verb: "add a `density` prop". A prop merely mentioned in passing ("to
    // control internal padding") is not being added, and a negation ("no new
    // props") is the opposite of an addition. Matching any prop name anywhere in
    // the sentence produced false rejects on both shapes.
    const ADD_PROP_RE =
      /\b(?:add|adding|create|creating|introduce|introducing)\s+(?:a|an|the)?\s*[`'"]?([a-zA-Z][a-zA-Z0-9]*)[`'"]?\s+(?:prop|property|variant|axis)\b/gi;
    const explicitlyAddedProps = [...prose.matchAll(ADD_PROP_RE)].map((m) => m[1]);
    for (const p of explicitlyAddedProps) model.proposedProps.push(p);

    const isAdditive = explicitlyAddedProps.length > 0 || /\b(?:add|adding|create|creating|introduce|introducing|support|supporting)\b/i.test(prose);

    if (isAdditive) {
      for (const component of model.targetComponents) {
        const axes = graph.variantAxes(component);
        const componentProps = graph.component(component)?.props ?? [];

        // Which axis is the sentence actually about? "Add an `elevation` prop to
        // Card with values none and raised" is about elevation — the word "none"
        // belongs to the proposed elevation values, NOT to Card's existing
        // `validationState` union which also happens to contain "none". Without
        // this guard the checker reports a duplicate that was never proposed.
        const namedAxis =
          explicitlyAddedProps.find((p) => axes.some((a) => a.prop === p)) ??
          axes.map((a) => a.prop).find((p) =>
            new RegExp(`(^|[^a-zA-Z])${escapeRegex(p)}\\s+(?:prop|property|variant|axis|values?)\\b`, 'i').test(prose),
          );

        for (const axis of axes) {
          if (namedAxis && axis.prop !== namedAxis) continue;
          for (const value of axis.values) {
            if (value.length < 3) continue; // "sm"/"md" collide with ordinary prose
            if (new RegExp(`(^|[^a-zA-Z])${escapeRegex(value)}([^a-zA-Z]|$)`, 'i').test(prose)) {
              model.proposedVariantValues.push(value);
              model.graphProvenVariantHits.push({ component, prop: axis.prop, value });
            }
          }
        }

        // An explicitly-added prop that the component already declares is itself a
        // reuse finding, whether or not it is a string-union axis.
        for (const p of explicitlyAddedProps) {
          if (componentProps.some((cp) => cp.name === p)) {
            model.graphProvenPropHits.push({ component, prop: p });
          }
        }
      }
    }
    if (/\b(global|theme)\s+token\b/i.test(prose) || /\badd (?:a )?token to (?:the )?(global|theme)\b/i.test(prose)) {
      model.touchesSharedTokenModule = true;
    }
  }

  model.tokenPaths = [...new Set(model.tokenPaths)];
  model.targetComponents = [...new Set(model.targetComponents)];
  model.proposedProps = [...new Set(model.proposedProps)];
  model.proposedVariantValues = [...new Set(model.proposedVariantValues)];

  return model;
}
