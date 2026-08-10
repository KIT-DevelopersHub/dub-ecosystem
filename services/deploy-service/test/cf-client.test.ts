import { describe, it, expect, vi, afterEach } from "vitest";
import { DubError, CommonErrorCodes, isDubError } from "@dub/errors";
import { mapPagesStage, createCfClient } from "../src/cf-client";
import type { CfClientConfig } from "../src/cf-client";

describe("mapPagesStage", () => {
  it("maps CF Pages stages onto the frozen DeploymentStatus enum", () => {
    expect(mapPagesStage("queued")).toBe("queued");
    expect(mapPagesStage("initialize")).toBe("queued");
    // CF's terminal success stage is "success" -> our enum has no "success", it is "live"
    expect(mapPagesStage("success")).toBe("live");
    expect(mapPagesStage("live")).toBe("live");
    expect(mapPagesStage("failure")).toBe("failed");
    expect(mapPagesStage("canceled")).toBe("failed");
    expect(mapPagesStage("build")).toBe("building");
    expect(mapPagesStage(undefined)).toBe("building");
  });
});

// The secret-wiring gate: a missing CF secret must surface as the contract's
// UPSTREAM_UNAVAILABLE (502) BEFORE any network call — a token-less request must
// never leave the process. We assert the guard fires without touching fetch.
describe("createCfClient secret-wiring gate", () => {
  const FULL: CfClientConfig = {
    accountId: "acct_1",
    tokenPages: "tok_pages",
    tokenDns: "tok_dns",
    tokenRead: "tok_read",
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function expectUpstream(err: unknown): void {
    expect(isDubError(err)).toBe(true);
    const e = err as DubError;
    expect(e.code).toBe(CommonErrorCodes.UPSTREAM_UNAVAILABLE);
    expect(e.status).toBe(502);
  }

  it("createPagesDeployment fails closed when the Pages token is missing (no fetch)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const cf = createCfClient({ ...FULL, tokenPages: "" });
    await cf
      .createPagesDeployment({ cfProjectName: "p", branch: "main", commitSha: null })
      .then(() => expect.fail("should have thrown"))
      .catch(expectUpstream);
    expect(spy).not.toHaveBeenCalled();
  });

  it("createPagesDeployment fails closed when the account id is missing (no fetch)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const cf = createCfClient({ ...FULL, accountId: "" });
    await cf
      .getPagesDeployment({ cfProjectName: "p", cfDeploymentId: "d" })
      .then(() => expect.fail("should have thrown"))
      .catch(expectUpstream);
    expect(spy).not.toHaveBeenCalled();
  });

  it("createDnsRecord fails closed when the DNS token is missing (no fetch)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const cf = createCfClient({ ...FULL, tokenDns: "" });
    await cf
      .createDnsRecord({ zone: "z", type: "CNAME", name: "www", content: "x.pages.dev" })
      .then(() => expect.fail("should have thrown"))
      .catch(expectUpstream);
    expect(spy).not.toHaveBeenCalled();
  });

  it("listZones fails closed when the read token is missing (no fetch)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const cf = createCfClient({ ...FULL, tokenRead: "" });
    await cf
      .listZones()
      .then(() => expect.fail("should have thrown"))
      .catch(expectUpstream);
    expect(spy).not.toHaveBeenCalled();
  });
});
