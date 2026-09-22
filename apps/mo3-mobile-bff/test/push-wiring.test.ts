// Guards the env -> push-adapter credential wiring (deps.ts). Regression for: buildDeps
// previously constructed the adapters with a bare boolean (config.pushConfigured), which
// carries NO credentials, so send() always returned "failed" even with the secrets set —
// no push ever went out. buildPushAdapters must thread the real credentials through.
import { describe, it, expect } from "vitest";
import type { Env } from "../src/env";
import { apnsCredentials, fcmOptions, buildPushAdapters } from "../src/deps";

const FCM_SA = { client_email: "svc@proj.iam.gserviceaccount.com", private_key: "PKEY", project_id: "proj_1" };

function env(over: Partial<Env>): Env {
  return { ENVIRONMENT: "production", ...over } as Env;
}

describe("fcmOptions (Android $0 wiring)", () => {
  it("parses FCM_SERVICE_ACCOUNT_JSON into a service account", () => {
    const out = fcmOptions(env({ FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(FCM_SA) }));
    expect(out.serviceAccount).toMatchObject({ client_email: FCM_SA.client_email, private_key: "PKEY" });
  });

  it("carries FCM_PROJECT_ID when present", () => {
    const out = fcmOptions(env({ FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(FCM_SA), FCM_PROJECT_ID: "proj_override" }));
    expect(out.projectId).toBe("proj_override");
  });

  it("returns null service account when the secret is absent", () => {
    expect(fcmOptions(env({})).serviceAccount).toBeNull();
  });

  it("returns null (never throws) for malformed JSON", () => {
    expect(fcmOptions(env({ FCM_SERVICE_ACCOUNT_JSON: "{ not json" })).serviceAccount).toBeNull();
  });

  it("rejects a JSON object missing required fields", () => {
    expect(fcmOptions(env({ FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ foo: "bar" }) })).serviceAccount).toBeNull();
  });
});

describe("apnsCredentials (iOS wiring)", () => {
  it("builds credentials only when the full p8 secret set is present", () => {
    const full = { APNS_KEY_P8: "p8", APNS_KEY_ID: "KID", APNS_TEAM_ID: "TEAM", APNS_BUNDLE_ID: "jp.devhub.app" };
    expect(apnsCredentials(env(full))).toEqual({ keyP8: "p8", keyId: "KID", teamId: "TEAM", bundleId: "jp.devhub.app" });
  });

  it("returns null when any part is missing", () => {
    expect(apnsCredentials(env({ APNS_KEY_P8: "p8", APNS_KEY_ID: "KID" }))).toBeNull();
    expect(apnsCredentials(env({}))).toBeNull();
  });
});

describe("buildPushAdapters", () => {
  it("returns an ios + android adapter regardless of secret presence", () => {
    const adapters = buildPushAdapters(env({}));
    expect(adapters.ios).toBeDefined();
    expect(adapters.android).toBeDefined();
  });
});
