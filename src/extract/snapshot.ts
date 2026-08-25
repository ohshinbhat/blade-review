/**
 * Jest snapshot diff parsing — the render-output half of Layer 0.
 *
 * A Blade change that affects what actually renders updates `.snap` files,
 * and those files already contain fully-resolved CSS (`padding: 4px`,
 * `background-color: hsla(206,10%,29%,0.06)`). That means render-output
 * review needs no renderer at all here: the rendered values are sitting in
 * the diff we already parse for everything else. This module turns the
 * *added* lines of a snapshot file's diff into structured declarations,
 * grouped by story where the diff shows us which story changed.
 *
 * Deliberately conservative: a snapshot hunk that only touches inner CSS
 * lines (the common case — most PRs do not add a whole new story) will not
 * carry an `exports[...]` header in its added lines, because that header line
 * did not change. Those declarations are still collected (for REND-001, which
 * does not need a story key), but grouped under an "unmatched" bucket that
 * REND-002's cross-platform comparison deliberately skips — comparing two
 * unmatched buckets across platforms would be comparing unrelated stories by
 * coincidence of diff order, which is exactly the kind of fabricated finding
 * this package avoids.
 */
export interface SnapshotDeclaration {
  property: string;
  rawValue: string;
  numeric?: number;
  unit?: string;
  line: number;
}

export interface SnapshotStoryBlock {
  /** The story/test name from `exports[\`<story>\`]`, when the diff includes that header line. */
  story: string;
  hasHeader: boolean;
  declarations: SnapshotDeclaration[];
  startLine: number;
}

export interface SnapshotDiffFile {
  file: string;
  component?: string;
  platform?: 'web' | 'native';
  stories: SnapshotStoryBlock[];
}

const WEB_SNAP_RE = /\.web\.test\.tsx?\.snap$/;
const NATIVE_SNAP_RE = /\.native\.test\.tsx?\.snap$/;
const HEADER_RE = /^exports\[`([^`]+)`\]\s*=\s*`?/;
const CSS_DECL_RE = /^\s*([a-zA-Z-]+)\s*:\s*([^;]+?);?\s*$/;
const NUM_RE = /^(-?\d+(?:\.\d+)?)(px|rem|em)$/;

/** Loose input shape, matching the one diff-parsing already produces. */
export interface SnapshotDiffInput {
  path: string;
  added: string[];
  addedLineNumbers: number[];
}

export function isSnapshotFile(path: string): boolean {
  return path.endsWith('.snap');
}

export function parseSnapshotDiff(f: SnapshotDiffInput): SnapshotDiffFile | undefined {
  if (!isSnapshotFile(f.path)) return undefined;
  const platform: SnapshotDiffFile['platform'] = WEB_SNAP_RE.test(f.path)
    ? 'web'
    : NATIVE_SNAP_RE.test(f.path)
      ? 'native'
      : undefined;
  const component = f.path.match(/components\/([A-Z][A-Za-z0-9]*)\//)?.[1];

  const stories: SnapshotStoryBlock[] = [];
  let current: SnapshotStoryBlock | undefined;

  for (let i = 0; i < f.added.length; i++) {
    const line = f.added[i];
    const lineNumber = f.addedLineNumbers[i];

    const header = line.match(HEADER_RE);
    if (header) {
      current = { story: header[1], hasHeader: true, declarations: [], startLine: lineNumber };
      stories.push(current);
      continue;
    }

    const decl = line.match(CSS_DECL_RE);
    if (!decl) continue;
    // Guard against false hits on non-CSS colon lines (e.g. JSON-ish serialized
    // props) by requiring a CSS-plausible property name.
    if (!/^-?[a-z][a-zA-Z-]*$/.test(decl[1])) continue;

    if (!current) {
      current = { story: '(unmatched)', hasHeader: false, declarations: [], startLine: lineNumber };
      stories.push(current);
    }
    const property = decl[1].trim();
    const rawValue = decl[2].trim();
    const num = rawValue.match(NUM_RE);
    current.declarations.push({
      property,
      rawValue,
      numeric: num ? Number(num[1]) : undefined,
      unit: num ? num[2] : undefined,
      line: lineNumber,
    });
  }

  return { file: f.path, component, platform, stories };
}
