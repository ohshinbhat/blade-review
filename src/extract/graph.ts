/**
 * Knowledge-graph queries — the deterministic half of the agent's reasoning.
 *
 * Every answer here is computed from extracted edges. Cascade impact in
 * particular must never be model-recalled: telling a designer "this also affects
 * Card" when it does not is the fastest way to lose the trust the tool depends on.
 */
import type { KnowledgeGraph, TokenNode, ComponentNode, CascadeImpact } from '../types.js';

export class BladeGraph {
  private tokenByPath = new Map<string, TokenNode>();
  private tokensByValue = new Map<string, TokenNode[]>();
  private consumersByToken = new Map<string, Set<string>>();
  private tokensByComponent = new Map<string, Set<string>>();
  private componentByName = new Map<string, ComponentNode>();
  /** Reverse composition: BaseButton -> [Button, IconButton, ...] */
  private composedBy = new Map<string, Set<string>>();

  constructor(public readonly graph: KnowledgeGraph) {
    for (const t of graph.tokens) {
      if (!this.tokenByPath.has(t.path)) this.tokenByPath.set(t.path, t);
      if (t.value !== undefined && t.scope !== 'component') {
        const k = String(t.value);
        if (!this.tokensByValue.has(k)) this.tokensByValue.set(k, []);
        this.tokensByValue.get(k)!.push(t);
      }
    }
    for (const c of graph.components) {
      this.componentByName.set(c.name, c);
      for (const base of c.composes) {
        if (!this.composedBy.has(base)) this.composedBy.set(base, new Set());
        this.composedBy.get(base)!.add(c.name);
      }
    }
    for (const u of graph.usages) {
      if (!this.consumersByToken.has(u.tokenPath)) this.consumersByToken.set(u.tokenPath, new Set());
      this.consumersByToken.get(u.tokenPath)!.add(u.component);
      if (!this.tokensByComponent.has(u.component)) this.tokensByComponent.set(u.component, new Set());
      this.tokensByComponent.get(u.component)!.add(u.tokenPath);
    }
  }

  get bladeRef(): string {
    return this.graph.bladeRef;
  }

  token(path: string): TokenNode | undefined {
    return this.tokenByPath.get(path);
  }

  component(name: string): ComponentNode | undefined {
    return this.componentByName.get(name);
  }

  allComponentNames(): string[] {
    return [...this.componentByName.keys()];
  }

  /** Tokens whose literal value equals `value` — the exact duplicate-token check. */
  tokensWithValue(value: string | number): TokenNode[] {
    return this.tokensByValue.get(String(value)) ?? [];
  }

  /**
   * Tokens declared in a given source file.
   *
   * Used to resolve a diff hunk's leaf key back to its addressable path: a hunk
   * shows `medium: 8` with no nesting context, but the file it landed in plus the
   * extracted index together identify it as `border.radius.medium`.
   */
  tokensDeclaredIn(file: string): TokenNode[] {
    if (!this.tokensByFile) {
      this.tokensByFile = new Map();
      for (const t of this.graph.tokens) {
        if (!this.tokensByFile.has(t.file)) this.tokensByFile.set(t.file, []);
        this.tokensByFile.get(t.file)!.push(t);
      }
    }
    // Diff paths and extracted paths are both repo-relative, but tolerate either
    // being a suffix of the other so a/ and b/ prefixes do not break the match.
    const direct = this.tokensByFile.get(file);
    if (direct) return direct;
    for (const [k, v] of this.tokensByFile) {
      if (k.endsWith(file) || file.endsWith(k)) return v;
    }
    return [];
  }

  private tokensByFile?: Map<string, TokenNode[]>;

  /** Case-insensitive fuzzy search over token paths, for "does something like this exist". */
  searchTokens(query: string, limit = 12): TokenNode[] {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2);
    if (!terms.length) return [];
    const scored = this.graph.tokens
      .filter((t) => t.scope !== 'component')
      .map((t) => {
        const p = t.path.toLowerCase();
        let score = 0;
        for (const term of terms) if (p.includes(term)) score += term.length;
        return { t, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((x) => x.t);
  }

  /**
   * Cascade impact of changing a token.
   *
   * Matches exact paths, prefix descendants (changing `border.radius` hits
   * `border.radius.medium`), and templated references such as
   * `interactive.background.${color}.default` which a literal compare would miss.
   */
  cascade(tokenPath: string): CascadeImpact {
    const affected = new Set<string>();
    const aliasedBy = new Set<string>();

    for (const [path, consumers] of this.consumersByToken) {
      if (this.pathMatches(path, tokenPath)) {
        for (const c of consumers) affected.add(c);
        if (path !== tokenPath) aliasedBy.add(path);
      }
    }

    // A token consumed by a base/primitive component cascades to everything composing it.
    for (const name of [...affected]) {
      for (const downstream of this.transitiveConsumers(name)) affected.add(downstream);
    }

    return {
      tokenPath,
      affectedComponents: [...affected].sort(),
      aliasedBy: [...aliasedBy].sort(),
    };
  }

  /**
   * Does a recorded usage edge cover the token being changed?
   *
   * Three ways it can:
   *  - exact path equality
   *  - ancestor/descendant (changing `border.radius` hits `border.radius.medium`,
   *    and a component that reads `border.radius.medium` is hit by a change to
   *    the `border.radius` group)
   *  - wildcard: `border.radius.[*]` (computed index) or
   *    `interactive.background.${*}.default` (template literal) cover every member
   *    of the group. Over-reporting a wildcard is deliberate — a missed consumer
   *    is a correctness failure, a widened group is a disclosure we can label.
   */
  private pathMatches(usagePath: string, target: string): boolean {
    if (usagePath === target) return true;
    if (usagePath.startsWith(target + '.')) return true;
    if (target.startsWith(usagePath + '.')) return true;

    const WILDCARD = /\$\{\*\}|\[\*\]/;
    if (WILDCARD.test(usagePath)) {
      const pattern =
        '^' +
        usagePath
          .split(/\$\{\*\}|\[\*\]/)
          .map(escapeRe)
          .join('[^.]+') +
        '$';
      if (new RegExp(pattern).test(target)) return true;
      // A wildcard group also covers anything under its literal prefix.
      const prefix = usagePath.split(WILDCARD)[0].replace(/\.$/, '');
      if (prefix && (target === prefix || target.startsWith(prefix + '.'))) return true;
    }
    return false;
  }

  /** True when the edge that matched is a widened wildcard group rather than an exact hit. */
  isWildcardEdge(usagePath: string): boolean {
    return /\$\{\*\}|\[\*\]/.test(usagePath);
  }

  /** Components that compose `name`, transitively (BaseButton -> Button -> ButtonGroup). */
  transitiveConsumers(name: string, seen = new Set<string>()): string[] {
    const direct = this.composedBy.get(name);
    if (!direct) return [];
    const out: string[] = [];
    for (const c of direct) {
      if (seen.has(c)) continue;
      seen.add(c);
      out.push(c, ...this.transitiveConsumers(c, seen));
    }
    return out;
  }

  /** Every token a component consumes. */
  tokensFor(component: string): string[] {
    return [...(this.tokensByComponent.get(component) ?? [])].sort();
  }

  /**
   * Components that already expose a prop with this name, and the values they allow.
   * Powers the "extend an existing variant axis instead of inventing one" rule.
   */
  componentsWithProp(propName: string): { component: string; allowedValues: string[] }[] {
    const out: { component: string; allowedValues: string[] }[] = [];
    for (const c of this.graph.components) {
      const p = c.props.find((x) => x.name === propName);
      if (p) out.push({ component: c.name, allowedValues: p.allowedValues });
    }
    return out;
  }

  /** Variant axes of a component: props typed as a string-literal union. */
  variantAxes(component: string): { prop: string; values: string[] }[] {
    const c = this.componentByName.get(component);
    if (!c) return [];
    return c.props
      .filter((p) => p.isVariantAxis)
      .map((p) => ({ prop: p.name, values: p.allowedValues }));
  }

  stats(): Record<string, number> {
    return {
      ...this.graph.stats,
      tokens: this.graph.tokens.length,
      components: this.graph.components.length,
      usageEdges: this.graph.usages.length,
      distinctTokensConsumed: this.consumersByToken.size,
    };
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
