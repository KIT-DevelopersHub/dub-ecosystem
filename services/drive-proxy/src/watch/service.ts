// Watch/channel issuance orchestration (P1 Drive-watch). This is the ISSUING side of
// the google-drive channel token that webhook-ingest verifies: on create we call Drive
// files.watch with token = the shared secret (current slot) and address = webhook-ingest
// ingress, then persist the channel so it can be stopped/renewed and inbound
// notifications correlated. Rate-limited (watch/stop count against Google quota) and
// audited. The token itself is never returned to callers nor written to D1.
import { DubError, errors } from "@dub/errors";
import { newId, nowIso } from "@dub/db";
import type { GoogleDriveApi } from "../google/client";
import type { RateLimiter } from "../ratelimit";
import type { EventPublisher, PublishContext } from "../events";
import type { WatchChannelRepo, WatchTokenVersion } from "./repo";

export interface WatchTokens {
  current: string;
  next?: string;
}

export interface WatchConfig {
  callbackUrl: string; // webhook-ingest google-drive ingress (https)
  ttlSeconds: number; // requested channel TTL (Google caps to its own max)
}

export interface WatchServiceDeps {
  google: Pick<GoogleDriveApi, "watchFile" | "stopChannel">;
  repo: WatchChannelRepo;
  rate: RateLimiter;
  events: Pick<EventPublisher, "audit">;
  config: WatchConfig;
  tokens: WatchTokens;
  now?: () => number;
  genChannelId?: () => string;
}

/** Public projection of a created channel — the token is intentionally absent. */
export interface WatchChannelView {
  channelId: string;
  resourceId: string;
  fileId: string;
  expiration: string | null;
  resourceUri: string | null;
}

export interface StopResult {
  channelId: string;
  alreadyStopped: boolean;
}

function randomChannelId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return newId("chan"); // deterministic fallback (still unique, prefixed)
}

export function createWatchService(deps: WatchServiceDeps) {
  const { google, repo, rate, events, config, tokens } = deps;
  const now = deps.now ?? Date.now;
  const genChannelId = deps.genChannelId ?? randomChannelId;

  return {
    async create(
      ctx: PublishContext,
      args: { fileId: string; ttlSeconds?: number },
    ): Promise<WatchChannelView> {
      if (!args.fileId) {
        throw errors.validationFailed([{ field: "fileId", reason: "required" }]);
      }
      if (
        args.ttlSeconds !== undefined &&
        (!Number.isInteger(args.ttlSeconds) || args.ttlSeconds < 1)
      ) {
        throw errors.validationFailed([{ field: "ttlSeconds", reason: "out_of_range", message: ">=1" }]);
      }
      if (!tokens.current) {
        // Server misconfiguration: cannot issue a token webhook-ingest could verify.
        throw new DubError("DRIVE_WATCH_UNCONFIGURED", "drive watch channel token is not configured", {
          status: 500,
        });
      }
      if (!config.callbackUrl) {
        throw new DubError("DRIVE_WATCH_UNCONFIGURED", "drive watch callback url is not configured", {
          status: 500,
        });
      }

      const channelId = genChannelId();
      const ttl = args.ttlSeconds ?? config.ttlSeconds;
      const expirationMs = now() + ttl * 1000;

      await rate.acquire();
      const result = await google.watchFile({
        fileId: args.fileId,
        channelId,
        address: config.callbackUrl,
        token: tokens.current,
        expirationMs,
      });

      const ts = nowIso();
      const tokenVersion: WatchTokenVersion = "current";
      await repo.insert({
        id: newId("dwc"),
        channelId: result.channelId,
        resourceId: result.resourceId,
        fileId: args.fileId,
        tokenVersion,
        address: config.callbackUrl,
        expiration: result.expiration,
        status: "active",
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        createdAt: ts,
        updatedAt: ts,
      });

      await events.audit(ctx, "drive.watch.create", args.fileId, {
        channelId: result.channelId,
        resourceId: result.resourceId,
        expiration: result.expiration,
        tokenVersion,
      });

      return {
        channelId: result.channelId,
        resourceId: result.resourceId,
        fileId: args.fileId,
        expiration: result.expiration,
        resourceUri: result.resourceUri,
      };
    },

    async stop(ctx: PublishContext, channelId: string): Promise<StopResult> {
      if (!channelId) {
        throw errors.validationFailed([{ field: "channelId", reason: "required" }]);
      }
      const rec = await repo.getByChannelId(channelId);
      if (!rec) throw errors.notFound("watchChannel", channelId);
      if (rec.status === "stopped") {
        // Idempotent: no Google call, no re-audit.
        return { channelId, alreadyStopped: true };
      }

      await rate.acquire();
      await google.stopChannel(channelId, rec.resourceId);
      await repo.markStopped(channelId, nowIso());
      await events.audit(ctx, "drive.watch.stop", rec.fileId, {
        channelId,
        resourceId: rec.resourceId,
      });
      return { channelId, alreadyStopped: false };
    },
  };
}

export type WatchService = ReturnType<typeof createWatchService>;
