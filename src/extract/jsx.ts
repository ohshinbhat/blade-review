/**
 * JSX composition extraction — Layer 0, one node deeper than the token graph.
 *
 * The token/component extractors in this directory answer "what does Blade
 * declare?". This one answers "what did the diff actually build?" — the JSX
 * tree the change adds, read straight off the TS/TSX AST the same way every
 * other extractor in this package does. Nothing here is inferred from prose.
 *
 * Scope, stated plainly: this walks *added* lines from a unified diff, not a
 * full checkout. A diff hunk is not always a syntactically complete subtree —
 * editing one prop on an existing element, for instance, adds a single
 * attribute line with no enclosing tag. `extractJsxFromDiff` is best-effort by
 * design: it wraps a block of contiguously-added lines in a throwaway
 * fragment and parses that. When the block does not parse as valid TSX
 * (because it was never a self-contained subtree to begin with), it returns
 * no roots rather than a guess. A missed composition finding is an
 * availability gap; a fabricated one is a trust problem, and this package
 * consistently chooses the former.
 */
import * as ts from 'typescript';

export interface JsxProp {
  name: string;
  /** Statically resolvable literal, when the attribute's value is one. */
  literal?: string | number;
  /** True when the attribute's value is a JS expression (not a literal, not shorthand). */
  isExpression: boolean;
}

export interface JsxNode {
  /** Tag as written: `Box`, `div`, or `Card.Header` for a compound/slot component. */
  element: string;
  kind: 'blade' | 'intrinsic' | 'local' | 'unknown';
  props: JsxProp[];
  children: JsxNode[];
  file: string;
  line: number;
}

/** Loose input shape so callers don't need to import the diff-parsing module just for its type. */
export interface AddedLineSource {
  added: string[];
  addedLineNumbers: number[];
}

/**
 * Split a file's added lines into maximal runs of strictly consecutive line
 * numbers. Two added lines fifty lines apart in the same file are almost
 * certainly unrelated edits; concatenating them would let a closing tag from
 * one hunk pair with an opening tag from another and fabricate a tree that
 * was never in the diff. A contiguous run, by contrast, is exactly the shape
 * of "this block of markup was added."
 */
export function contiguousAddedBlocks(f: AddedLineSource): { text: string; startLine: number }[] {
  const blocks: { text: string; startLine: number }[] = [];
  let curLines: string[] = [];
  let curStart: number | undefined;
  let prevLine: number | undefined;

  const flush = (): void => {
    if (curLines.length) blocks.push({ text: curLines.join('\n'), startLine: curStart! });
    curLines = [];
    curStart = undefined;
  };

  for (let i = 0; i < f.added.length; i++) {
    const ln = f.addedLineNumbers[i];
    if (prevLine !== undefined && ln !== prevLine + 1) flush();
    if (curStart === undefined) curStart = ln;
    curLines.push(f.added[i]);
    prevLine = ln;
  }
  flush();
  return blocks;
}

/** Cheap pre-filter so we don't spin up the TS parser on blocks that plainly contain no JSX. */
function looksLikeJsx(text: string): boolean {
  return /<[A-Za-z]/.test(text);
}

/** Collect a string-literal / numeric-literal attribute value; expressions are recorded but not evaluated. */
function readAttrValue(a: ts.JsxAttribute, sf: ts.SourceFile): { literal?: string | number; isExpression: boolean } {
  const init = a.initializer;
  if (!init) return { isExpression: false }; // shorthand boolean, e.g. `isDisabled`
  if (ts.isStringLiteral(init)) return { literal: init.text, isExpression: false };
  if (ts.isJsxExpression(init) && init.expression) {
    if (ts.isNumericLiteral(init.expression)) return { literal: Number(init.expression.text), isExpression: false };
    if (ts.isStringLiteral(init.expression)) return { literal: init.expression.text, isExpression: false };
    return { isExpression: true };
  }
  return { isExpression: true };
}

function classify(element: string, bladeNames: Set<string>): JsxNode['kind'] {
  if (/^[a-z]/.test(element)) return 'intrinsic';
  const base = element.split('.')[0];
  if (bladeNames.has(base)) return 'blade';
  return /^[A-Z]/.test(element) ? 'local' : 'unknown';
}

/**
 * Parse one block of source text (already known to look like JSX) and return
 * its top-level JSX trees. `lineOffset` maps the parser's 1-indexed line
 * numbers (inside the synthetic wrapper) back to real file line numbers.
 */
function parseBlock(text: string, fileName: string, bladeNames: Set<string>, lineOffset: number): JsxNode[] {
  // Wrapped as a fragment so multiple top-level siblings in the block (a common
  // shape — a diff adding two adjacent rows, say) parse as one valid expression
  // instead of being rejected as multiple statements.
  const wrapped = `const __blade_review_root__ = (<>\n${text}\n</>);\n`;
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile(fileName, wrapped, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  } catch {
    return [];
  }

  const trueLine = (node: ts.Node): number => {
    const sfLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    return sfLine + lineOffset;
  };

  const toNode = (el: ts.JsxElement | ts.JsxSelfClosingElement): JsxNode => {
    const opening = ts.isJsxElement(el) ? el.openingElement : el;
    const element = opening.tagName.getText(sf).replace(/\s+/g, '');
    const props: JsxProp[] = [];
    for (const a of opening.attributes.properties) {
      if (!ts.isJsxAttribute(a) || !a.name) continue; // spread attributes carry no name we can check
      const name = a.name.getText(sf);
      const { literal, isExpression } = readAttrValue(a, sf);
      props.push({ name, literal, isExpression });
    }

    const children: JsxNode[] = [];
    if (ts.isJsxElement(el)) {
      for (const c of el.children) {
        if (ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c)) children.push(toNode(c));
      }
    }

    return { element, kind: classify(element, bladeNames), props, children, file: fileName, line: trueLine(opening) };
  };

  const roots: JsxNode[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      roots.push(toNode(n));
      return; // toNode already recurses into children — do not double-collect them as roots
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return roots;
}

/**
 * Extract the JSX tree(s) added by one file's diff hunks.
 *
 * `bladeNames` is the set of extracted Blade component directory names, used
 * to classify each tag as `blade` | `intrinsic` | `local` the same way
 * `detectComposition()` does today for the cascade graph, just with real tree
 * structure instead of a flat regex scan.
 */
export function extractJsxFromDiff(file: AddedLineSource & { path: string }, bladeNames: Set<string>): JsxNode[] {
  const roots: JsxNode[] = [];
  for (const block of contiguousAddedBlocks(file)) {
    if (!looksLikeJsx(block.text)) continue;
    // The wrapper prepends exactly one line (`const ... = (<>`) before the block's
    // own first line, which lands at wrapper-relative line 2.
    const lineOffset = block.startLine - 2;
    roots.push(...parseBlock(block.text, file.path, bladeNames, lineOffset));
  }
  return roots;
}

/** Pre-order flattening of a forest of JsxNode trees, each tagged with the file it came from. */
export function flattenJsx(byFile: { file: string; roots: JsxNode[] }[]): { file: string; node: JsxNode; parent?: JsxNode }[] {
  const out: { file: string; node: JsxNode; parent?: JsxNode }[] = [];
  const walk = (file: string, node: JsxNode, parent?: JsxNode): void => {
    out.push({ file, node, parent });
    for (const c of node.children) walk(file, c, node);
  };
  for (const { file, roots } of byFile) for (const r of roots) walk(file, r);
  return out;
}
