# tests/ — integration-e2e (#29)

Cross-service疎通 / contract-conformance suite. Owns only `tests/` (design:
`設計_P0a/infra/integration-e2e.md`).

## Run

```
npx vitest run tests/          # this suite only
npx vitest run                 # whole monorepo (incl. this suite)
```

Registered via the root `vitest.config.ts` include + root `tsconfig.json` include.
Workspace registration in `pnpm-workspace.yaml` and the CI receptacle (schedule /
post-deploy hooks) are #27's frozen scope (design §8-5/-6) and intentionally not
touched here.

## Layout

- `lib/harness.ts` — wires the REAL Hono apps (api-gateway, auth-service,
  identity-roster, event-service) over their in-memory repos via fake Service
  Bindings. task / notification / audit-log / gantt / file-meta are faithful
  in-memory STUBs mounted at the gateway-forwarded path. Queue fan-out is
  simulated in-process (no miniflare Queue).
- `integration/flow.test.ts` — S1/S2/S3/S5/S7 happy paths.
- `integration/rbac.test.ts` — S6 negatives + authn edge.
- `integration/contract.test.ts` — C2/C3/C4/C6/C8.
- `integration/gaps.test.ts` — documented gateway↔service path mismatches + harness self-tests.

## Not covered here (by design / environment)

- Real-browser Playwright (design's preview-target layer) — needs the CF preview
  environment (§1 実行環境方針); this layer runs the same catalog at the gateway
  HTTP boundary in-process.
- miniflare D1 / real Queues — not installed; stubbed per the task's STUB/mock allowance.
