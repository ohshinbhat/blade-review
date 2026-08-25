# Blade PR Review Agent

An architectural reviewer for Blade component and property PRs. It answers one question:

> Assuming the requirement is valid, has this been **built correctly**?

It does not judge whether a change belongs in Razorpay's design language. That stays human.

```
npm install
npm run extract -- --blade ../blade        # build the knowledge graph from Blade source
npm run review  -- "add a tertiary variant to Button with a green background #0A8000"
npm run eval                                # measure it
npm test                                    # 54 unit tests
```

Works with no API key: the judgment layer falls back to a deterministic provider that never
approves, so the whole pipeline runs offline. Layer 2 supports Anthropic directly and any
model available through OpenRouter.

```bash
# Anthropic (the existing default when this key is present)
ANTHROPIC_API_KEY=... npm run review -- "describe the change"

# OpenRouter
OPENROUTER_API_KEY=... \
BLADE_REVIEW_PROVIDER=openrouter \
BLADE_REVIEW_MODEL=openai/gpt-4o-mini \
npm run review -- "describe the change"
```

Provider configuration:

| Variable | Meaning |
|---|---|
| `BLADE_REVIEW_PROVIDER` | `offline`, `anthropic`, or `openrouter` |
| `BLADE_REVIEW_MODEL` | Provider-specific model id |
| `ANTHROPIC_API_KEY` | Anthropic API key; Anthropic remains the default when both provider keys exist |
| `OPENROUTER_API_KEY` | OpenRouter API key; auto-selects OpenRouter if no Anthropic key exists |
| `BLADE_REVIEW_BASE_URL` | Optional OpenRouter-compatible API base URL |
| `OPENROUTER_SITE_URL` | Optional OpenRouter attribution URL |
| `OPENROUTER_APP_NAME` | Optional OpenRouter attribution title |
| `EVAL_FALSE_APPROVE_BUDGET` | Maximum false approvals permitted by the eval gate; defaults to `0` |
| `EVAL_MIN_CORRECT_APPROVAL_RATE` | Minimum recall on expected-correct cases for a configured model; defaults to `0.50` |
| `EVAL_MIN_DECISION_COVERAGE` | Minimum non-deferred case coverage for a configured model; defaults to `0.75` |

---

## The reframe

One design-systems person cannot review PRs from 60+ designers. So they stop being the
reviewer and become the **author of a machine-enforceable rulebook**. Every verdict cites a
rule id; every rule cites where in the Blade repo it was agreed. Judgment becomes auditable
instead of tacit, and the reviewer's time compounds instead of evaporating.

## Architecture

```
Layer 0   EXTRACTION      Blade source/diff ──AST──▶ graph + JSX/snapshot facts
Layer 1A  DETERMINISTIC   tokens, APIs, cascade ──▶ proven findings     (free)
Layer 1B  UI STRUCTURE    JSX subtree ──▶ existing-component reuse plan (advisory)
Layer 2   JUDGMENT        residue ──▶ one structured LLM call           (~3k tokens)
Layer 3   ROUTING         pass │ fail+fix │ defer-to-human
```

**Layer 0** parses Blade with the TypeScript compiler API and emits a typed graph: every
token with its literal value, every component's prop unions, and the token→component edges
that make cascade analysis exact. Intent-time review uses the release graph. CI builds both
base-commit and PR-head graphs: prior-art checks use the base graph, while cascade and final-
state checks use the head graph, so a newly added variant is not mistaken for pre-existing code.

**Layer 1A** decides everything mechanically decidable — literal values, duplicate tokens,
naming hierarchy, cross-platform parity, existing variant axes, JSX composition, and resolved
snapshot output. Zero variance, zero model cost.

**Layer 1B** summarizes an entire added JSX subtree and asks the extracted component catalog
which raw elements already have Blade equivalents. A structure such as
`section > h3 + p + button` becomes the evidence-backed plan
`Box + Typography + Button`. It requires at least two mapped nodes and 60% primitive coverage,
reports anything unmapped, and stays a warning: structural coverage alone does not prove that
product behaviour is equivalent.

**Layer 2** sees only what Layer 1 could not decide, with a retrieved context bundle. It must
return structured output, and the validator rejects any rule id or component it invents.

**Layer 3** enforces the asymmetry that matters: a proven blocker cannot be approved away by
the model, and an under-confident approval becomes a deferral rather than an approval.

### Why this and not "prompt an LLM with the diff"

| | prompt-the-diff | this |
|---|---|---|
| Knowledge of Blade | frozen at training | re-extracted per release |
| Cascade claims | recalled, sometimes wrong | computed from the AST |
| Same PR twice | may differ | proven layer is identical |
| Audit trail | prose | rule ids with repo provenance |
| Cost per PR | whole-repo context | ~3k tokens |
| "How do you know it works?" | — | `npm run eval` |

## Five checks

| Check | Mechanism |
|---|---|
| **Correct encoding** | Literal hex/px matched against the token index; conditional-branch detection; naming hierarchy from the tokens RFC |
| **Correct cascading** | Token→component graph plus component/file-surface web/native parity. `border.radius.medium` resolves to its 57 real consumers, so a "just fix Card" change is shown to touch Button, Chip, Alert and 53 others |
| **Reuse over duplication** | Exact value match against base-commit tokens; proposed variants matched against base prop unions; new-component prop surfaces ranked against existing components for grounded REUSE-004 judgment |
| **Correct composition** | JSX tree read off the AST of diff-added lines only (contiguous added-line blocks, never stitched across unrelated hunks); raw intrinsics checked against a verified Blade-primitive mapping; whole subtrees summarized into existing-component reuse plans; inline `style`/`css` props, illegal nesting, and variant literals checked against extracted APIs |
| **Correct render output** | Already-diffed jest `.snap` files parsed for their fully-resolved CSS — no rendering, no Storybook. Resolved px values checked against the token scale; web/native snapshots of the same story compared for matching resolved values when both sides changed in the diff |

## Surfaces

Both are ~50-line adapters over one function, `review(change) → Verdict`. The engine is the
product; the form factor is a delivery detail.

- **CLI** — works *before* a PR exists. Catching a wrong approach at intent time is cheaper
  and less demoralising than rejecting it at review time.
- **CI** — `.github/workflows/ds-review.yml`. Verdicts post as PR reviews; fixes post as
  GitHub `suggestion` blocks so a designer applies the correct implementation in one click.
  A completed check run records `success`, `failure`, or `neutral`; deferrals also request the
  design-systems team and never look like a broken build.

### Repository-local UI demo

`tmp/ui-cases/` contains a clean active component, six component scenarios,
three rendered-snapshot fixtures, and a small committed demo graph. Copy a
catalog case over the active component and open a PR; the self-contained
`.github/workflows/ui-demo-review.yml` workflow runs this repository's agent,
posts a real review for same-repository branches, and falls back to an Actions
summary for forks. See `tmp/ui-cases/README.md` for the walkthrough.

## Measurement

`npm run eval` reports two arms side by side, so the model's contribution is a number rather
than a claim. Metrics are led by **false approve rate**, not accuracy: a false reject costs a
designer one round trip, a false approve corrupts the design system permanently and silently.

Cases come from hand-written goldens (including positive controls and deliberately ambiguous
cases) plus a **synthetic mutation generator** that corrupts real merged Blade source in ways
that map one-to-one onto rulebook violations — infinite labelled negatives at zero labelling
cost, with a distribution we control. Graph-derived positive controls prevent a reject-only
reviewer from hiding behind class imbalance. The report includes correct-approval recall and
automatic decision coverage; when a remote judgment provider is configured, both are gated.

The offline provider is a safety baseline, not an automatic approver. In the current 75-case
suite (58 original plus 17 composition/render cases) it proves 53 incorrect changes, defers all
16 correct controls and 6 ambiguous cases, and records zero false approvals or false rejections
— rule-citation accuracy and cascade recall are both 100%. Composition cases score 90.0%
accuracy and render cases 85.7%; every "failure" in both is the same documented pattern as the
original categories — the offline provider deferring a positive control to `needs_human` rather
than approving it outright, never a false approve. A configured model must approve at least
50% of correct controls and make an automatic decision on at least 75% of cases by default.
Override those thresholds with `EVAL_MIN_CORRECT_APPROVAL_RATE` and
`EVAL_MIN_DECISION_COVERAGE` when deliberately testing a different operating point.

## Layout

```
src/extract/      Layer 0 — AST → knowledge graph; jsx.ts (JSX composition extractor) and
                  snapshot.ts (jest .snap parser) feed the composition/render checks
src/knowledge/    rulebook (sourced from Blade RFCs) + retrieval
src/checks/       Layer 1A/1B — deterministic checks; composition.ts checks individual JSX,
                  structure.ts produces subtree reuse plans (COMP-003), and render.ts checks
                  resolved snapshots (REND-001, REND-002)
src/engine/       Layer 2/3 — prompt, providers, routing
src/cli/          CLI + CI entry points
src/ci/           GitHub review formatting
evals/            golden cases, mutation generator, metrics
```

## Notes

- Runtime dependency: `typescript` only. Anthropic and OpenRouter-compatible calls use plain
  `fetch`; a blocking CI check owns its timeout and bounded retry policy.
- `npm run typecheck` requires `@types/node` from a normal `npm install`.
- UI-structure reuse is semantic, not visual: it does not compare screenshots or decide whether
  a UI looks like Razorpay. Extraction is best-effort for complete contiguous JSX blocks added
  by the diff; incomplete prop-only hunks are deliberately left for human/model judgment.
