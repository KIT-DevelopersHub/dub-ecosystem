# Service Binding Name Registry

Single source of truth for cross-Worker **Service Binding** names in the Dub ecosystem.
Tracks infra issue #27 (deploy prerequisite: binding-name integrity).

## Why this exists

Cloudflare resolves a `[[services]]` binding at **deploy time** by matching its
`service = "<name>"` against the **physical `name`** of the target Worker
(the `name` field in that Worker's own `wrangler.toml`). If the reference and the
target's `name` differ by even a prefix, `wrangler deploy` fails to resolve the
binding. Previously the same logical service was referenced under three different
spellings (`identity-roster`, `identity-roster-service`, `dub-identity-roster`),
so deploys would break as soon as bindings were resolved.

## Naming convention (adopted)

> **The canonical Worker name is the `name` field in that Worker's own
> `wrangler.toml`. Every `[[services]].service` reference MUST equal that exact
> string.**

Physical names are intentionally left unchanged (they are the deployed identities,
and are assumed by parallel in-flight branches). Only the *references* were
normalized to match reality. Queue resource names (`dub-q-*`) already follow the
`dub-` account-namespacing convention and are unaffected by this change.

## Canonical Worker names

| Directory | Canonical Worker `name` | Binding var(s) used by callers |
|---|---|---|
| `services/api-gateway` | `dub-api-gateway` | (edge; not consumed internally) |
| `services/auth-service` | `auth-service` | `SVC_AUTH` |
| `services/identity-roster` | `identity-roster` | `SVC_IDENTITY` |
| `services/event-service` | `event-service` | `SVC_EVENT` |
| `services/task-service` | `task-service` | `SVC_TASK` |
| `services/gantt-service` | `gantt-service` | `SVC_GANTT` |
| `services/notification` | `notification` | `SVC_NOTIFICATION` |
| `services/chat-service` | `chat-service` | `SVC_CHAT` |
| `services/file-meta` | `dub-file-meta` | `SVC_FILE_META` |
| `services/drive-proxy` | `dub-drive-proxy` | `SVC_DRIVE_PROXY` |
| `services/mail-gateway` | `mail-gateway` | `SVC_MAIL_GATEWAY` |
| `services/mail-automation` | `dub-mail-automation` | (queue consumer) |
| `services/deploy-service` | `dub-deploy-service` | `SVC_DEPLOY` |
| `services/github-sync` | `dub-github-sync` | `SVC_GITHUB_SYNC` |
| `services/audit-log` | `audit-log` | `SVC_AUDIT_LOG` |
| `services/webhook-ingest` | `dub-webhook-ingest` | `SVC_WEBHOOK_INGEST` |
| `apps/mo3-mobile-bff` | `mo3-mobile-bff` | (push target) |

## Corrections applied (reference name -> canonical name)

| Old reference | Canonical (fixed) | Where it appeared |
|---|---|---|
| `dub-auth-service` | `auth-service` | api-gateway |
| `identity-roster-service` | `identity-roster` | gantt, chat, task, event, auth, mo3-mobile-bff |
| `dub-identity-roster` | `identity-roster` | api-gateway, deploy, mail-automation, github-sync, file-meta, webhook-ingest, drive-proxy |
| `dub-event-service` | `event-service` | api-gateway, mail-automation, github-sync |
| `dub-task-service` | `task-service` | api-gateway, github-sync |
| `dub-gantt-service` | `gantt-service` | api-gateway |
| `dub-notification-service` | `notification` | api-gateway |
| `notification-service` | `notification` | mo3-mobile-bff |
| `dub-chat-service` | `chat-service` | api-gateway |
| `dub-mail-gateway` | `mail-gateway` | api-gateway, mail-automation |
| `dub-audit-log` | `audit-log` | api-gateway, deploy |
| `file-meta-service` | `dub-file-meta` | chat-service |
| `mobile-bff` | `mo3-mobile-bff` | notification |

References that already matched (`dub-file-meta`, `dub-drive-proxy`,
`dub-deploy-service`, `dub-github-sync`, `dub-webhook-ingest`, and the bare names)
were left untouched.

## Placeholders (out of scope)

Resource IDs that still use `REPLACE_AT_APPLY` (D1 `database_id`, KV `id`, etc.)
are deliberately kept as placeholders and swapped in at apply time once D1
permissions land. This change only fixes **logical name resolution**, never IDs.

## Rule for future changes

When adding or renaming a Worker:
1. Set its `name` in its own `wrangler.toml`.
2. Update this table.
3. Ensure every caller's `[[services]].service` uses that exact `name`.

CI/deploy sanity check (every `service =` target must be some Worker's `name`):

```
names=$(for f in services/*/wrangler.toml apps/*/wrangler.toml; do \
  grep -m1 '^name' "$f" | sed 's/.*= *"//;s/".*//'; done | sort -u)
grep -rh '^service = ' services apps --include=wrangler.toml \
  | sed 's/.*= *"//;s/".*//' | sort -u \
  | while read r; do echo "$names" | grep -qx "$r" || echo "UNRESOLVED: $r"; done
```
