/**
 * Unit tests for the parts that must not silently break.
 *
 * Run with: npm test   (node:test, no test-runner dependency)
 *
 * The eval suite measures whether the agent is *right*. These tests check that
 * the machinery around the judgment is *sound*: schema validation rejects
 * ungrounded output, the graph's cascade matching is exact, routing cannot be
 * talked past by a model, and a provider failure degrades safely.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { loadGraph } from '../extract/index.js';
import { review } from '../engine/review.js';
import { validateJudgment, extractJson, JudgmentValidationError } from '../engine/llm/provider.js';
import type { LlmProvider, ModelJudgment } from '../engine/llm/provider.js';
import { parseDiff, buildChangeModel } from '../checks/changeModel.js';
import { RULEBOOK } from '../knowledge/rulebook.js';
import { toGitHubReview } from '../ci/github.js';

const GRAPH = loadGraph(path.resolve('data/blade-graph.json'));
const RULE_IDS = new Set(RULEBOOK.map((r) => r.id));
const COMPONENTS = new Set(GRAPH.allComponentNames());

/** A provider that returns whatever we tell it to, so routing can be tested in isolation. */
function stubProvider(judgment: ModelJudgment): LlmProvider {
  return {
    name: 'stub',
    judge: async () => ({ judgment, raw: JSON.stringify(judgment) }),
  };
}

describe('rulebook integrity', () => {
  test('every rule has a source in the Blade repo', () => {
    for (const r of RULEBOOK) {
      assert.ok(r.source && r.source.length > 10, `${r.id} has no source`);
    }
  });

  test('rule ids are unique', () => {
    const ids = RULEBOOK.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('judgment validation', () => {
  test('rejects a cited rule that does not exist', () => {
    assert.throws(
      () =>
        validateJudgment(
          { status: 'incorrect', confidence: 0.9, summary: 's', reasoning: 'r', rulesCited: ['ENC-999'] },
          RULE_IDS,
          COMPONENTS,
        ),
      JudgmentValidationError,
    );
  });

  test('accepts a well-formed judgment', () => {
    const j = validateJudgment(
      { status: 'incorrect', confidence: 0.9, summary: 's', reasoning: 'r', rulesCited: ['ENC-001'] },
      RULE_IDS,
      COMPONENTS,
    );
    assert.equal(j.status, 'incorrect');
    assert.deepEqual(j.rulesCited, ['ENC-001']);
  });

  test('drops hallucinated components rather than trusting them', () => {
    const j = validateJudgment(
      {
        status: 'incorrect',
        confidence: 0.5,
        summary: 's',
        reasoning: 'r',
        rulesCited: [],
        affectedComponents: ['Button', 'TotallyMadeUpComponent'],
      },
      RULE_IDS,
      COMPONENTS,
    );
    assert.deepEqual(j.affectedComponents, ['Button']);
  });

  test('extracts JSON from a fenced response', () => {
    const parsed = extractJson('Sure!\n```json\n{"status":"correct"}\n```\n') as { status: string };
    assert.equal(parsed.status, 'correct');
  });

  test('clamps confidence into range', () => {
    const j = validateJudgment(
      { status: 'correct', confidence: 4.2, summary: 's', reasoning: 'r', rulesCited: [] },
      RULE_IDS,
      COMPONENTS,
    );
    assert.equal(j.confidence, 1);
  });
});

describe('diff parsing', () => {
  test('separates added and removed lines per file', () => {
    const files = parseDiff(
      [
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1 +1 @@',
        '-  medium: 12,',
        '+  medium: 8,',
      ].join('\n'),
    );
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'a.ts');
    assert.deepEqual(files[0].added, ['  medium: 8,']);
    assert.deepEqual(files[0].removed, ['  medium: 12,']);
  });
});

describe('knowledge graph', () => {
  test('extracted the real Blade token scale', () => {
    assert.equal(GRAPH.token('border.radius.medium')?.value, 12);
    assert.equal(GRAPH.token('spacing.5')?.value, 16);
  });

  test('extracted Button real variant axis', () => {
    const variant = GRAPH.variantAxes('Button').find((a) => a.prop === 'variant');
    assert.ok(variant, 'Button should expose a variant axis');
    assert.deepEqual(variant!.values.sort(), ['primary', 'secondary', 'tertiary']);
  });

  test('cascade covers both Button and Card for a shared radius token', () => {
    const impact = GRAPH.cascade('border.radius.medium');
    assert.ok(impact.affectedComponents.includes('Button'));
    assert.ok(impact.affectedComponents.includes('Card'));
    assert.ok(impact.affectedComponents.length > 10);
  });

  test('cascade is a pure function of the graph — repeated calls are identical', () => {
    const a = GRAPH.cascade('border.radius.medium').affectedComponents;
    const b = GRAPH.cascade('border.radius.medium').affectedComponents;
    assert.deepEqual(a, b);
  });

  test('an unknown token cascades to nothing rather than guessing', () => {
    assert.deepEqual(GRAPH.cascade('does.not.exist.anywhere').affectedComponents, []);
  });
});

describe('change model', () => {
  test('resolves the longest component name, not a substring', () => {
    const m = buildChangeModel({ intent: 'Add a new size to ButtonGroup' }, GRAPH);
    assert.ok(m.targetComponents.includes('ButtonGroup'));
    assert.ok(!m.targetComponents.includes('Button'));
  });

  test('does not treat a negation as an additive intent', () => {
    const m = buildChangeModel(
      { intent: 'Extend Chip token file. No new tokens, no new props.' },
      GRAPH,
    );
    assert.equal(m.graphProvenPropHits.length, 0);
  });

  test('does not flag a prop merely mentioned in passing', () => {
    const m = buildChangeModel(
      { intent: 'Add a `density` prop to Card to control internal padding.' },
      GRAPH,
    );
    assert.ok(!m.graphProvenPropHits.some((h) => h.prop === 'padding'));
  });
});

describe('verdict routing', () => {
  test('a proven blocker cannot be approved away by the model', async () => {
    const v = await review(
      {
        intent: 'change the shared radius',
        diff: [
          'diff --git a/packages/blade/src/tokens/global/border.ts b/packages/blade/src/tokens/global/border.ts',
          '--- a/packages/blade/src/tokens/global/border.ts',
          '+++ b/packages/blade/src/tokens/global/border.ts',
          '@@ -1 +1 @@',
          '+    medium: 8,',
        ].join('\n'),
      },
      GRAPH,
      {
        provider: stubProvider({
          status: 'correct',
          confidence: 0.99,
          summary: 'looks fine to me',
          reasoning: 'no issues',
          rulesCited: [],
          affectedComponents: [],
        }),
      },
    );
    assert.equal(v.status, 'incorrect', 'model approval must not override a proven blocker');
    assert.equal(v.decidedBy, 'routing');
  });

  test('a low-confidence approval is downgraded to needs_human, never approved', async () => {
    const v = await review({ intent: 'some ambiguous change to Card' }, GRAPH, {
      confidenceThreshold: 0.75,
      provider: stubProvider({
        status: 'correct',
        confidence: 0.4,
        summary: 'probably ok',
        reasoning: 'not sure',
        rulesCited: [],
        affectedComponents: [],
      }),
    });
    assert.equal(v.status, 'needs_human');
  });

  test('a high-confidence approval on a clean change is allowed through', async () => {
    const v = await review({ intent: 'some clean change to Card' }, GRAPH, {
      provider: stubProvider({
        status: 'correct',
        confidence: 0.95,
        summary: 'correctly encoded',
        reasoning: 'uses existing tokens',
        rulesCited: [],
        affectedComponents: [],
      }),
    });
    assert.equal(v.status, 'correct');
  });

  test('a provider failure degrades to needs_human and never to correct', async () => {
    const v = await review({ intent: 'some change to Card' }, GRAPH, {
      provider: {
        name: 'exploding',
        judge: async () => {
          throw new Error('upstream 500');
        },
      },
    });
    assert.equal(v.status, 'needs_human');
    assert.match(v.reasoning, /upstream 500/);
  });
});

describe('github adapter', () => {
  test('needs_human is neutral, not a failed build', async () => {
    const v = await review({ intent: 'ambiguous change to Card' }, GRAPH, {
      provider: stubProvider({
        status: 'needs_human',
        confidence: 0.4,
        summary: 'unclear',
        reasoning: 'needs a human',
        rulesCited: [],
        affectedComponents: [],
      }),
    });
    const gh = toGitHubReview(v);
    assert.equal(gh.conclusion, 'neutral');
    assert.equal(gh.event, 'COMMENT');
    assert.ok(gh.requestReviewers.length > 0, 'a deferral should request the DS team');
  });

  test('a blocking verdict requests changes and carries a suggestion block', async () => {
    const v = await review(
      {
        intent: 'inline the colour',
        diff: [
          'diff --git a/packages/blade/src/components/Card/StyledCard.web.tsx b/packages/blade/src/components/Card/StyledCard.web.tsx',
          '--- a/packages/blade/src/components/Card/StyledCard.web.tsx',
          '+++ b/packages/blade/src/components/Card/StyledCard.web.tsx',
          '@@ -1 +1 @@',
          '+  padding: 16px;',
        ].join('\n'),
      },
      GRAPH,
      { deterministicOnly: true },
    );
    assert.equal(v.status, 'incorrect');
    const gh = toGitHubReview(v);
    assert.equal(gh.event, 'REQUEST_CHANGES');
    assert.equal(gh.conclusion, 'failure');
    assert.ok(gh.comments.some((c) => c.body.includes('```suggestion')));
  });
});
