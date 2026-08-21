# deploy-state/ — "what is live right now" manifest

These JSON files record **what is currently deployed to each single shared slot** so an
overwrite is never silent and anyone can tell, at a glance, which SHA/feature a reviewer is
actually looking at.

| file | slot | written by |
|---|---|---|
| `demo.json`    | the shared `fe2-demo` Worker (backend-free mock SPA) | `scripts/deploy-demo.sh` |
| `demo-<slug>.json` | a **disposable per-feature** demo Worker `dub-demo-<slug>` (backend-free mock SPA) | `scripts/deploy-demo-feature.sh` (removed by `scripts/teardown-demo.sh`) |
| `staging-queue.json` | the batch of **demo-approved features** waiting to be flushed to staging together | `scripts/staging-queue.sh` |
| `staging.json` | the shared `-staging` Worker set               | `.github/workflows/staging.yml` (commented into the sticky PR comment; see note) |
| `prod.json`    | production                                     | `deploy.yml` on merge to `main`  |

## Parallel-development flow (per-feature demos + staging queue)

For parallel work we avoid the single shared `fe2-demo` slot entirely: each feature gets its
OWN throwaway Worker so reviews never clobber each other.

1. `deploy-demo-feature.sh --slug <s> --markers ...` → deploys `dub-demo-<s>`, verifies live,
   writes `demo-<s>.json`, prints a shareable URL. **1 demo = 1 feature.**
2. review the URL → OK → `staging-queue.sh add <s> --branch <b> --markers ...` (records the
   approval into `staging-queue.json`).
3. `teardown-demo.sh <s>` deletes the throwaway Worker + its `demo-<s>.json` (frees the
   free-plan Worker slot — no orphans).
4. when a flush condition trips (≥5 queued / oldest ≥24h / manual flag), `staging-queue.sh flush`
   prints the integration-branch merge+deploy plan; staging then equals all demo-approved
   features (demo=staging parity). See [runbook 06](../docs/runbooks/06-parallel-demo-staging-flow.md).

`demo-<slug>.json` adds `kind: "demo-feature"`, `slug`, and `worker` on top of the fields below.

## Why this exists

demo and staging are each a **single slot**. Many agents deploy concurrently, so a later
`wrangler deploy` clobbers an earlier one while its author is still reviewing it — the
reviewer then confirms a stale/other state. The manifest makes the current occupant
explicit: before you deploy, read it to see whose review you are about to overwrite; after
you deploy, it names you as the new occupant plus the liveness result.

## Fields

| field | meaning |
|---|---|
| `env`         | `demo` \| `staging` \| `prod` |
| `url`         | the fe2 SPA origin actually served |
| `deployedSha` | git commit SHA of the deployed tree |
| `branch`      | branch/PR the deploy came from |
| `actor`       | who deployed (git user / CI actor) — the current slot occupant |
| `markers`     | feature-unique strings that `verify-live` asserted are in the served bundle |
| `live`        | result of the post-deploy `verify-live` run (`true` only if all markers present) |
| `verifiedAt`  | ISO-8601 timestamp of the liveness check |
| `updatedAt`   | ISO-8601 timestamp the manifest was written |
| `note`        | free-text (e.g. "seed", or what was overwritten) |

`live: true` is the contract for handing a URL to a human: **do not ask anyone to 確認して a
slot whose manifest is not `live: true` for the feature you built.**

> Note on staging: staging deploys run in CI (ephemeral runner), so `staging.json` is not
> auto-committed on every deploy. The staging workflow reports the same fields into the
> sticky PR comment (source of truth for a PR preview); this committed file is updated when
> a human/agent runs the staging liveness check locally and wants a durable record.
