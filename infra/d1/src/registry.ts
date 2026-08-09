// Namespace registry — an EXTENSION of @dub/db's NAMESPACES (the single source of
// truth, 16 entries, theme-3 D11). We import the `Namespace` type and never re-declare
// the list; this table only annotates each namespace with its owner unit + frozen
// tables. A compile-time exhaustiveness check keeps this in lockstep with NAMESPACES.
import { NAMESPACES, type Namespace } from "@dub/db";

export interface NamespaceEntry {
  ns: Namespace;
  ownerUnit: string;
  tables: readonly string[];
  /** true = physical migration exists but is not part of the frozen lint/CI gate. */
  draft?: boolean;
}

export const NAMESPACE_REGISTRY: readonly NamespaceEntry[] = [
  { ns: "dub", ownerUnit: "@dub/db#22", tables: ["dub_migrations"] },
  {
    ns: "identity",
    ownerUnit: "identity-roster#3",
    tables: ["identity_orgs", "identity_users", "identity_roles", "identity_role_permissions", "identity_role_assignments"],
  },
  { ns: "event", ownerUnit: "event-service#4", tables: ["event_events", "event_actions"] },
  { ns: "task", ownerUnit: "task-service#5", tables: ["task_tasks", "task_dependencies", "task_idempotency"] },
  { ns: "gantt", ownerUnit: "gantt-service#6", tables: ["gantt_view_states"] },
  {
    ns: "notif",
    ownerUnit: "notification#8",
    tables: ["notif_notifications", "notif_inbox", "notif_preferences", "notif_deliveries", "notif_processed_events"],
  },
  {
    ns: "chat",
    ownerUnit: "chat-service#17",
    tables: ["chat_channels", "chat_channel_members", "chat_messages", "chat_reactions", "chat_read_states"],
    draft: true,
  },
  { ns: "mail", ownerUnit: "mail-gateway#15", tables: ["mail_send_log", "mail_inbound", "mail_mailboxes"] },
  {
    ns: "mailauto",
    ownerUnit: "mail-automation#16",
    tables: ["mailauto_rules", "mailauto_templates", "mailauto_decisions", "mailauto_thread_state", "mailauto_rate_counters", "mailauto_settings"],
  },
  { ns: "file_meta", ownerUnit: "file-meta#9", tables: ["file_meta_files", "file_meta_links", "file_meta_processed_events"] },
  { ns: "github", ownerUnit: "github-sync#12", tables: ["github_repos", "github_links", "github_sync_runs", "github_processed_events"] },
  { ns: "webhook", ownerUnit: "webhook-ingest#13", tables: ["webhook_deliveries"] },
  { ns: "deploy", ownerUnit: "deploy-service#14", tables: ["deploy_sites", "deploy_deployments", "deploy_allowed_zones", "deploy_dns_changes"] },
  { ns: "audit", ownerUnit: "audit-log#10", tables: ["audit_logs"] },
  { ns: "mobile", ownerUnit: "mobile-bff MO3#31", tables: ["mobile_devices"] },
  { ns: "seed", ownerUnit: "infra-d1-seed#28", tables: ["seed_runs"] },
];

// Compile-time guard: every NAMESPACES entry appears exactly once in the registry.
type RegisteredNs = (typeof NAMESPACE_REGISTRY)[number]["ns"];
type Missing = Exclude<Namespace, RegisteredNs>;
const _exhaustive: Missing extends never ? true : ["registry missing namespace(s)", Missing] = true;
void _exhaustive;

// Runtime guard (order + count vs the frozen list).
if (NAMESPACE_REGISTRY.length !== NAMESPACES.length) {
  throw new Error(`NAMESPACE_REGISTRY (${NAMESPACE_REGISTRY.length}) drifted from NAMESPACES (${NAMESPACES.length})`);
}

export function registryEntry(ns: Namespace): NamespaceEntry {
  const e = NAMESPACE_REGISTRY.find((r) => r.ns === ns);
  if (!e) throw new Error(`no registry entry for namespace "${ns}"`);
  return e;
}
