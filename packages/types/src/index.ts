// @dub/types — single source of truth for all inter-service HTTP contract types.
// Type-only package (no runtime beyond the declared-list constants). index.ts does
// namespace re-export only (flat export forbidden; avoids name collisions).
// 19 namespaces + common (D14).

export * as common from "./common";
export * as gateway from "./gateway"; // #1  api-gateway
export * as auth from "./auth"; // #2  auth-service
export * as identity from "./identity"; // #3  identity-roster (+PERMISSION_CATALOG)
export * as event from "./event"; // #4  event-service
export * as task from "./task"; // #5  task-service
export * as gantt from "./gantt"; // #6  gantt-service
export * as ganttCalc from "./gantt-calc"; // #7  gantt-calc
export * as notification from "./notification"; // #8  notification
export * as fileMeta from "./file-meta"; // #9  file-meta
export * as auditLog from "./audit-log"; // #10 audit-log (+SYNC_AUDIT_ACTIONS)
export * as drive from "./drive"; // #11 drive-proxy
export * as githubSync from "./github-sync"; // #12 github-sync
export * as webhook from "./webhook"; // #13 webhook-ingest (envelope contract)
export * as deploy from "./deploy"; // #14 deploy-service
export * as mail from "./mail"; // #15 mail-gateway (2-stage stub)
export * as mailAutomation from "./mail-automation"; // #16 mail-automation
export * as chat from "./chat"; // #17 chat-service (RT frozen, rest STUB)
export * as mobile from "./mobile"; // MO3 mobile-bff (D14)
export * as member from "./member"; // member-service (運営メンバー管理; canonical shared Team)

export const CONTRACT_VERSION = "1.0.0";
