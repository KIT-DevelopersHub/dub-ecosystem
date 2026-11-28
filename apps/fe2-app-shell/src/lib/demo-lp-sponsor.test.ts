// LP管理 > スポンサー募集の通知設定: Dub 通知は固定（設定なし）・追加で送るメールだけ設定できる。
import { describe, it, expect } from "vitest";
import type { lpSponsor } from "@dub/types";
import { createDemoLpSponsorStore } from "./demo-lp-sponsor";

const URL_BASE = "https://demo.example";
const call = async <T>(store: ReturnType<typeof createDemoLpSponsorStore>, method: string, path: string, body?: unknown) => {
  const res = store.handle(method, path, new URL(path, URL_BASE), body)!;
  return { status: res.status, body: (await res.json()) as T };
};

describe("demo LP sponsor store (notify settings)", () => {
  it("has no chat channel setting; only the optional team email is saved", async () => {
    const store = createDemoLpSponsorStore("https://lp.example");
    const s0 = await call<lpSponsor.LpSponsorInquiriesState>(store, "GET", "/api/v1/lp/sponsor-inquiries");
    expect(s0.body).not.toHaveProperty("notifyChannelId");
    expect(s0.body.notifyEmail).toBeNull();

    const bad = await call(store, "POST", "/api/v1/lp/sponsor-inquiries/notify", { notifyEmail: "x" });
    expect(bad.status).toBe(400);
    const ok = await call<lpSponsor.LpSponsorInquiriesState>(store, "POST", "/api/v1/lp/sponsor-inquiries/notify", {
      notifyChannelId: "chn_ignored",
      notifyEmail: "team@example.jp",
    });
    expect(ok.body.notifyEmail).toBe("team@example.jp");
    expect(ok.body).not.toHaveProperty("notifyChannelId");
  });

  it("seeds notifiedVia with the Dub-notification vocabulary", async () => {
    const store = createDemoLpSponsorStore("https://lp.example");
    const page = await call<lpSponsor.LpSponsorInquiriesPage>(store, "GET", "/api/v1/lp/sponsor-inquiries/items");
    expect(page.body.items.every((i) => ["app", "mail", "both", "none"].includes(i.notifiedVia))).toBe(true);
  });
});
