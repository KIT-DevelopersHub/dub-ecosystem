// dub-file-meta Worker entry. Builds real deps (D1 repo + R2 blobs + event/audit
// Queues + identity authz + drive-proxy completion) from env, for both the HTTP
// fetch handler and the Queue consumer (EVT_FILE_META: drive.* + *.archived).
import type { D1Database, Queue, Fetcher, R2Bucket, MessageBatch } from "@cloudflare/workers-types";
import { createDbClient } from "@dub/db";
import {
  createEvent,
  publishEvent,
  publishAudit,
  type AuditRecordEnvelopeV1,
  type DubEventEnvelope,
} from "@dub/events";
import { createServiceClient, extractContext, newRequestId } from "@dub/http";
import { createAuthClient } from "@dub/auth-client";
import { common, type drive } from "@dub/types";
import { createApp } from "./app";
import { createConsumer } from "./consumer";
import { createD1FileRepo, createD1IdempotencyStore } from "./repo";
import type { AuthGate, BlobStore, DriveClient, EmitEvent } from "./deps";

export interface Env {
  DB: D1Database;
  R2_FILES: R2Bucket;
  AUDIT_QUEUE: Queue<AuditRecordEnvelopeV1>;
  SVC_IDENTITY: Fetcher;
  SVC_DRIVE_PROXY?: Fetcher;
}

function r2Blobs(bucket: R2Bucket): BlobStore {
  return {
    async put({ key, body, contentType }) {
      await bucket.put(key, body as ArrayBuffer, { httpMetadata: { contentType } });
    },
    async get(key) {
      const obj = await bucket.get(key);
      if (!obj) return null;
      return {
        body: await obj.arrayBuffer(),
        contentType: obj.httpMetadata?.contentType ?? "application/octet-stream",
        size: obj.size,
      };
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}

function driveClient(binding: Fetcher | undefined, requestId: string): DriveClient | undefined {
  if (!binding) return undefined;
  const client = createServiceClient(binding, { service: "drive-proxy", caller: "file-meta" });
  return {
    async getFile(driveFileId) {
      try {
        const f = await client.get<drive.DriveFile>({ requestId }, `/files/${driveFileId}`);
        return { name: f.name, mimeType: f.mimeType };
      } catch {
        return null;
      }
    },
  };
}

function emitter(env: Env): EmitEvent {
  return (name, payload, ctx) =>
    publishEvent(env as unknown as Record<string, Queue<DubEventEnvelope>>, createEvent(name, payload, ctx));
}

function authGate(env: Env): AuthGate {
  const ac = createAuthClient({ identityBinding: env.SVC_IDENTITY, serviceName: "file-meta" });
  return {
    requireAuth: () => ac.requireAuth(),
    requirePermission: (permission) => ac.requirePermission(permission, () => ({ orgId: common.DUB_DEFAULT_ORG_ID })),
    hasPermission: (userId, permission) => ac.hasPermission(userId, common.DUB_DEFAULT_ORG_ID, { permission }),
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const ctx = extractContext(request.headers, { allowGenerate: true });
    const db = createDbClient(env.DB, { namespace: "file_meta", requestId: ctx.requestId });
    const app = createApp({
      repo: createD1FileRepo(db),
      blobs: r2Blobs(env.R2_FILES),
      emit: emitter(env),
      audit: (input) => publishAudit(env, input),
      auth: authGate(env),
      ...(env.SVC_DRIVE_PROXY ? { drive: driveClient(env.SVC_DRIVE_PROXY, ctx.requestId)! } : {}),
    });
    return app.fetch(request, env);
  },

  async queue(batch: MessageBatch<DubEventEnvelope>, env: Env): Promise<void> {
    const requestId = newRequestId();
    const db = createDbClient(env.DB, { namespace: "file_meta", requestId });
    const consumer = createConsumer({
      repo: createD1FileRepo(db),
      emit: emitter(env),
      idempotency: createD1IdempotencyStore(db),
      ...(env.SVC_DRIVE_PROXY ? { drive: driveClient(env.SVC_DRIVE_PROXY, requestId)! } : {}),
    });
    await consumer(batch, env);
  },
};
