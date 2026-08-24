# Blade PR Review Agent

An architectural reviewer for Blade component and property PRs. It answers one question:

> Assuming the requirement is valid, has this been **built correctly**?

It does not judge whether a change belongs in Razorpay's design language. That stays human.

```
npm install
npm run extract -- --blade ../blade        # build the knowledge graph from Blade source
npm run review  -- "add a tertiary variant to Button with a green background #0A8000"
npm run eval                                # measure it
npm test                                    # 22 unit tests
```

Works with no API key: the judgment layer falls back to a deterministic provider that never
approves, so the whole pipeline runs offline. Set `ANTHROPIC_API_KEY` to enable Layer 2.

---

## The reframe

One design-systems person cannot review PRs from 60+ designers. So they stop being the
reviewer and become the **author of a machine-enforceable rulebook**. Every verdict cites a
rule id; every rule cites where in the Blade repo it was agreed. Judgment becomes auditable
instead of tacit, and the reviewer's time compounds instead of evaporating.

## Architecture

```
Layer 0   EXTRACTION      Blade source ──AST──▶ knowledge graph        (per release)
Layer 1   DETERMINISTIC   change ──▶ proven findings                   (~9ms, free)
Layer 2   JUDGMENT        residue ──▶ one structured LLM call          (~3k tokens)
Layer 3   ROUTING         pass │ fail+fix │ defer-to-human
```

**Layer 0** parses Blade with the TypeScript compiler API and emits a typed graph: every
token with its literal value, every component's prop unions, and the token→component edges
that make cascade analysis exact. Regenerated per Blade release, so the agent's knowledge is
never stale and no Blade fact is ever hand-written into a prompt.

**Layer 1** decides everything mechanically decidable — literal values, duplicate tokens,
naming hierarchy, cross-platform parity, existing variant axes. Zero variance, zero cost.

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

## Three checks

| Check | Mechanism |
|---|---|
| **Correct encoding** | Literal hex/px matched against the token index; conditional-branch detection; naming hierarchy from the tokens RFC |
| **Correct cascading** | Token→component graph. `border.radius.medium` resolves to its 57 real consumers, so a "just fix Card" change is shown to touch Button, Chip, Alert and 53 others |
| **Reuse over duplication** | Exact value match against every token; proposed variants matched against extracted prop unions |

## Surfaces

Both are ~50-line adapters over one function, `review(change) → Verdict`. The engine is the
product; the form factor is a delivery detail.

- **CLI** — works *before* a PR exists. Catching a wrong approach at intent time is cheaper
  and less demoralising than rejecting it at review time.
- **CI** — `.github/workflows/ds-review.yml`. Verdicts post as PR reviews; fixes post as
  GitHub `suggestion` blocks so a designer applies the correct implementation in one click.
  Deferrals are `neutral`, never `failure` — a deferral that looks like a broken build
  teaches people to ignore the check.

## Measurement

`npm run eval` reports two arms side by side, so the model's contribution is a number rather
than a claim. Metrics are led by **false approve rate**, not accuracy: a false reject costs a
designer one round trip, a false approve corrupts the design system permanently and silently.

Cases come from hand-written goldens (including positive controls and deliberately ambiguous
cases) plus a **synthetic mutation generator** that corrupts real merged Blade source in ways
that map one-to-one onto rulebook violations — infinite labelled negatives at zero labelling
cost, with a distribution we control.

## Layout

```
src/extract/      Layer 0 — AST → knowledge graph
src/knowledge/    rulebook (sourced from Blade RFCs) + retrieval
src/checks/       Layer 1 — change model + deterministic checks
src/engine/       Layer 2/3 — prompt, providers, routing
src/cli/          CLI + CI entry points
src/ci/           GitHub review formatting
evals/            golden cases, mutation generator, metrics
```

## Notes

- Runtime dependency: `typescript` only. The Anthropic call is plain `fetch`; a blocking CI
  check should own its timeout and retry policy rather than inherit them.
- `npm run typecheck` requires `@types/node` from a normal `npm install`.
