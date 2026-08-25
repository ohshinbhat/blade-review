# UI review demo cases

This directory makes the review agent demonstrable inside its own repository.
Only changes under `active/` trigger the demo PR workflow; `catalog/` contains
copyable scenarios and never runs by itself.

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

Restore the clean case by copying `01-clean-composition.tsx` back to the active
component.

## Render scenarios

For an off-scale resolved value, copy the catalog snapshot into the mirrored
active component path:

```bash
mkdir -p tmp/ui-cases/active/packages/blade/src/components/DemoUI/__tests__/__snapshots__
cp tmp/ui-cases/catalog/07-off-scale-render.web.snap.txt \
  tmp/ui-cases/active/packages/blade/src/components/DemoUI/__tests__/__snapshots__/DemoUI.web.test.tsx.snap
```

That produces `REND-001`. To demonstrate `REND-002`, copy both case `08` files
to matching `DemoUI.web.test.tsx.snap` and `DemoUI.native.test.tsx.snap` names.

## Local preview of the exact PR diff

After changing an active case:

```bash
git diff --unified=80 -- tmp/ui-cases/active > /tmp/blade-ui-demo.patch

BLADE_REVIEW_PROVIDER=offline node --import tsx src/cli/ci.ts \
  --graph tmp/ui-cases/demo-graph.json \
  --diff /tmp/blade-ui-demo.patch \
  --intent "Demo semantic UI structure review" \
  --dry-run
```

The demo graph is intentionally small and deterministic. Production Blade PRs
must continue using graphs extracted from the real base and head commits.

## Pull-request CI demo

The repository-local workflow is `.github/workflows/ui-demo-review.yml`. It
runs only when a pull request changes `tmp/ui-cases/active/**`:

- A branch in this repository receives a real PR review and check run.
- A fork receives the same analysis in the Actions step summary because its
  token is read-only.
- Offline mode makes the demonstration deterministic and requires no secrets.
- Advisory structure findings are neutral; proven blockers fail the job.

The existing `.github/workflows/ds-review.yml` remains the production template
for running against an actual Blade checkout with extracted base/head graphs.
