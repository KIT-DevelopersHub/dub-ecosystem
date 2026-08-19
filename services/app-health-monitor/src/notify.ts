// Admin alerting. When a target crosses the failure threshold we fire ONE in-app notification
// to admins/maintainers (recipientRoles fan-out — mirrors feedback / usage-meter; the roles are
// resolved to admin inboxes only, so members never see health noise). On recovery we fire a
// clear. Best-effort: every failure is swallowed + logged so alerting can never break the loop.
import { createServiceClient, newRequestId, type RequestContext } from "@dub/http";
import { consoleSink } from "@dub/observability";
import type { notification } from "@dub/types";
import { ADMIN_ROLE_IDS, HEALTH_NOTIFY_TYPE, SERVICE_NAME } from "./config";
import type { Env } from "./env";
import type { TargetResult } from "./types";

export interface Notifier {
  down(target: TargetResult, downSince: string): Promise<void>;
  recovery(target: TargetResult, downSince: string): Promise<void>;
}

function post(env: Env, req: notification.NotifyRequest): Promise<void> {
  if (!env.SVC_NOTIFICATION) {
    consoleSink({ level: "warn", message: "health alert skipped: SVC_NOTIFICATION unbound", service: SERVICE_NAME, fields: { type: req.type } });
    return Promise.resolve();
  }
  const ctx: RequestContext = { requestId: newRequestId() };
  const client = createServiceClient(env.SVC_NOTIFICATION, { service: "notification", caller: SERVICE_NAME });
  return client
    .post<{ notificationId: string; deduplicated: boolean }, notification.NotifyRequest>(ctx, "/notify", req)
    .then(() => undefined)
    .catch((err) => {
      consoleSink({
        level: "error",
        message: "health alert notify failed (best-effort)",
        service: SERVICE_NAME,
        fields: { type: req.type, dedupKey: req.dedupKey, error: err instanceof Error ? err.message : String(err) },
      });
    });
}

/** The real notifier (over SVC_NOTIFICATION). */
export function createNotifier(env: Env): Notifier {
  return {
    down(target, downSince) {
      const req: notification.NotifyRequest = {
        type: HEALTH_NOTIFY_TYPE,
        recipientIds: [],
        recipientRoles: [...ADMIN_ROLE_IDS],
        title: `⚠️ ${target.label} が開けない可能性があります`,
        body: [
          `死活監視が「${target.label}」の異常を検知しました。`,
          ``,
          `対象: ${target.id}`,
          `詳細: ${target.detail}`,
          `検知開始: ${downSince}`,
        ].join("\n"),
        channels: ["in_app"],
        // dedupKey pins one alert per down streak (downSince) => retries never double-notify.
        dedupKey: `health:down:${target.id}:${downSince}`,
        resourceType: "health",
        resourceId: target.id,
      };
      return post(env, req);
    },
    recovery(target, downSince) {
      const req: notification.NotifyRequest = {
        type: HEALTH_NOTIFY_TYPE,
        recipientIds: [],
        recipientRoles: [...ADMIN_ROLE_IDS],
        title: `✅ ${target.label} が復旧しました`,
        body: [`死活監視が「${target.label}」の復旧を確認しました。`, ``, `対象: ${target.id}`, `詳細: ${target.detail}`].join("\n"),
        channels: ["in_app"],
        dedupKey: `health:up:${target.id}:${downSince}`,
        resourceType: "health",
        resourceId: target.id,
      };
      return post(env, req);
    },
  };
}
