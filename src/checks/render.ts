/**
 * Layer 1 — render-output checks.
 *
 * Composition checks (`composition.ts`) look at the JSX the diff writes.
 * These look at what that JSX *becomes*: the fully-resolved CSS already
 * sitting in the `.snap` files the diff touches. No renderer, no Storybook —
 * the PR already contains the rendered output, so this is a diff-parsing
 * problem, not a rendering problem. See `extract/snapshot.ts`.
 *
 * Two things this can catch that source analysis structurally cannot:
 *   REND-001 — a computed value that is off the token scale even though no
 *              literal was ever typed by hand (it emerged from arithmetic, a
 *              wrong theme lookup, or a bad prop default).
 *   REND-002 — a resolved value that differs between the web and native
 *              snapshot of the same story, i.e. the two platforms no longer
 *              render the same thing, even though both edits look correct in
 *              isolation.
 */
import type { Finding } from '../types.js';
import type { BladeGraph } from '../extract/graph.js';
import type { ChangeModel } from './changeModel.js';
import type { SnapshotDiffFile } from '../extract/snapshot.js';
import { rule } from '../knowledge/rulebook.js';

type Check = (m: ChangeModel, g: BladeGraph, prior: BladeGraph) => Finding[];

function sev(m: ChangeModel, desired: 'blocker' | 'warning'): 'blocker' | 'warning' {
  return m.signalSource === 'prose' && desired === 'blocker' ? 'warning' : desired;
}

// ---------------------------------------------------------------------------
// REND-001 — computed-value conformance
// ---------------------------------------------------------------------------
/** Layout-affecting properties worth scale-checking. Colour/typography values in a snapshot are usually already-resolved theme output (hsla/rgba) that will not literal-match a hex token, so this stays scoped to the numeric px surface, which is exact either way. */
const REND_NUMERIC_PROPERTIES = new Set([
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'border-radius', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius',
  'gap', 'row-gap', 'column-gap',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
]);

const checkSnapshotTokenConformance: Check = (m, g) => {
  const findings: Finding[] = [];
  const r = rule('REND-001');
  const seen = new Set<string>();

  for (const snap of m.snapshotDiffs) {
    for (const story of snap.stories) {
      for (const decl of story.declarations) {
        if (decl.numeric === undefined || decl.unit !== 'px') continue;
        if (!REND_NUMERIC_PROPERTIES.has(decl.property)) continue;
        if (decl.numeric === 0) continue;
        const matches = g.tokensWithValue(decl.numeric);
        if (matches.length) continue; // on-scale — nothing to report

        const key = `${snap.file}:${decl.line}:${decl.property}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const nearby = [...new Set(
          g.graph.tokens
            .filter((t) => t.scope === 'global' && typeof t.value === 'number')
            .map((t) => t.value as number),
        )]
          .sort((a, b) => Math.abs(a - decl.numeric!) - Math.abs(b - decl.numeric!))
          .slice(0, 3);

        findings.push({
          ruleId: r.id,
          category: r.category,
          severity: sev(m, 'blocker'),
          message: `The rendered \`${decl.property}: ${decl.rawValue}\` in ${snap.component ?? 'this component'}'s ${snap.platform ?? ''} snapshot is not on the token scale.`,
          evidence: [
            `${snap.file}:${decl.line}${story.hasHeader ? ` (${story.story})` : ''}`,
            `No token holds the value ${decl.numeric}. Nearest scale values: ${nearby.join(', ') || 'none extracted'}.`,
            'Read from the diffed snapshot’s computed CSS, not from source — this catches a value that emerged from arithmetic or a wrong theme lookup, not just a literal typed by hand.',
            r.source,
          ],
          provenance: 'DETERMINISTIC',
        });
      }
    }
  }
  return findings;
};

// ---------------------------------------------------------------------------
// REND-002 — cross-platform render divergence
// ---------------------------------------------------------------------------
/** Properties expected to resolve identically across platforms. Deliberately excludes things that legitimately diverge by platform (box-shadow/elevation, font-family, cursor, outline). */
const REND002_PROPERTIES = new Set([
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'border-radius', 'gap', 'row-gap', 'column-gap', 'width', 'height', 'font-size',
]);

const checkCrossPlatformSnapshotDivergence: Check = (m) => {
  const findings: Finding[] = [];
  const r = rule('REND-002');

  const byComponent = new Map<string, { web: SnapshotDiffFile[]; native: SnapshotDiffFile[] }>();
  for (const s of m.snapshotDiffs) {
    if (!s.component || !s.platform) continue;
    const entry = byComponent.get(s.component) ?? { web: [], native: [] };
    entry[s.platform].push(s);
    byComponent.set(s.component, entry);
  }

  const seen = new Set<string>();
  for (const [component, { web, native }] of byComponent) {
    // Both platforms' snapshots must be part of THIS diff to compare — a
    // one-sided snapshot update with nothing to diff against is CAS-004's
    // territory (component source changed on one platform only), not this
    // check's: there is no second value here to call a divergence from.
    if (!web.length || !native.length) continue;

    for (const webFile of web) {
      for (const webStory of webFile.stories) {
        if (!webStory.hasHeader) continue; // only compare stories the diff itself names on both sides
        for (const nativeFile of native) {
          const nativeStory = nativeFile.stories.find((s) => s.hasHeader && s.story === webStory.story);
          if (!nativeStory) continue;

          const webProps = new Map(webStory.declarations.filter((d) => REND002_PROPERTIES.has(d.property)).map((d) => [d.property, d]));
          const nativeProps = new Map(nativeStory.declarations.filter((d) => REND002_PROPERTIES.has(d.property)).map((d) => [d.property, d]));

          for (const [prop, decl] of webProps) {
            const other = nativeProps.get(prop);
            if (!other) continue; // presence-only divergence is common (native often expresses layout differently) — not reported, to keep this exact rather than noisy
            if (decl.numeric === undefined || other.numeric === undefined) continue;
            if (decl.numeric === other.numeric) continue;

            const key = `${component}:${webStory.story}:${prop}`;
            if (seen.has(key)) continue;
            seen.add(key);
            findings.push({
              ruleId: r.id,
              category: r.category,
              severity: sev(m, 'blocker'),
              message: `${component} renders \`${prop}\` differently on web (${decl.rawValue}) and native (${other.rawValue}) for the same story ("${webStory.story}").`,
              evidence: [
                `web: ${webFile.file}:${decl.line}`,
                `native: ${nativeFile.file}:${other.line}`,
                'Both paired snapshots changed in this diff for the same story; a resolved value should match unless the divergence is intentional.',
                r.source,
              ],
              provenance: 'DETERMINISTIC',
            });
          }
        }
      }
    }
  }
  return findings;
};

export const RENDER_CHECKS: Check[] = [checkSnapshotTokenConformance, checkCrossPlatformSnapshotDivergence];
