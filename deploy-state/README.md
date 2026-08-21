# deploy-state/ — "what is live right now" manifest

These JSON files record **what is currently deployed to each single shared slot** so an
overwrite is never silent and anyone can tell, at a glance, which SHA/feature a reviewer is
actually looking at.

| file | slot | written by |
|---|---|---|
| `demo.json`    | the `fe2-demo` Worker (backend-free mock SPA) | `scripts/deploy-demo.sh` |
| `staging.json` | the shared `-staging` Worker set               | `.github/workflows/staging.yml` (commented into the sticky PR comment; see note) |
| `prod.json`    | production                                     | `deploy.yml` on merge to `main`  |

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
