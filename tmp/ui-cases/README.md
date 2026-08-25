# Sample UI review cases

This directory provides a self-contained pull request sample. Only changes
under `active/` trigger the sample workflow; `catalog/` contains copyable
scenarios and never runs by itself.

## Component scenarios

Copy one catalog file over the active component, commit it on a branch, and
open a pull request:

```bash
cp tmp/ui-cases/catalog/02-raw-ui-reuse.tsx \
  tmp/ui-cases/active/packages/blade/src/components/DemoUI/DemoUI.tsx
```

| Case | Expected result |
|---|---|
| `01-clean-composition.tsx` | No deterministic violation; offline mode defers safely |
| `02-raw-ui-reuse.tsx` | `COMP-001` plus the Layer 1B `COMP-003` reuse plan |
| `03-inline-style.tsx` | Blocking `COMP-002` finding |
| `04-nested-interactive.tsx` | Blocking `COMP-004` finding |
| `05-invalid-variant.tsx` | Blocking `COMP-005` finding |
| `06-partial-coverage.tsx` | Advisory reuse plan with `canvas` disclosed as unmapped |
| `07-conditional-variant.tsx` | Blocking `ENC-002` conditional-variant finding |
| `08-web-only-platform.tsx` | Blocking `CAS-004` when added as `DemoUI.web.tsx` without a native peer |

Restore the clean case by copying `01-clean-composition.tsx` back to the active
component.

For the source-parity case, add the catalog file as a web-specific implementation:

```bash
cp tmp/ui-cases/catalog/08-web-only-platform.tsx \
  tmp/ui-cases/active/packages/blade/src/components/DemoUI/DemoUI.web.tsx
```

That produces `CAS-004` because the component ships on web and native but the
pull request adds only the web implementation.

## Local preview of the exact PR diff

After changing an active case:

```bash
git diff --unified=80 -- tmp/ui-cases/active > /tmp/blade-review.patch

BLADE_REVIEW_PROVIDER=offline node --import tsx src/cli/ci.ts \
  --graph tmp/ui-cases/sample-graph.json \
  --diff /tmp/blade-review.patch \
  --intent "Review semantic UI structure" \
  --dry-run
```

The sample graph is intentionally small and deterministic. Production Blade PRs
must continue using graphs extracted from the real base and head commits.

## Sample pull-request CI

The repository-local workflow is `.github/workflows/sample-pr-review.yml`. It
runs only when a pull request changes `tmp/ui-cases/active/**`:

- A branch in this repository receives a real PR review and check run.
- A fork receives the same analysis in the Actions step summary because its
  token is read-only.
- Without an API key, deterministic checks still run locally and in CI.
- Advisory structure findings are neutral; proven blockers fail the job.

The existing `.github/workflows/ds-review.yml` remains the production template
for running against an actual Blade checkout with extracted base/head graphs.
