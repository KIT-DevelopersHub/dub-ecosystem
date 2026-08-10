# ADR-0005: Single D1 (`dub-core`) with 16 logical namespaces

- Status: Accepted
- Date: 2026-08-10
- Deciders: DevHub (Dub) core
- Related: `@dub/db` (`packages/db/src/namespaces.ts`, D11), `infra-d1-seed` (#28)

## Context

The ecosystem is ~16 independently-owned services (identity, event, task, gantt, notif,
chat, mail, mailauto, file_meta, github, webhook, deploy, audit, mobile-bff, …). Each owns
its own data. The classic choice is **one database per service** vs. **one shared database
with logical separation**. Cloudflare D1 makes many small databases operationally heavy
(per-DB binding, migration, and provisioning), and cross-DB joins are impossible anyway, so
the cost/benefit differs from a traditional RDBMS-per-service.

## Decision

Use a **single D1 database `dub-core`** partitioned into **16 logical namespaces by
table-name prefix**. The namespace registry is the frozen source of truth in
`@dub/db` (`packages/db/src/namespaces.ts`, `NAMESPACES`, D11):

```
dub (meta/migration ledger), identity, event, task, gantt, notif, chat,
mail, mailauto, file_meta, github, webhook, deploy, audit, mobile, seed
```

Rules that enforce the logical boundary:

1. **Namespace = table-name prefix.** Every table a service owns is named `<ns>_*`
   (e.g. `chat_messages`, `mail_send_log`). Ownership is resolved by **longest-prefix match**
   (`namespaceOf`), so `file_meta_files` resolves to `file_meta`, not `file`.
2. **Namespace-scoped D1 client.** `@dub/db`'s `DbClient` is scoped to one namespace; a
   service only ever addresses its own tables through it.
3. **Lint-enforced isolation** (`packages/db/src/lint.ts`):
   - `namespace-violation` — a migration/query touching a table outside its declared
     namespace is a **hard error** (the `dub` meta ledger is the only exception).
   - `cross-namespace-fk` — a `FOREIGN KEY` referencing another namespace's table is a
     **hard error**. Cross-namespace references keep **ids as strings** and integrate via
     **API calls / events**, never via a DB-level FK or join.
4. **Physical migrations are aggregated** under `infra/d1/migrations/<ns>/…` and applied by
   `infra-d1-seed` (#28), which imports the `Namespace` type from `@dub/db` (no duplicate
   list). All migrations are **forward-only** with a migration ledger in the `dub` namespace.

## Consequences

- Positive: one database to provision, bind, back up, and migrate; no per-service DB sprawl
  on D1. Migrations and seed run in one place with one ledger.
- Positive: service boundaries are still enforced — statically (namespace-scoped client) and
  by lint (namespace-violation / cross-namespace-fk) — so "shared DB" does not become
  "shared schema free-for-all". Services stay integrable by API/events only.
- Positive: the string-id + API/event integration rule keeps services genuinely decoupled and
  makes a future physical split (moving a namespace to its own DB) mechanical.
- Negative: no cross-namespace transactions or joins — an operation spanning two namespaces
  must be composed at the application layer (API/event), with idempotency, not a single SQL
  transaction. This is a deliberate trade for service autonomy.
- Negative: a single D1 is a shared blast radius / scaling unit; if one namespace's load or
  size outgrows D1 limits, that namespace must be physically extracted (the lint rules and
  string-id discipline are what make that possible without app rewrites).
- **(要確認)** `chat` namespace DDL is "draft, frozen after 9-C"; `seed` (#28) and the
  `NAMESPACE_REGISTRY` extension in infra are not yet fully wired. The 16-entry list itself is
  frozen.

## Alternatives considered

| Option | Why not |
|---|---|
| One D1 database per service | Heavy on D1 (per-DB binding/migration/provisioning) with no cross-DB query benefit; premature for current scale. Namespaces keep the option open for later extraction. |
| Single DB, no namespace enforcement | "Shared DB" degrades into coupled schemas and ad-hoc cross-service joins. Lint + scoped client prevent this. |
| Cross-namespace foreign keys / joins | Couples services at the storage layer and blocks any future physical split; string-ids + API/events chosen instead. |
