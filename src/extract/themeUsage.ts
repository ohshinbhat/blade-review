/**
 * Theme member-access extraction — the second half of the cascade graph.
 *
 * Component token files reference *semantic* tokens as dot-notation strings, but
 * global tokens (radius, spacing, motion) are consumed as member access on the
 * theme object:
 *
 *     theme.border.radius.max                    -> border.radius.max
 *     theme.border.radius[itemBorderRadius[size]] -> border.radius.[*]
 *     getIn(theme.border.radius, pagination...)   -> border.radius.[*]
 *
 * The `[*]` marker is load-bearing. When a component indexes a token group with a
 * computed key, a change to ANY member of that group can affect it. Recording the
 * group rather than dropping the edge is what keeps cascade recall honest: we would
 * rather over-report a wildcard group (and say so) than silently miss a consumer.
 */
import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';
import type { TokenUsageEdge } from '../types.js';
import { parseFile } from './tokens.js';

const SKIP = /(__tests__|__snapshots__|\.stories\.|\.test\.|\/docs\/)/;

function walkFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (SKIP.test(full)) continue;
    if (e.isDirectory()) walkFiles(full, out);
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

/**
 * Resolve a property/element access chain to a dot path, if it is rooted at `theme`.
 * Returns undefined for chains rooted anywhere else.
 */
function resolveThemePath(node: ts.Expression): string | undefined {
  const parts: string[] = [];
  let cur: ts.Expression = node;

  for (;;) {
    if (ts.isPropertyAccessExpression(cur)) {
      parts.unshift(cur.name.text);
      cur = cur.expression;
    } else if (ts.isElementAccessExpression(cur)) {
      const arg = cur.argumentExpression;
      if (arg && ts.isStringLiteral(arg)) parts.unshift(arg.text);
      else parts.unshift('[*]'); // computed key: the whole group is in play
      cur = cur.expression;
    } else if (ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isIdentifier(cur)) {
      // Roots we treat as the theme object.
      if (cur.text === 'theme' || cur.text === 'bladeTheme') {
        if (!parts.length) return undefined;
        // `theme.colors.x.y` and a component token string `x.y` must index identically.
        if (parts[0] === 'colors') parts.shift();
        return parts.join('.');
      }
      return undefined;
    } else {
      return undefined;
    }
  }
}

export function extractThemeMemberUsages(bladeSrc: string, repoRoot: string): TokenUsageEdge[] {
  const componentsDir = path.join(bladeSrc, 'components');
  const dirs = fs
    .readdirSync(componentsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const edges: TokenUsageEdge[] = [];
  const seen = new Set<string>();

  for (const componentName of dirs) {
    const files = walkFiles(path.join(componentsDir, componentName));
    for (const file of files) {
      let sf: ts.SourceFile;
      try {
        sf = parseFile(file);
      } catch {
        continue;
      }
      const rel = path.relative(repoRoot, file);

      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
          // Only resolve the outermost node of a chain; skip inner nodes to avoid
          // recording `border` and `border.radius` alongside `border.radius.max`.
          const parent = node.parent;
          const isInnerOfChain =
            parent &&
            (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
            parent.expression === node;

          if (!isInnerOfChain) {
            const tokenPath = resolveThemePath(node);
            if (tokenPath && tokenPath.split('.').length >= 2) {
              const key = `${componentName}|${tokenPath}`;
              if (!seen.has(key)) {
                seen.add(key);
                edges.push({
                  component: componentName,
                  tokenPath,
                  contextPath: 'theme-access',
                  file: rel,
                  line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
                  provenance: 'EXTRACTED',
                });
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }

  return edges;
}
