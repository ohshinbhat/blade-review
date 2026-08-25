/**
 * Component-structure tests.
 *
 * `engine.test.ts` protects the review machinery. This suite protects the
 * component-facing contract of Layer 1B: added JSX is summarized as one UI
 * subtree, reuse candidates come only from the extracted Blade graph, and an
 * approximate structural match remains advisory.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { loadGraph } from '../extract/index.js';
import { buildChangeModel } from '../checks/changeModel.js';
import { runDeterministicChecks } from '../checks/index.js';
import { findReusableUiStructures } from '../checks/structure.js';

const GRAPH = loadGraph(path.resolve('data/blade-graph.json'));

function diffFor(file: string, added: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,1 +1,${added.length} @@`,
    ...added.map((line) => `+${line}`),
  ].join('\n');
}

function modelFor(added: string[]) {
  const file = 'packages/blade/src/components/ActionTile/ActionTile.tsx';
  return buildChangeModel(
    {
      intent: 'Add an ActionTile UI for a title and payment action',
      diff: diffFor(file, added),
    },
    GRAPH,
  );
}

describe('component UI-structure reuse (Layer 1B)', () => {
  test('turns a raw UI subtree into one evidence-backed Blade composition', () => {
    const model = modelFor([
      '<section>',
      '  <h3>Payment total</h3>',
      '  <p>₹500</p>',
      '  <button>Pay now</button>',
      '</section>',
    ]);

    const candidates = findReusableUiStructures(model, GRAPH);
    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0].components, ['Box', 'Typography', 'Button']);
    assert.equal(candidates[0].coverage, 1);
    assert.deepEqual(
      candidates[0].mappings.map((mapping) => `${mapping.element}:${mapping.component}`),
      ['section:Box', 'h3:Typography', 'p:Typography', 'button:Button'],
    );
  });

  test('records unsupported elements instead of pretending the composition is complete', () => {
    const model = modelFor([
      '<section>',
      '  <h3>Spend</h3>',
      '  <canvas />',
      '  <button>Continue</button>',
      '</section>',
    ]);

    const [candidate] = findReusableUiStructures(model, GRAPH);
    assert.ok(candidate);
    assert.equal(candidate.coverage, 0.75);
    assert.deepEqual(candidate.unmappedIntrinsics, ['canvas']);
  });

  test('does not recommend rebuilding JSX that already uses Blade components', () => {
    const model = modelFor([
      '<Box>',
      '  <Typography>Payment total</Typography>',
      '  <Button>Pay now</Button>',
      '</Box>',
    ]);

    assert.deepEqual(findReusableUiStructures(model, GRAPH), []);
  });

  test('does not turn one raw wrapper into a noisy subtree recommendation', () => {
    const model = modelFor(['<div />']);
    assert.deepEqual(findReusableUiStructures(model, GRAPH), []);
  });

  test('surfaces COMP-003 as an advisory finding without an unsafe code rewrite', () => {
    const model = modelFor([
      '<article>',
      '  <h3>Payment total</h3>',
      '  <button>Pay now</button>',
      '</article>',
    ]);

    const findings = runDeterministicChecks(model, GRAPH).filter(
      (finding) => finding.ruleId === 'COMP-003',
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'warning');
    assert.match(findings[0].message, /Box, Typography, Button/);
    assert.ok(findings[0].evidence.some((line) => line.includes('3/3 intrinsic nodes')));
    assert.equal(findings[0].suggestion, undefined);
  });

  test('does not offer an opening-tag-only auto-fix for raw intrinsic replacements', () => {
    const model = modelFor([
      '<section>',
      '  <h3>Payment total</h3>',
      '</section>',
    ]);
    const findings = runDeterministicChecks(model, GRAPH).filter(
      (finding) => finding.ruleId === 'COMP-001',
    );
    assert.ok(findings.length >= 2);
    assert.ok(findings.every((finding) => finding.suggestion === undefined));
  });
});
