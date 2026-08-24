/**
 * Component API + component-token extraction — Layer 0.
 *
 * Produces:
 *   1. The component API index: every prop, and for string-literal unions the
 *      exact set of allowed values. Those unions ARE the variant axes, which is
 *      what "did this PR create a new variant or extend one" needs to know.
 *   2. Token usage edges: component token files map prop combinations to
 *      dot-notation token paths. Those string literals are the cascade graph.
 */
import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';
import type { ComponentNode, PropDefinition, TokenUsageEdge, TokenNode } from '../types.js';
import { parseFile, walkObjectLiteral, isTokenPathLike } from './tokens.js';

const SKIP_DIR = /(__tests__|__snapshots__|stories|docs)/;

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function walkFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.test(e.name)) continue;
      walkFiles(full, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.stories\.|\.test\./.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Collect string-literal members of a union type node, if it is one. */
function unionStringLiterals(node: ts.TypeNode): string[] {
  const values: string[] = [];
  const visit = (t: ts.TypeNode): void => {
    if (ts.isUnionTypeNode(t)) {
      t.types.forEach(visit);
    } else if (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) {
      values.push(t.literal.text);
    } else if (ts.isParenthesizedTypeNode(t)) {
      visit(t.type);
    }
  };
  visit(node);
  return values;
}

/**
 * Extract props from `*Props` type declarations.
 *
 * Blade composes public prop types out of non-exported aliases:
 *
 *     type BaseButtonCommonProps = { variant?: 'primary' | 'secondary' | 'tertiary'; ... }
 *     type BaseButtonWithIconProps = BaseButtonCommonProps & { icon: IconComponent }
 *     export type BaseButtonProps = BaseButtonWithIconProps | BaseButtonWithoutIconProps
 *
 * So we cannot look at exported declarations only, and we cannot look at type
 * literals only. We build a local alias table, then flatten unions and
 * intersections through it. This is the difference between reporting that Button
 * has zero variant axes and reporting its real `variant`/`color`/`size` unions.
 */
function extractPropsFromFile(filePath: string, repoRoot: string): PropDefinition[] {
  let sf: ts.SourceFile;
  try {
    sf = parseFile(filePath);
  } catch {
    return [];
  }
  const rel = path.relative(repoRoot, filePath);
  const props: PropDefinition[] = [];

  // Local alias table: every type alias in the file, so references can be followed.
  const aliases = new Map<string, ts.TypeNode>();
  for (const stmt of sf.statements) {
    if (ts.isTypeAliasDeclaration(stmt)) aliases.set(stmt.name.text, stmt.type);
  }

  const readMembers = (members: ts.NodeArray<ts.TypeElement> | ts.TypeElement[]): void => {
    for (const m of members) {
      if (!ts.isPropertySignature(m) || !m.name || !m.type) continue;
      const name = ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) ? m.name.text : undefined;
      if (!name) continue;
      const allowedValues = unionStringLiterals(m.type);
      props.push({
        name,
        allowedValues,
        optional: !!m.questionToken,
        isVariantAxis: allowedValues.length > 1,
        type: m.type.getText(sf).replace(/\s+/g, ' ').slice(0, 200),
        file: rel,
        line: lineOf(sf, m),
      });
    }
  };

  /** Flatten a type node into prop members, following local aliases. */
  const flatten = (t: ts.TypeNode, seen: Set<string>, depth = 0): void => {
    if (depth > 6) return;
    if (ts.isTypeLiteralNode(t)) {
      readMembers(t.members);
    } else if (ts.isIntersectionTypeNode(t) || ts.isUnionTypeNode(t)) {
      // A union of prop shapes (with-icon / without-icon) still describes one public
      // API surface; merging the branches is what a reviewer reasons about.
      for (const part of t.types) flatten(part, seen, depth + 1);
    } else if (ts.isParenthesizedTypeNode(t)) {
      flatten(t.type, seen, depth + 1);
    } else if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName)) {
      const name = t.typeName.text;
      if (seen.has(name)) return;
      seen.add(name);
      const target = aliases.get(name);
      if (target) flatten(target, seen, depth + 1);
    }
  };

  for (const stmt of sf.statements) {
    // Non-exported aliases matter: they carry the actual prop members.
    if (ts.isTypeAliasDeclaration(stmt) && /Props$/.test(stmt.name.text)) {
      flatten(stmt.type, new Set([stmt.name.text]));
    }
    if (ts.isInterfaceDeclaration(stmt) && /Props$/.test(stmt.name.text)) {
      readMembers(stmt.members);
    }
  }

  // De-duplicate by prop name, preferring the definition that carries a variant axis.
  const byName = new Map<string, PropDefinition>();
  for (const p of props) {
    const prev = byName.get(p.name);
    if (!prev || (!prev.isVariantAxis && p.isVariantAxis)) byName.set(p.name, p);
  }
  return [...byName.values()];
}

/** Component token files are the config-driven encoding surface. Their string leaves are token paths. */
function extractTokenUsages(
  componentName: string,
  tokenFile: string,
  repoRoot: string,
): { edges: TokenUsageEdge[]; componentTokens: TokenNode[] } {
  const sf = parseFile(tokenFile);
  const rel = path.relative(repoRoot, tokenFile);
  const edges: TokenUsageEdge[] = [];
  const componentTokens: TokenNode[] = [];
  const seenEdge = new Set<string>();

  const emitLeaf = (leafPath: string[], value: string | number | undefined, node: ts.Node): void => {
    const contextPath = leafPath.join('.');
    componentTokens.push({
      path: `${componentName}.${contextPath}`,
      scope: 'component',
      category: 'unknown',
      value,
      file: rel,
      line: lineOf(sf, node),
      owner: componentName,
    });
    if (typeof value === 'string' && isTokenPathLike(value)) {
      const k = `${componentName}|${value}|${contextPath}`;
      if (seenEdge.has(k)) return;
      seenEdge.add(k);
      edges.push({
        component: componentName,
        tokenPath: value,
        contextPath,
        file: rel,
        line: lineOf(sf, node),
        provenance: 'EXTRACTED',
      });
    }
  };

  // Object literals anywhere in the file (component token files often return objects
  // from small factory functions, e.g. `backgroundGradient(color)` in buttonTokens.ts).
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      walkObjectLiteral(sf, node, [], emitLeaf);
      return; // walkObjectLiteral already recurses into nested literals
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Template literals like `interactive.background.${color}.default` are still token references;
  // record them with the interpolation slot marked so cascade analysis can widen the match.
  const templateVisit = (node: ts.Node): void => {
    if (ts.isTemplateExpression(node)) {
      const raw =
        node.head.text +
        node.templateSpans.map((s) => '${*}' + s.literal.text).join('');
      if (/^[a-z][a-zA-Z0-9]*\./.test(raw)) {
        const k = `${componentName}|${raw}|tpl`;
        if (!seenEdge.has(k)) {
          seenEdge.add(k);
          edges.push({
            component: componentName,
            tokenPath: raw,
            contextPath: 'template',
            file: rel,
            line: lineOf(sf, node),
            provenance: 'EXTRACTED',
          });
        }
      }
    }
    ts.forEachChild(node, templateVisit);
  };
  templateVisit(sf);

  return { edges, componentTokens };
}

/** Detect which base/primitive components a component composes, from its JSX usage. */
function detectComposition(files: string[], allComponentNames: Set<string>): string[] {
  const composed = new Set<string>();
  for (const f of files) {
    if (!/\.tsx$/.test(f)) continue;
    let text: string;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)) {
      const name = m[1];
      if (allComponentNames.has(name)) composed.add(name);
    }
  }
  return [...composed];
}

export function extractComponents(
  bladeSrc: string,
  repoRoot: string,
): { components: ComponentNode[]; usages: TokenUsageEdge[]; componentTokens: TokenNode[] } {
  const componentsDir = path.join(bladeSrc, 'components');
  const dirNames = fs
    .readdirSync(componentsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !SKIP_DIR.test(e.name))
    .map((e) => e.name);

  const allNames = new Set(dirNames);
  const components: ComponentNode[] = [];
  const usages: TokenUsageEdge[] = [];
  const componentTokens: TokenNode[] = [];

  for (const name of dirNames) {
    const dir = path.join(componentsDir, name);
    const files = walkFiles(dir);

    const tokenFiles = files.filter((f) => /tokens?\.ts$/i.test(path.basename(f)));
    // Prop declarations are spread across types.ts, the component .tsx, and Base*/
    // sub-implementations. Scan every non-test source file in the component directory.
    const props: PropDefinition[] = [];
    for (const tf of files) props.push(...extractPropsFromFile(tf, repoRoot));

    for (const tf of tokenFiles) {
      const res = extractTokenUsages(name, tf, repoRoot);
      usages.push(...res.edges);
      componentTokens.push(...res.componentTokens);
    }

    const decisions = path.join(dir, '_decisions', 'decisions.md');
    const nestedDecisions = files.length
      ? fs.existsSync(decisions)
        ? decisions
        : undefined
      : undefined;

    const byName = new Map<string, PropDefinition>();
    for (const p of props) {
      const prev = byName.get(p.name);
      if (!prev || (!prev.isVariantAxis && p.isVariantAxis)) byName.set(p.name, p);
    }

    components.push({
      name,
      dir: path.relative(repoRoot, dir),
      props: [...byName.values()],
      tokenFiles: tokenFiles.map((f) => path.relative(repoRoot, f)),
      platforms: {
        web: files.some((f) => /\.web\.tsx?$/.test(f)),
        native: files.some((f) => /\.native\.tsx?$/.test(f)),
      },
      hasDecisionsDoc: !!nestedDecisions,
      decisionsDocPath: nestedDecisions ? path.relative(repoRoot, nestedDecisions) : undefined,
      composes: detectComposition(files, allNames).filter((c) => c !== name),
    });
  }

  return { components, usages, componentTokens };
}
