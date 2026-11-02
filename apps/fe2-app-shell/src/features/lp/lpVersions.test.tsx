// LP管理 → 版のカタログと公開版フラグ tests（一覧の画面は公開設定の「版の一覧」Drawer に移った: lpSiteConfig.test.tsx）。
import { describe, expect, it } from "vitest";
import { createApiClient } from "../../lib/api-client.tsx";
import { createDemoFetch } from "../../lib/demo-seed.tsx";
import { createLpApi, type LpPublishState } from "./lpApi.tsx";
import { lpViewUrl } from "./lpPublish.ts";

const PUBLISHABLE = ["v3.5", "v3.4", "v3.3", "v3.2", "v3.1", "v3.0", "v2.0"];

function state(versionId: string): LpPublishState {
  return { site: "hokuriku-it-conf.com", versionId, versions: PUBLISHABLE, updatedAt: null, updatedBy: null };
}

describe("lpViewUrl", () => {
  const publish = state("v3.4");
  it("previews publishable versions on the public site and uses ?version=live for the live one", () => {
    expect(lpViewUrl("v3.1", "https://old", publish, "https://lp.example")).toBe("https://lp.example/?version=3.1");
    expect(lpViewUrl("v3.4", "https://old", publish, "https://lp.example")).toBe("https://lp.example/?version=live");
    expect(lpViewUrl("v1.0", "https://old", publish, "https://lp.example")).toBe("https://old");
    expect(lpViewUrl("v3.1", "https://old", undefined)).toBe("https://old");
  });
});

describe("demo transport serves /lp/publish", () => {
  it("switches the live version and rejects unknown versions with 400", async () => {
    const api = createLpApi(createApiClient({ baseUrl: "https://demo.local", fetchImpl: createDemoFetch() }));
    expect((await api.getPublish()).versionId).toBe("v3.4");
    const next = await api.setPublish({ versionId: "v3.1" });
    expect(next.versionId).toBe("v3.1");
    expect(next.updatedAt).not.toBeNull();
    expect((await api.getPublish()).versionId).toBe("v3.1");
    await expect(api.setPublish({ versionId: "v1.0" })).rejects.toMatchObject({ status: 400 });
  });
});
