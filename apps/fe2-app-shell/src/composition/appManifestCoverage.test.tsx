// CI closed-loop: every ASSEMBLED launcher feature-module must be registered in the
// canonical app registry (@dub/types APP_MANIFEST), which in turn binds it to a real
// RBAC permission key. Adding a new app (a new FeatureModule id in
// assembleFeatureModules) WITHOUT registering it here — and thus without a per-app
// permission — turns this test red = un-mergeable. This is the enforcement that stops
// a new app from ever shipping ungoverned by RBAC (the historical 抜け漏れ).
import { describe, expect, it, vi } from "vitest";
import { appRegistry } from "@dub/types";
import type { ApiClient, RequestInput } from "../lib/api-client.tsx";
import { assembleFeatureModules } from "./featureModules.tsx";

/** Minimal ApiClient double: assembleFeatureModules only constructs objects. */
function fakeApi(): ApiClient {
  const request = vi.fn(<TRes,>(_input: RequestInput): Promise<TRes> => Promise.resolve(undefined as TRes));
  return { request } as unknown as ApiClient;
}

describe("launcher app set ↔ APP_MANIFEST coverage", () => {
  it("every assembled feature-module id is a registered canonical app", () => {
    const moduleIds = assembleFeatureModules(fakeApi()).map((m) => m.id);
    for (const id of moduleIds) {
      expect(
        appRegistry.isCanonicalAppId(id),
        `feature module '${id}' is not registered in @dub/types APP_MANIFEST — ` +
          `add it there (with its per-app RBAC permission key) so the app is governable by RBAC`,
      ).toBe(true);
    }
  });

  it("every registered app declares per-app RBAC permissions", () => {
    for (const id of assembleFeatureModules(fakeApi()).map((m) => m.id)) {
      const app = appRegistry.getApp(id);
      expect(app, `no APP_MANIFEST entry for assembled module '${id}'`).toBeDefined();
      expect(app!.permissions.length, `app '${id}' has no per-app permission`).toBeGreaterThanOrEqual(1);
    }
  });
});
