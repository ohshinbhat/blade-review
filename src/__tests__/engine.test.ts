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
import { BladeGraph } from '../extract/graph.js';
import { createProvider, review } from '../engine/review.js';
import { OpenAICompatibleProvider } from '../engine/llm/openaiCompatible.js';
import { validateJudgment, extractJson, JudgmentValidationError } from '../engine/llm/provider.js';
import type { LlmProvider, ModelJudgment } from '../engine/llm/provider.js';
import { parseDiff, buildChangeModel } from '../checks/changeModel.js';
import { runDeterministicChecks } from '../checks/index.js';
import { buildContext } from '../knowledge/retrieval.js';
import { RULEBOOK } from '../knowledge/rulebook.js';
import { toGitHubReview } from '../ci/github.js';
import { extractJsxFromDiff, contiguousAddedBlocks } from '../extract/jsx.js';
import { parseSnapshotDiff } from '../extract/snapshot.js';
import { SYSTEM_PROMPT } from '../engine/prompt.js';

const GRAPH = loadGraph(path.resolve('data/blade-graph.json'));
const RULE_IDS = new Set(RULEBOOK.map((r) => r.id));
const COMPONENTS = new Set(GRAPH.allComponentNames());

test('review prompt excludes content and valid enum strings from token rules', () => {
  assert.match(SYSTEM_PROMPT, /user-facing text/);
  assert.match(SYSTEM_PROMPT, /valid string-union prop values/);
  assert.match(SYSTEM_PROMPT, /content-only change.*architecturally correct/);
});

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

describe('provider compatibility', () => {
  test('parses an OpenRouter chat completion', async () => {
    const expected: ModelJudgment = {
      status: 'correct',
      confidence: 0.9,
      summary: 'looks good',
      reasoning: 'uses existing tokens',
      rulesCited: [],
      affectedComponents: ['Button'],
    };
    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      model: 'test/model',
      baseUrl: 'https://openrouter.ai/api/v1',
      providerName: 'openrouter',
      knownRuleIds: RULE_IDS,
      knownComponents: COMPONENTS,
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(expected) } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    const result = await provider.judge('system', 'user');
    assert.equal(result.judgment.status, expected.status);
    assert.equal(result.judgment.confidence, expected.confidence);
    assert.equal(result.judgment.summary, expected.summary);
    assert.deepEqual(result.judgment.affectedComponents, expected.affectedComponents);
    assert.equal(provider.name, 'openrouter:test/model');
  });

  test('auto-selects OpenRouter when it is the only configured API key', () => {
    const previous = {
      anthropic: process.env.ANTHROPIC_API_KEY,
      openrouter: process.env.OPENROUTER_API_KEY,
      provider: process.env.BLADE_REVIEW_PROVIDER,
      model: process.env.BLADE_REVIEW_MODEL,
    };
    try {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.BLADE_REVIEW_PROVIDER;
      process.env.OPENROUTER_API_KEY = 'test-key';
      process.env.BLADE_REVIEW_MODEL = 'test/model';
      const provider = createProvider(GRAPH, {});
      assert.equal(provider.name, 'openrouter:test/model');
    } finally {
      restoreEnv('ANTHROPIC_API_KEY', previous.anthropic);
      restoreEnv('OPENROUTER_API_KEY', previous.openrouter);
      restoreEnv('BLADE_REVIEW_PROVIDER', previous.provider);
      restoreEnv('BLADE_REVIEW_MODEL', previous.model);
    }
  });

  test('uses provider defaults when unset Actions variables arrive as empty strings', () => {
    const previous = {
      anthropic: process.env.ANTHROPIC_API_KEY,
      openrouter: process.env.OPENROUTER_API_KEY,
      provider: process.env.BLADE_REVIEW_PROVIDER,
      model: process.env.BLADE_REVIEW_MODEL,
      baseUrl: process.env.BLADE_REVIEW_BASE_URL,
    };
    try {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.OPENROUTER_API_KEY = 'test-key';
      process.env.BLADE_REVIEW_PROVIDER = '';
      process.env.BLADE_REVIEW_MODEL = '';
      process.env.BLADE_REVIEW_BASE_URL = '';
      const provider = createProvider(GRAPH, {});
      assert.equal(provider.name, 'openrouter:openai/gpt-4o-mini');
    } finally {
      restoreEnv('ANTHROPIC_API_KEY', previous.anthropic);
      restoreEnv('OPENROUTER_API_KEY', previous.openrouter);
      restoreEnv('BLADE_REVIEW_PROVIDER', previous.provider);
      restoreEnv('BLADE_REVIEW_MODEL', previous.model);
      restoreEnv('BLADE_REVIEW_BASE_URL', previous.baseUrl);
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

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
    assert.deepEqual(files[0].addedLineNumbers, [1]);
    assert.deepEqual(files[0].removed, ['  medium: 12,']);
  });

  test('extracts only newly-added union members from a changed prop', () => {
    const m = buildChangeModel(
      {
        intent: 'Add quaternary variant to Button',
        diff: [
          'diff --git a/packages/blade/src/components/Button/types.ts b/packages/blade/src/components/Button/types.ts',
          '--- a/packages/blade/src/components/Button/types.ts',
          '+++ b/packages/blade/src/components/Button/types.ts',
          '@@ -10 +10 @@',
          "-  variant?: 'primary' | 'secondary' | 'tertiary';",
          "+  variant?: 'primary' | 'secondary' | 'tertiary' | 'quaternary';",
        ].join('\n'),
      },
      GRAPH,
    );
    assert.deepEqual(m.proposedVariantValues, ['quaternary']);
    assert.ok(!m.proposedProps.includes('variant'));
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

describe('base/head graph separation', () => {
  test('does not treat a variant added by the PR as pre-existing', async () => {
    const headData = structuredClone(GRAPH.graph);
    const variant = headData.components
      .find((c) => c.name === 'Button')!
      .props.find((p) => p.name === 'variant')!;
    variant.allowedValues.push('quaternary');
    const head = new BladeGraph(headData);
    const diff = [
      'diff --git a/packages/blade/src/components/Button/types.ts b/packages/blade/src/components/Button/types.ts',
      '--- a/packages/blade/src/components/Button/types.ts',
      '+++ b/packages/blade/src/components/Button/types.ts',
      '@@ -10 +10 @@',
      "-  variant?: 'primary' | 'secondary' | 'tertiary';",
      "+  variant?: 'primary' | 'secondary' | 'tertiary' | 'quaternary';",
    ].join('\n');
    const verdict = await review({ intent: 'Add quaternary variant to Button', diff }, head, {
      priorGraph: GRAPH,
      deterministicOnly: true,
    });
    assert.ok(!verdict.findings.some((f) => f.ruleId === 'REUSE-003'));
  });
});

describe('cross-platform parity', () => {
  test('unrelated web and native changes cannot cancel each other out', () => {
    const diff = [
      'diff --git a/packages/blade/src/components/Checkbox/A.web.tsx b/packages/blade/src/components/Checkbox/A.web.tsx',
      '--- a/packages/blade/src/components/Checkbox/A.web.tsx',
      '+++ b/packages/blade/src/components/Checkbox/A.web.tsx',
      '@@ -1 +1 @@',
      '+change',
      'diff --git a/packages/blade/src/components/Radio/A.native.tsx b/packages/blade/src/components/Radio/A.native.tsx',
      '--- a/packages/blade/src/components/Radio/A.native.tsx',
      '+++ b/packages/blade/src/components/Radio/A.native.tsx',
      '@@ -1 +1 @@',
      '+change',
    ].join('\n');
    const model = buildChangeModel({ intent: 'Adjust Checkbox web and Radio native', diff }, GRAPH);
    const parity = runDeterministicChecks(model, GRAPH).filter((f) => f.ruleId === 'CAS-004');
    assert.equal(parity.length, 2);
    assert.ok(parity.some((f) => f.message.includes('Checkbox')));
    assert.ok(parity.some((f) => f.message.includes('Radio')));
  });
});

describe('new-component reuse grounding', () => {
  test('retrieves similar existing prop surfaces for a proposed component', () => {
    const headData = structuredClone(GRAPH.graph);
    const button = headData.components.find((c) => c.name === 'Button')!;
    headData.components.push({ ...structuredClone(button), name: 'PaymentButton', dir: 'packages/blade/src/components/PaymentButton' });
    const head = new BladeGraph(headData);
    const diff = [
      'diff --git a/packages/blade/src/components/PaymentButton/PaymentButton.tsx b/packages/blade/src/components/PaymentButton/PaymentButton.tsx',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/packages/blade/src/components/PaymentButton/PaymentButton.tsx',
      '@@ -0,0 +1 @@',
      '+export const PaymentButton = () => null;',
    ].join('\n');
    const model = buildChangeModel({ intent: 'Create a new PaymentButton component', diff }, head);
    const context = buildContext(model, head, [], GRAPH);
    assert.equal(context.proposedNewComponent, true);
    assert.equal(context.similarComponents[0]?.candidate, 'Button');
    assert.equal(context.similarComponents[0]?.score, 1);
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

  test('repository-local samples can disable reviewer assignment without changing neutrality', async () => {
    const v = await review({ intent: 'ambiguous sample UI' }, GRAPH, {
      provider: stubProvider({
        status: 'needs_human',
        confidence: 0.4,
        summary: 'unclear',
        reasoning: 'needs a human',
        rulesCited: [],
        affectedComponents: [],
      }),
    });
    const gh = toGitHubReview(v, 'razorpay/design-system', false);
    assert.equal(gh.conclusion, 'neutral');
    assert.deepEqual(gh.requestReviewers, []);
    assert.match(gh.body, /Automatic reviewer assignment is disabled/);
    assert.equal(gh.checkTitle, 'Human architecture review required');
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
    const comment = gh.comments.find((c) => c.body.includes('```suggestion'));
    assert.ok(comment);
    assert.equal(comment!.line, 1);
    assert.equal(comment!.side, 'RIGHT');
    assert.match(comment!.body, /\n  padding: 'spacing\.5';\n/);
  });
});

describe('jsx composition extraction', () => {
  test('splits added lines into contiguous runs, not the whole file', () => {
    const blocks = contiguousAddedBlocks({ added: ['a', 'b', 'c'], addedLineNumbers: [10, 11, 50] });
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks[0], { text: 'a\nb', startLine: 10 });
    assert.deepEqual(blocks[1], { text: 'c', startLine: 50 });
  });

  test('extracts a real tree with correct line numbers and classification', () => {
    const roots = extractJsxFromDiff(
      {
        path: 'packages/blade/src/components/Card/Preview.tsx',
        added: ['<Box>', '  <div>Total</div>', '</Box>'],
        addedLineNumbers: [10, 11, 12],
      },
      new Set(['Box', 'Typography']),
    );
    assert.equal(roots.length, 1);
    assert.equal(roots[0].element, 'Box');
    assert.equal(roots[0].kind, 'blade');
    assert.equal(roots[0].line, 10);
    assert.equal(roots[0].children.length, 1);
    assert.equal(roots[0].children[0].element, 'div');
    assert.equal(roots[0].children[0].kind, 'intrinsic');
    assert.equal(roots[0].children[0].line, 11);
  });

  test('a non-contiguous single attribute line does not fabricate a tree', () => {
    // A one-line, non-JSX-looking edit (a prop tweak inside an existing tag) —
    // extraction should find nothing rather than guess a structure.
    const roots = extractJsxFromDiff(
      { path: 'packages/blade/src/components/Card/Card.tsx', added: ['  isDisabled', '  size="large"'], addedLineNumbers: [5, 6] },
      new Set(['Card']),
    );
    assert.equal(roots.length, 0);
  });

  test('records a spread attribute without crashing and without a false prop match', () => {
    const roots = extractJsxFromDiff(
      {
        path: 'packages/blade/src/components/Card/Preview.tsx',
        added: ['<Box {...rest} padding="spacing.4" />'],
        addedLineNumbers: [1],
      },
      new Set(['Box']),
    );
    assert.equal(roots.length, 1);
    assert.deepEqual(roots[0].props.map((p) => p.name), ['padding']);
  });
});

describe('composition checks (COMP-*)', () => {
  function diffFor(file: string, added: string[]): string {
    return [
      `diff --git a/${file} b/${file}`,
      `--- a/${file}`,
      `+++ b/${file}`,
      '@@ -1,1 +1,' + (added.length + 1) + ' @@',
      ...added.map((a) => `+${a}`),
    ].join('\n');
  }

  test('COMP-001 flags a raw intrinsic where Box/Typography exist', () => {
    const diff = diffFor('packages/blade/src/components/Card/Preview.tsx', ['<div>', '  <span>Total</span>', '</div>']);
    const model = buildChangeModel({ intent: 'add a total row', diff }, GRAPH);
    const findings = runDeterministicChecks(model, GRAPH).filter((f) => f.ruleId === 'COMP-001');
    assert.ok(findings.length >= 1);
    assert.equal(findings[0].severity, 'warning');
  });

  test('COMP-001 does not flag Box/Typography themselves', () => {
    const diff = diffFor('packages/blade/src/components/Card/Preview.tsx', [
      '<Box padding="spacing.4">',
      '  <Typography>Total</Typography>',
      '</Box>',
    ]);
    const model = buildChangeModel({ intent: 'add a total row', diff }, GRAPH);
    const findings = runDeterministicChecks(model, GRAPH).filter((f) => f.ruleId === 'COMP-001');
    assert.equal(findings.length, 0);
  });

  test('COMP-002 flags an inline style prop and treats it as a blocker', () => {
    const diff = diffFor('packages/blade/src/components/Card/Preview.tsx', ['<Box style={{ padding: 4 }} />']);
    const model = buildChangeModel({ intent: 'nudge spacing', diff }, GRAPH);
    const findings = runDeterministicChecks(model, GRAPH).filter((f) => f.ruleId === 'COMP-002');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'blocker');
  });

  test('COMP-004 flags an interactive element nested inside another', () => {
    const diff = diffFor('packages/blade/src/components/Button/Preview.tsx', [
      '<Button variant="tertiary">',
      '  <Link href="/help">Help</Link>',
      '</Button>',
    ]);
    const model = buildChangeModel({ intent: 'add a help link', diff }, GRAPH);
    const findings = runDeterministicChecks(model, GRAPH).filter((f) => f.ruleId === 'COMP-004');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'blocker');
  });

  test('COMP-004 does not flag an interactive element used on its own', () => {
    const diff = diffFor('packages/blade/src/components/Button/Preview.tsx', ['<Button variant="tertiary">Pay</Button>']);
    const model = buildChangeModel({ intent: 'add a button', diff }, GRAPH);
    const findings = runDeterministicChecks(model, GRAPH).filter((f) => f.ruleId === 'COMP-004');
    assert.equal(findings.length, 0);
  });

  test('COMP-005 flags a variant literal never added to the declared union', () => {
    const diff = diffFor('packages/blade/src/components/Button/Preview.tsx', ['<Button variant="quaternary">Pay</Button>']);
    const model = buildChangeModel({ intent: 'use the new button style', diff }, GRAPH);
    const findings = runDeterministicChecks(model, GRAPH).filter((f) => f.ruleId === 'COMP-005');
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /quaternary/);
  });

  test('COMP-005 does not flag a real member of the declared union', () => {
    const diff = diffFor('packages/blade/src/components/Button/Preview.tsx', ['<Button variant="tertiary">Pay</Button>']);
    const model = buildChangeModel({ intent: 'use the tertiary button style', diff }, GRAPH);
    const findings = runDeterministicChecks(model, GRAPH).filter((f) => f.ruleId === 'COMP-005');
    assert.equal(findings.length, 0);
  });

  test("COMP-005 does not use a sibling slot component's props (Card.Header is not Card)", () => {
    const diff = diffFor('packages/blade/src/components/Card/Preview.tsx', ['<Card.Header title="x" />']);
    const model = buildChangeModel({ intent: 'add a card header', diff }, GRAPH);
    const findings = runDeterministicChecks(model, GRAPH).filter((f) => f.ruleId === 'COMP-005');
    assert.equal(findings.length, 0);
  });
});

describe('snapshot diff parsing and render checks (REND-*)', () => {
  test('parses a story header and its declarations from added lines only', () => {
    const parsed = parseSnapshotDiff({
      path: 'packages/blade/src/components/Card/__tests__/__snapshots__/Card.web.test.tsx.snap',
      added: ['exports[`Card renders correctly 1`] = `', '  padding: 16px;', '  color: #0a8000;', '`;'],
      addedLineNumbers: [1, 2, 3, 4],
    });
    assert.ok(parsed);
    assert.equal(parsed!.platform, 'web');
    assert.equal(parsed!.component, 'Card');
    assert.equal(parsed!.stories.length, 1);
    assert.equal(parsed!.stories[0].story, 'Card renders correctly 1');
    assert.equal(parsed!.stories[0].declarations.length, 2);
    assert.deepEqual(parsed!.stories[0].declarations[0], { property: 'padding', rawValue: '16px', numeric: 16, unit: 'px', line: 2 });
  });

  test('REND-001 flags a resolved px value that matches no token', () => {
    const file = 'packages/blade/src/components/Card/__tests__/__snapshots__/Card.web.test.tsx.snap';
    const diff = [
      `diff --git a/${file} b/${file}`,
      `--- a/${file}`,
      `+++ b/${file}`,
      '@@ -1,1 +1,4 @@',
      '+exports[`Card renders correctly 1`] = `',
      '+  padding: 9px;', // 9 is off Blade's real spacing/size scale; 15 collides with size.15
      '+`;',
    ].join('\n');
    const model = buildChangeModel({ intent: 'tighten the padding', diff }, GRAPH);
    const findings = runDeterministicChecks(model, GRAPH).filter((f) => f.ruleId === 'REND-001');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].severity, 'blocker');
  });

  test('REND-001 does not flag a value already on the token scale', () => {
    const file = 'packages/blade/src/components/Card/__tests__/__snapshots__/Card.web.test.tsx.snap';
    const diff = [
      `diff --git a/${file} b/${file}`,
      `--- a/${file}`,
      `+++ b/${file}`,
      '@@ -1,1 +1,4 @@',
      '+exports[`Card renders correctly 1`] = `',
      '+  padding: 16px;',
      '+`;',
    ].join('\n');
    const model = buildChangeModel({ intent: 'tighten the padding', diff }, GRAPH);
    const findings = runDeterministicChecks(model, GRAPH).filter((f) => f.ruleId === 'REND-001');
    assert.equal(findings.length, 0);
  });

  test('REND-002 flags web/native resolving the same story to different values', () => {
    const web = 'packages/blade/src/components/Card/__tests__/__snapshots__/Card.web.test.tsx.snap';
    const native = 'packages/blade/src/components/Card/__tests__/__snapshots__/Card.native.test.tsx.snap';
    const diff = [
      `diff --git a/${web} b/${web}`,
      `--- a/${web}`,
      `+++ b/${web}`,
      '@@ -1,1 +1,4 @@',
      '+exports[`Card renders correctly 1`] = `',
      '+  padding: 8px;',
      '+`;',
      `diff --git a/${native} b/${native}`,
      `--- a/${native}`,
      `+++ b/${native}`,
      '@@ -1,1 +1,4 @@',
      '+exports[`Card renders correctly 1`] = `',
      '+  padding: 12px;',
      '+`;',
    ].join('\n');
    const model = buildChangeModel({ intent: 'update padding on both platforms', diff }, GRAPH);
    const findings = runDeterministicChecks(model, GRAPH).filter((f) => f.ruleId === 'REND-002');
    assert.equal(findings.length, 1);
    assert.match(findings[0].message, /8px/);
    assert.match(findings[0].message, /12px/);
  });

  test('REND-002 does not flag matching web/native values', () => {
    const web = 'packages/blade/src/components/Card/__tests__/__snapshots__/Card.web.test.tsx.snap';
    const native = 'packages/blade/src/components/Card/__tests__/__snapshots__/Card.native.test.tsx.snap';
    const diff = [
      `diff --git a/${web} b/${web}`,
      `--- a/${web}`,
      `+++ b/${web}`,
      '@@ -1,1 +1,4 @@',
      '+exports[`Card renders correctly 1`] = `',
      '+  padding: 16px;',
      '+`;',
      `diff --git a/${native} b/${native}`,
      `--- a/${native}`,
      `+++ b/${native}`,
      '@@ -1,1 +1,4 @@',
      '+exports[`Card renders correctly 1`] = `',
      '+  padding: 16px;',
      '+`;',
    ].join('\n');
    const model = buildChangeModel({ intent: 'update padding on both platforms', diff }, GRAPH);
    const findings = runDeterministicChecks(model, GRAPH).filter((f) => f.ruleId === 'REND-002');
    assert.equal(findings.length, 0);
  });

  test('REND-002 does not compare across platforms when only one side changed in this diff', () => {
    const web = 'packages/blade/src/components/Card/__tests__/__snapshots__/Card.web.test.tsx.snap';
    const diff = [
      `diff --git a/${web} b/${web}`,
      `--- a/${web}`,
      `+++ b/${web}`,
      '@@ -1,1 +1,4 @@',
      '+exports[`Card renders correctly 1`] = `',
      '+  padding: 16px;',
      '+`;',
    ].join('\n');
    const model = buildChangeModel({ intent: 'update web padding only', diff }, GRAPH);
    const findings = runDeterministicChecks(model, GRAPH).filter((f) => f.ruleId === 'REND-002');
    assert.equal(findings.length, 0);
  });
});

describe('deterministic-only mode surfaces warning-only findings', () => {
  test('a warning-only composition finding is cited and routed to needs_human, not silently dropped', async () => {
    const diff = [
      'diff --git a/packages/blade/src/components/Card/Preview.tsx b/packages/blade/src/components/Card/Preview.tsx',
      '--- a/packages/blade/src/components/Card/Preview.tsx',
      '+++ b/packages/blade/src/components/Card/Preview.tsx',
      '@@ -1,1 +1,3 @@',
      '+<div>',
      '+  <span>Total</span>',
      '+</div>',
    ].join('\n');
    const v = await review({ intent: 'add a total row', diff }, GRAPH, { deterministicOnly: true });
    assert.equal(v.status, 'needs_human');
    assert.ok(v.rulesCited.includes('COMP-001'), 'a warning-only rule must still be cited, not dropped');
  });
});
