/**
 * Token extraction — Layer 0.
 *
 * Reads Blade's global and theme token modules and produces a flat, addressable
 * token index. Uses the TypeScript compiler API only: every token in the index
 * is read off the AST of a source file. Nothing is inferred, nothing is guessed.
 *
 * This is the deliberate difference from a generic code knowledge-graph tool:
 * we do not want `border.ts declares const border`. We want
 * `border.radius.medium = 12` so that a duplicate-value check is exact.
 */
import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';
import type { TokenNode, TokenCategory, TokenScope } from '../types.js';

/** Global token modules and the semantic category each one carries. */
const GLOBAL_TOKEN_MODULES: Record<string, TokenCategory> = {
  'border.ts': 'border',
  'spacing.ts': 'spacing',
  'size.ts': 'size',
  'typography.ts': 'typography',
  'motion.ts': 'motion',
  'opacity.ts': 'opacity',
  'blur.ts': 'blur',
  'breakpoints.ts': 'breakpoint',
  'colors.ts': 'color',
};

export function parseFile(filePath: string): ts.SourceFile {
  const text = fs.readFileSync(filePath, 'utf8');
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** Normalise an object-literal key to its written form (handles quoted keys like '2xsmall'). */
function keyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

/** Statically evaluate a literal initializer. Returns undefined for anything non-literal. */
function literalValue(node: ts.Expression): string | number | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const inner = literalValue(node.operand);
    return typeof inner === 'number' ? -inner : undefined;
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  if (node.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  return undefined;
}

/** Strip `as const` / `satisfies` / parens wrappers to reach the real expression. */
function unwrap(node: ts.Expression): ts.Expression {
  let cur = node;
  for (;;) {
    if (ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur)) cur = cur.expression;
    else if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    else if (ts.isTypeAssertionExpression?.(cur)) cur = (cur as ts.TypeAssertion).expression;
    else return cur;
  }
}

/**
 * Walk an object literal and emit one token per leaf.
 * Depth-capped so a pathological structure can't blow the stack.
 */
export function walkObjectLiteral(
  sf: ts.SourceFile,
  obj: ts.ObjectLiteralExpression,
  prefix: string[],
  emit: (leafPath: string[], value: string | number | undefined, node: ts.Node) => void,
  depth = 0,
): void {
  if (depth > 12) return;
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = keyName(prop.name);
    if (key === undefined) continue;
    const init = unwrap(prop.initializer);
    const next = [...prefix, key];

    if (ts.isObjectLiteralExpression(init)) {
      walkObjectLiteral(sf, init, next, emit, depth + 1);
    } else {
      emit(next, literalValue(init), prop);
    }
  }
}

/**
 * Find top-level `const <name> = { ... }` object literals.
 *
 * `exportedOnly` matters: global token modules export their tables, but
 * `bladeTheme.ts` declares `const colors = {...}` module-locally and only
 * `export default bladeTheme`. Both are token declarations.
 */
function findTopLevelObjects(
  sf: ts.SourceFile,
  opts: { exportedOnly: boolean; name?: string } = { exportedOnly: true },
): { id: string; obj: ts.ObjectLiteralExpression }[] {
  const out: { id: string; obj: ts.ObjectLiteralExpression }[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const isExported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (opts.exportedOnly && !isExported) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      if (opts.name && decl.name.text !== opts.name) continue;
      const init = unwrap(decl.initializer);
      if (ts.isObjectLiteralExpression(init)) out.push({ id: decl.name.text, obj: init });
    }
  }
  return out;
}

export function extractGlobalTokens(bladeSrc: string, repoRoot: string): TokenNode[] {
  const dir = path.join(bladeSrc, 'tokens', 'global');
  const tokens: TokenNode[] = [];

  for (const [fileName, category] of Object.entries(GLOBAL_TOKEN_MODULES)) {
    const filePath = path.join(dir, fileName);
    if (!fs.existsSync(filePath)) continue;
    const sf = parseFile(filePath);
    const rel = path.relative(repoRoot, filePath);

    for (const { id, obj } of findTopLevelObjects(sf, { exportedOnly: true })) {
      walkObjectLiteral(sf, obj, [id], (leafPath, value, node) => {
        tokens.push({
          path: leafPath.join('.'),
          scope: 'global',
          category,
          value,
          file: rel,
          line: lineOf(sf, node),
        });
      });
    }
  }
  return tokens;
}

/**
 * Theme tokens (`bladeTheme.ts`) are the semantic layer: `interactive.background.primary.default`.
 * Component token files reference these by dot-notation string, so the *paths* are what the
 * cascade graph needs. Values are recorded when they are literal, left undefined when the theme
 * references a global colour — we never fabricate a value we could not read.
 */
export function extractThemeTokens(bladeSrc: string, repoRoot: string): TokenNode[] {
  const filePath = path.join(bladeSrc, 'tokens', 'theme', 'bladeTheme.ts');
  if (!fs.existsSync(filePath)) return [];
  const sf = parseFile(filePath);
  const rel = path.relative(repoRoot, filePath);
  const tokens: TokenNode[] = [];
  const seen = new Set<string>();

  // Include non-exported declarations: `const colors = {...}` is module-local here.
  for (const { id, obj } of findTopLevelObjects(sf, { exportedOnly: false })) {
    walkObjectLiteral(sf, obj, [id], (leafPath, value, node) => {
      // Theme colours are keyed by colour-scheme mode (onLight / onDark). Component
      // token files reference the mode-independent semantic path, so collapse the mode
      // level and de-duplicate — otherwise every token would appear twice.
      const parts = leafPath.filter((p) => p !== 'onLight' && p !== 'onDark');
      const semantic = parts[0] === 'colors' ? parts.slice(1).join('.') : parts.join('.');
      if (!semantic || seen.has(semantic)) return;
      seen.add(semantic);
      tokens.push({
        path: semantic,
        scope: 'theme',
        category: parts[0] === 'colors' ? 'color' : 'unknown',
        value,
        file: rel,
        line: lineOf(sf, node),
      });
    });
  }
  return tokens;
}

/** Token path shape used across Blade component token files, e.g. `interactive.background.primary.default`. */
export const TOKEN_PATH_RE = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_$]+){1,5}$/;

export function isTokenPathLike(s: string): boolean {
  return TOKEN_PATH_RE.test(s);
}

export function makeTokenNode(
  p: string,
  scope: TokenScope,
  category: TokenCategory,
  file: string,
  line: number,
  owner?: string,
): TokenNode {
  return { path: p, scope, category, file, line, owner };
}
