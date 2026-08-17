// Desktop ↔ web app-parity (roadmap P3). The Flutter desktop launcher must expose
// the SAME canonical app set as the web shell, so a feature added on the web can't
// silently be missing on desktop. The desktop registry is exported to
// apps/dt1-desktop/contract/desktop_apps.g.json (generated from the Dart
// kDesktopAppData via `dart run tool/gen_contract_json.dart`); this test reconciles
// it against the @dub/types `APP_MANIFEST` SoT.
//
// Adding an app to APP_MANIFEST (or the desktop dropping one) turns this red until
// the desktop registers it — at least as a `skeleton` placeholder. Desktop-only
// fields (icon, status) are not part of the contract and are ignored here.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { appRegistry } from "@dub/types";

type DesktopApp = {
  id: string;
  label: string;
  navPath: string;
  permission: string;
  status: "live" | "skeleton";
};

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const desktopApps: DesktopApp[] = JSON.parse(
  readFileSync(`${ROOT}apps/dt1-desktop/contract/desktop_apps.g.json`, "utf8"),
);

describe("desktop launcher parity with the web APP_MANIFEST", () => {
  const webById = new Map(appRegistry.APP_MANIFEST.map((a) => [a.id, a]));
  const desktopById = new Map(desktopApps.map((a) => [a.id, a]));

  it("covers every canonical web app id (no app is missing on desktop)", () => {
    const missing = appRegistry.APP_IDS.filter((id) => !desktopById.has(id));
    expect(missing, `desktop is missing web apps: ${missing.join(", ")}`).toEqual([]);
  });

  it("registers no app the web SoT does not define (no phantom desktop apps)", () => {
    const phantom = desktopApps.map((a) => a.id).filter((id) => !webById.has(id));
    expect(phantom, `desktop has apps not in APP_MANIFEST: ${phantom.join(", ")}`).toEqual([]);
  });

  it("keeps label / navPath / permission in lockstep with the SoT", () => {
    for (const d of desktopApps) {
      const web = webById.get(d.id);
      expect(web, `no web manifest entry for ${d.id}`).toBeTruthy();
      if (!web) continue;
      expect(d.label, `label drift for ${d.id}`).toBe(web.label);
      expect(d.navPath, `navPath drift for ${d.id}`).toBe(web.navPath);
      // The desktop names ONE governing permission; it must be one the web app declares.
      expect(web.permissions, `permission drift for ${d.id}`).toContain(d.permission);
    }
  });

  it("preserves launcher order", () => {
    expect(desktopApps.map((a) => a.id)).toEqual([...appRegistry.APP_IDS]);
  });
});
